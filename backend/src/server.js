import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import cors from "cors";
import express from "express";
import { createClient } from "redis";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 4000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const TRANSFER_TTL_SECONDS = 5 * 60;
const MAX_WS_PAYLOAD = 2 * 1024 * 1024;
const allowedSignalTypes = new Set([
  "offer",
  "answer",
  "candidate",
  "transfer-complete",
  "fallback-start",
  "manifest",
]);

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required");
}

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (error) => {
  console.error("Redis client error:", error);
});
await redis.connect();

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/transfers", async (_request, response, next) => {
  try {
    let transferId;
    let created = false;

    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      transferId = randomBytes(18).toString("base64url");
      created = await redis.set(
        `vaultshare:transfer:${transferId}`,
        JSON.stringify({ createdAt: Date.now() }),
        { EX: TRANSFER_TTL_SECONDS, NX: true },
      ) === "OK";
    }

    if (!created || !transferId) {
      throw new Error("Could not create a unique transfer ID");
    }

    response.status(201).json({
      transferId,
      expiresInSeconds: TRANSFER_TTL_SECONDS,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/transfers/:transferId", async (request, response, next) => {
  try {
    const exists = await redis.exists(
      `vaultshare:transfer:${request.params.transferId}`,
    );
    if (!exists) {
      response.status(404).json({ error: "Transfer link expired or not found" });
      return;
    }

    response.json({ transferId: request.params.transferId });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error("HTTP request failed:", error);
  response.status(500).json({ error: "The signaling service encountered an error" });
});

const server = createServer(app);
const webSocketServer = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_WS_PAYLOAD,
  perMessageDeflate: false,
});

const rooms = new Map();
const fallbackTransfers = new Set();
const roomExpiryTimers = new Map();

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function getOtherPeer(room, socket) {
  return [...room.values()].find((peer) => peer !== socket);
}

webSocketServer.on("connection", async (socket, request) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const transferId = url.searchParams.get("transferId");
  const role = url.searchParams.get("role");

  if (!transferId || !["sender", "receiver"].includes(role)) {
    socket.close(1008, "Invalid transfer or role");
    return;
  }

  try {
    const transferKey = `vaultshare:transfer:${transferId}`;
    const exists = await redis.exists(transferKey);
    if (!exists) {
      socket.close(1008, "Transfer link expired or not found");
      return;
    }

    const ttlMilliseconds = await redis.pTTL(transferKey);
    if (ttlMilliseconds <= 0) {
      socket.close(1008, "Transfer link expired or not found");
      return;
    }

    const room = rooms.get(transferId) ?? new Map();
    if (room.has(role)) {
      socket.close(1008, `A ${role} is already connected`);
      return;
    }

    if (!rooms.has(transferId)) {
      const expiryTimer = setTimeout(() => {
        const expiredRoom = rooms.get(transferId);
        rooms.delete(transferId);
        roomExpiryTimers.delete(transferId);
        fallbackTransfers.delete(transferId);
        for (const peer of expiredRoom?.values() ?? []) {
          peer.close(4000, "Transfer link expired");
        }
      }, ttlMilliseconds);
      expiryTimer.unref();
      roomExpiryTimers.set(transferId, expiryTimer);
    }
    room.set(role, socket);
    rooms.set(transferId, room);
    socket.transferId = transferId;
    socket.role = role;

    const otherPeer = getOtherPeer(room, socket);
    if (otherPeer) {
      sendJson(otherPeer, { type: "peer-joined", role });
      sendJson(socket, {
        type: "peer-joined",
        role: otherPeer.role,
      });
    }

    socket.on("message", (data, isBinary) => {
      const currentRoom = rooms.get(transferId);
      const peer = currentRoom ? getOtherPeer(currentRoom, socket) : undefined;
      if (!peer || peer.readyState !== WebSocket.OPEN) {
        return;
      }

      if (isBinary) {
        if (role === "sender" && fallbackTransfers.has(transferId)) {
          peer.send(data, { binary: true });
        }
        return;
      }

      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendJson(socket, { type: "error", message: "Invalid signaling message" });
        return;
      }

      if (!message || typeof message.type !== "string" || !allowedSignalTypes.has(message.type)) {
        sendJson(socket, { type: "error", message: "Unsupported signaling message" });
        return;
      }

      const permittedForRole =
        message.type === "candidate" ||
        (role === "sender" && ["offer", "fallback-start"].includes(message.type)) ||
        (role === "receiver" && ["answer", "transfer-complete"].includes(message.type)) ||
        (role === "sender" &&
          message.type === "manifest" &&
          fallbackTransfers.has(transferId));
      if (!permittedForRole) {
        sendJson(socket, { type: "error", message: "Signaling message is not allowed for this role" });
        return;
      }

      if (message.type === "fallback-start") {
        if (role !== "sender") {
          sendJson(socket, { type: "error", message: "Only the sender can start fallback" });
          return;
        }
        fallbackTransfers.add(transferId);
        sendJson(peer, { type: "fallback-start" });
        sendJson(socket, { type: "fallback-ready" });
        return;
      }

      sendJson(peer, message);
    });

    socket.on("close", () => {
      const currentRoom = rooms.get(transferId);
      currentRoom?.delete(role);
      if (currentRoom?.size === 0) {
        rooms.delete(transferId);
        fallbackTransfers.delete(transferId);
        clearTimeout(roomExpiryTimers.get(transferId));
        roomExpiryTimers.delete(transferId);
      }
    });

    socket.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  } catch (error) {
    console.error("Could not establish WebSocket session:", error);
    socket.close(1011, "Could not establish signaling session");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VaultShare signaling server listening on port ${PORT}`);
});

async function shutdown() {
  webSocketServer.close();
  server.close();
  await redis.quit();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
