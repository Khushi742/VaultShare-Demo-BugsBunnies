import { randomBytes } from "node:crypto";
import { createClient } from "redis";

const TRANSFER_TTL_SECONDS = 5 * 60;
const KEY_PREFIX = "vaultshare:transfer:";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required");
}

const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries) => {
      if (retries > 3) {
        return new Error("Redis connection failed after several attempts");
      }
      return Math.min(retries * 250, 1000);
    },
  },
});
let hasConnected = false;
redis.on("error", (error) => {
  if (hasConnected) {
    console.error("Redis client error:", error);
  }
});
try {
  await redis.connect();
  hasConnected = true;
} catch {
  console.error(
    "Could not connect to Redis. Start Redis and verify REDIS_URL in backend/.env.",
  );
  process.exit(1);
}

export async function createTransfer() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transferId = randomBytes(18).toString("base64url");
    const created = await redis.set(
      `${KEY_PREFIX}${transferId}`,
      JSON.stringify({ createdAt: Date.now() }),
      { EX: TRANSFER_TTL_SECONDS, NX: true },
    );
    if (created === "OK") {
      return { transferId, expiresInSeconds: TRANSFER_TTL_SECONDS };
    }
  }

  throw new Error("Could not create a unique transfer ID");
}

export async function transferExists(transferId) {
  return (await redis.exists(`${KEY_PREFIX}${transferId}`)) > 0;
}

export async function transferTtlMilliseconds(transferId) {
  return redis.pTTL(`${KEY_PREFIX}${transferId}`);
}

export async function closeTransferStore() {
  if (redis.isOpen) {
    await redis.quit();
  }
}
