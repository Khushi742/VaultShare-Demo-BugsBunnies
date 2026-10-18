"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  decryptChunk,
  ENCRYPTION_CHUNK_SIZE,
  importTransferKey,
} from "@/lib/crypto";
import { createSignalingSocket, verifyTransfer } from "@/lib/signaling";

type Phase = "connecting" | "waiting" | "transferring" | "complete" | "error";

const MAX_FILE_SIZE = 1024 * 1024 * 1024;

type Manifest = {
  type: "manifest";
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
};

export default function ReceiverPanel({ transferId }: { transferId: string }) {
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const manifestRef = useRef<Manifest | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedCountRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const completedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let peer: RTCPeerConnection | null = null;
    const pendingCandidates: RTCIceCandidateInit[] = [];
    let remoteDescriptionReady = false;

    function handleData(data: string | ArrayBuffer | Blob) {
      queueRef.current = queueRef.current
        .then(async () => {
          if (typeof data === "string") {
            const message = JSON.parse(data) as Partial<Manifest>;
            if (
              message.type !== "manifest" ||
              typeof message.name !== "string" ||
              message.name.length === 0 ||
              message.name.length > 1024 ||
              typeof message.mimeType !== "string" ||
              message.mimeType.length === 0 ||
              message.mimeType.length > 255
            ) {
              throw new Error("Received invalid file information");
            }
            if (
              typeof message.size !== "number" ||
              typeof message.chunkCount !== "number" ||
              !Number.isSafeInteger(message.size) ||
              !Number.isSafeInteger(message.chunkCount) ||
              message.size <= 0 ||
              message.size > MAX_FILE_SIZE ||
              message.chunkCount !== Math.ceil(message.size / ENCRYPTION_CHUNK_SIZE)
            ) {
              throw new Error("Received invalid file size");
            }
            manifestRef.current = message as Manifest;
            chunksRef.current = [];
            receivedCountRef.current = 0;
            completedRef.current = false;
            setFileName(message.name);
            setProgress(0);
            setPhase("transferring");
            return;
          }

          const manifest = manifestRef.current;
          const key = keyRef.current;
          if (completedRef.current) return;
          if (!manifest || !key) {
            throw new Error("Encrypted data arrived before file information");
          }
          const packet = data instanceof Blob ? await data.arrayBuffer() : data;
          const { index, plaintext } = await decryptChunk(packet, key);
          if (index >= manifest.chunkCount) {
            throw new Error("Received an out-of-range file chunk");
          }
          if (chunksRef.current[index] === undefined) {
            chunksRef.current[index] = plaintext;
            receivedCountRef.current += 1;
          }
          setProgress(Math.round((receivedCountRef.current / manifest.chunkCount) * 100));

          if (receivedCountRef.current === manifest.chunkCount) {
            const output = new Blob(chunksRef.current, { type: manifest.mimeType });
            if (output.size !== manifest.size) {
              throw new Error("The decrypted file size does not match the original");
            }
            const downloadUrl = URL.createObjectURL(output);
            const anchor = document.createElement("a");
            anchor.href = downloadUrl;
            anchor.download = manifest.name;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
            completedRef.current = true;
            setProgress(100);
            setPhase("complete");
            socketRef.current?.send(JSON.stringify({ type: "transfer-complete" }));
          }
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : "Could not decrypt the file");
          setPhase("error");
        });
    }

    async function connect() {
      try {
        const keyValue = new URLSearchParams(window.location.hash.slice(1)).get("key");
        if (!keyValue) {
          throw new Error("The decryption key is missing from this link");
        }
        keyRef.current = await importTransferKey(keyValue);
        await verifyTransfer(transferId);
        if (!active) return;

        peer = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        peerRef.current = peer;
        peer.ondatachannel = (event) => {
          const channel = event.channel;
          channel.binaryType = "arraybuffer";
          channel.onmessage = (messageEvent) => {
            handleData(messageEvent.data as string | ArrayBuffer | Blob);
          };
        };
        peer.onicecandidate = (event) => {
          if (event.candidate && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "candidate", candidate: event.candidate }));
          }
        };

        socket = createSignalingSocket(transferId, "receiver");
        socketRef.current = socket;
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          if (active) setPhase("waiting");
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") {
            handleData(event.data as ArrayBuffer | Blob);
            return;
          }

          let message: {
            type?: string;
            offer?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
            message?: string;
          };
          try {
            message = JSON.parse(event.data) as typeof message;
          } catch {
            setError("Received invalid signaling data");
            setPhase("error");
            return;
          }
          if (message.type === "manifest") {
            handleData(event.data);
            return;
          }
          if (message.type === "offer" && message.offer) {
            void peer?.setRemoteDescription(message.offer)
              .then(async () => {
                remoteDescriptionReady = true;
                while (pendingCandidates.length > 0) {
                  await peer?.addIceCandidate(pendingCandidates.shift()!);
                }
                return peer?.createAnswer();
              })
              .then((answer) => answer && peer?.setLocalDescription(answer))
              .then(() => {
                if (peer?.localDescription && socket?.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: "answer", answer: peer.localDescription }));
                }
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not answer peer connection");
                setPhase("error");
              });
          } else if (message.type === "candidate" && message.candidate) {
            if (remoteDescriptionReady) {
              void peer?.addIceCandidate(message.candidate).catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not add peer candidate");
                setPhase("error");
              });
            } else {
              pendingCandidates.push(message.candidate);
            }
          } else if (message.type === "fallback-start") {
            setPhase("transferring");
          } else if (message.type === "error") {
            setError(message.message ?? "Signaling failed");
            setPhase("error");
          }
        };
        socket.onerror = () => {
          if (active) {
            setError("Could not connect to the signaling server");
            setPhase("error");
          }
        };
        socket.onclose = (event) => {
          if (active && !completedRef.current && event.code !== 1000) {
            setError(event.reason || "Signaling connection closed");
            setPhase("error");
          }
        };
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not open this transfer");
        setPhase("error");
      }
    }

    void connect();
    return () => {
      active = false;
      socket?.close();
      peer?.close();
      socketRef.current = null;
      peerRef.current = null;
    };
  }, [transferId]);

  const phaseLabel = {
    connecting: "Checking your secure link",
    waiting: "Connected · Waiting for sender",
    transferring: "Receiving and decrypting file",
    complete: "Transfer complete",
    error: "Unable to receive file",
  }[phase];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/" className="flex w-fit items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-violet-500/15 text-xl text-violet-300">
          ◈
        </div>
        <span className="text-lg font-semibold">VaultShare</span>
      </Link>
      <section className="mx-auto my-auto w-full max-w-xl rounded-3xl border border-white/10 bg-[#10141e]/90 p-6 shadow-2xl shadow-black/30 sm:p-9">
        <p className="text-sm font-medium tracking-[0.2em] text-violet-300 uppercase">
          Secure transfer
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          {phase === "complete" ? "Your file is ready." : "A file is on its way."}
        </h1>
        <p className="mt-2 text-sm text-zinc-400">{phaseLabel}</p>

        {fileName && (
          <div className="mt-8 rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="truncate font-medium">{fileName}</p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-violet-400 transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-2 text-right text-xs text-zinc-500">{progress}%</p>
          </div>
        )}

        {error && (
          <p className="mt-6 rounded-xl border border-red-400/20 bg-red-500/5 p-4 text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
        <p className="mt-8 text-xs leading-5 text-zinc-500">
          The file is decrypted only in this browser. VaultShare servers never receive the
          encryption key or store the file.
        </p>
      </section>
    </main>
  );
}
