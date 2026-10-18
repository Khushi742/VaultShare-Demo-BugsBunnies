"use client";

import { useRef, useState } from "react";
import { createTransferKey, encryptFile } from "@/lib/crypto";
import {
  createSignalingSocket,
  createTransfer,
  getShareBaseUrl,
  isLocalOnlyShareUrl,
} from "@/lib/signaling";

type Phase = "idle" | "encrypting" | "waiting" | "transferring" | "complete" | "error";

const MAX_FILE_SIZE = 1024 * 1024 * 1024;

export default function UploadPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const transferStartedRef = useRef(false);
  const fallbackRequestedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [link, setLink] = useState("");
  const [localOnlyLink, setLocalOnlyLink] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [dragging, setDragging] = useState(false);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  }

  function sendSignal(message: Record<string, unknown>) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling connection was lost");
    }
    socket.send(JSON.stringify(message));
  }

  async function sendEncryptedFile(
    chunks: ArrayBuffer[],
    details: { name: string; type: string; size: number },
    transport: "webrtc" | "websocket",
  ) {
    if (transferStartedRef.current) return;
    transferStartedRef.current = true;
    setPhase("transferring");

    const manifest = JSON.stringify({
      type: "manifest",
      name: details.name,
      mimeType: details.type || "application/octet-stream",
      size: details.size,
      chunkCount: chunks.length,
    });

    if (transport === "webrtc") {
      setProgress(0);
      const channel = channelRef.current;
      if (!channel || channel.readyState !== "open") {
        transferStartedRef.current = false;
        return;
      }
      channel.send(manifest);
      for (let index = 0; index < chunks.length; index += 1) {
        while (channel.bufferedAmount > 256 * 1024) {
          await new Promise((resolve) => window.setTimeout(resolve, 20));
          if (channel.readyState !== "open") {
            throw new Error("Peer-to-peer connection closed during transfer");
          }
        }
        channel.send(chunks[index]);
        setProgress(Math.round(((index + 1) / chunks.length) * 100));
      }
      return;
    }

    setProgress(0);
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Fallback connection is unavailable");
    }
    socket.send(manifest);
    for (let index = 0; index < chunks.length; index += 1) {
      while (socket.bufferedAmount > 256 * 1024) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("Fallback connection closed during transfer");
        }
      }
      socket.send(chunks[index]);
      setProgress(Math.round(((index + 1) / chunks.length) * 100));
    }
  }

  function requestFallback(
    chunks: ArrayBuffer[],
    details: { name: string; type: string; size: number },
  ) {
    if (fallbackRequestedRef.current || transferStartedRef.current) return;
    fallbackRequestedRef.current = true;
    try {
      sendSignal({ type: "fallback-start" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start fallback");
      setPhase("error");
      return;
    }
    const socket = socketRef.current;
    if (!socket) return;
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let message: { type?: string };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        setError("Received invalid signaling data");
        setPhase("error");
        return;
      }
      if (message.type === "fallback-ready") {
        socket.removeEventListener("message", handleMessage);
        void sendEncryptedFile(chunks, details, "websocket").catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "File transfer failed");
          setPhase("error");
        });
      }
    };
    socket.addEventListener("message", handleMessage);
  }

  async function handleFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      setError("Choose a file smaller than 1 GB.");
      setPhase("error");
      return;
    }
    if (file.size === 0) {
      setError("Empty files are not supported.");
      setPhase("error");
      return;
    }

    socketRef.current?.close();
    peerRef.current?.close();
    socketRef.current = null;
    peerRef.current = null;
    channelRef.current = null;
    transferStartedRef.current = false;
    fallbackRequestedRef.current = false;
    setFileName(file.name);
    setProgress(0);
    setError("");
    setLink("");
    setPhase("encrypting");

    try {
      const shareBaseUrl = getShareBaseUrl();
      const { key, encodedKey } = await createTransferKey();
      const encryptedChunks = await encryptFile(file, key, setProgress);
      showToast("Encrypted!");
      const { transferId, expiresInSeconds } = await createTransfer();
      const generatedUrl = new URL(`/receive/${transferId}`, shareBaseUrl);
      generatedUrl.hash = new URLSearchParams({ key: encodedKey }).toString();
      const generatedLink = generatedUrl.toString();
      const socket = createSignalingSocket(transferId, "sender");
      socketRef.current = socket;

      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peerRef.current = peer;
      const channel = peer.createDataChannel("vaultshare-file", { ordered: true });
      channel.binaryType = "arraybuffer";
      channelRef.current = channel;
      const details = { name: file.name, type: file.type, size: file.size };
      const pendingCandidates: RTCIceCandidateInit[] = [];
      let remoteDescriptionReady = false;
      let fallbackTimerStarted = false;

      channel.onopen = () => {
        if (fallbackRequestedRef.current) return;
        void sendEncryptedFile(encryptedChunks, details, "webrtc").catch((cause: unknown) => {
          if (!fallbackRequestedRef.current) {
            transferStartedRef.current = false;
            requestFallback(encryptedChunks, details);
          } else {
            setError(cause instanceof Error ? cause.message : "File transfer failed");
            setPhase("error");
          }
        });
      };
      peer.onicecandidate = (event) => {
        if (event.candidate && socket.readyState === WebSocket.OPEN) {
          sendSignal({ type: "candidate", candidate: event.candidate });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          requestFallback(encryptedChunks, details);
        }
      };

      socket.addEventListener("message", (event: MessageEvent<string>) => {
        if (typeof event.data !== "string") return;
        let message: {
          type?: string;
          role?: string;
          candidate?: RTCIceCandidateInit;
          answer?: RTCSessionDescriptionInit;
          message?: string;
        };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          setError("Received invalid signaling data");
          setPhase("error");
          return;
        }
        if (message.type === "peer-joined" && message.role === "receiver") {
          if (!fallbackTimerStarted) {
            fallbackTimerStarted = true;
            window.setTimeout(() => requestFallback(encryptedChunks, details), 12_000);
          }
          void peer.createOffer()
            .then((offer) => peer.setLocalDescription(offer))
            .then(() => sendSignal({ type: "offer", offer: peer.localDescription }))
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Could not start peer connection");
              setPhase("error");
            });
        } else if (message.type === "answer" && message.answer) {
          void peer.setRemoteDescription(message.answer)
            .then(async () => {
              remoteDescriptionReady = true;
              while (pendingCandidates.length > 0) {
                await peer.addIceCandidate(pendingCandidates.shift()!);
              }
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Could not apply peer answer");
              setPhase("error");
            });
        } else if (message.type === "candidate" && message.candidate) {
          if (remoteDescriptionReady) {
            void peer.addIceCandidate(message.candidate).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Could not add peer candidate");
              setPhase("error");
            });
          } else {
            pendingCandidates.push(message.candidate);
          }
        } else if (message.type === "transfer-complete") {
          setProgress(100);
          setPhase("complete");
        } else if (message.type === "error") {
          setError(String(message.message ?? "Signaling failed"));
          setPhase("error");
        }
      });
      socket.onerror = () => {
        setError("Could not connect to the signaling server");
        setPhase("error");
      };
      socket.onclose = (event) => {
        if (!transferStartedRef.current && event.code !== 1000) {
          setError(event.reason || "Signaling connection closed");
          setPhase("error");
        }
      };

      setLink(generatedLink);
      setLocalOnlyLink(isLocalOnlyShareUrl(shareBaseUrl));
      setExpiresAt(new Date(Date.now() + expiresInSeconds * 1000).toLocaleTimeString());
      setPhase("waiting");
      try {
        await navigator.clipboard.writeText(generatedLink);
        showToast("Copied!");
      } catch {
        showToast("Link created — copy it below.");
      }
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.addEventListener("error", () => reject(new Error("Could not connect to the signaling server")), { once: true });
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare this file");
      setPhase("error");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      showToast("Copied!");
    } catch {
      setError("Clipboard access failed. Select and copy the link manually.");
    }
  }

  function reset() {
    socketRef.current?.close();
    peerRef.current?.close();
    socketRef.current = null;
    peerRef.current = null;
    channelRef.current = null;
    transferStartedRef.current = false;
    fallbackRequestedRef.current = false;
    setPhase("idle");
    setProgress(0);
    setFileName("");
    setLink("");
    setLocalOnlyLink(false);
    setError("");
    setToast("");
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-[#10141e]/90 p-5 shadow-2xl shadow-black/30 sm:p-8">
      {toast && (
        <div
          className="fixed left-1/2 top-5 z-50 -translate-x-1/2 rounded-xl border border-emerald-400/30 bg-[#10141e] px-5 py-3 text-sm font-medium text-emerald-200 shadow-xl"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}
      {phase === "idle" || phase === "error" ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
          className={`flex min-h-60 w-full flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition ${
            dragging
              ? "border-violet-300 bg-violet-500/10"
              : "border-white/15 bg-white/[0.02] hover:border-violet-400/60 hover:bg-violet-500/[0.04]"
          }`}
        >
          <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-violet-500/15 text-2xl text-violet-300">
            ↑
          </span>
          <span className="font-medium">Drop a file here or browse</span>
          <span className="mt-2 text-sm text-zinc-500">Up to 1 GB · Encrypted in your browser</span>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
        </button>
      ) : (
        <div className="space-y-6">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-xl text-violet-300">
              {phase === "complete" ? "✓" : "↗"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{fileName}</p>
              <p className="mt-1 text-sm text-zinc-400">
                {phase === "encrypting" && "Encrypting file"}
                {phase === "waiting" && "Link generated · Waiting for recipient"}
                {phase === "transferring" && "Transfer in progress"}
                {phase === "complete" && "Transfer complete"}
              </p>
            </div>
            <span className="text-sm tabular-nums text-zinc-400">{progress}%</span>
          </div>

          <div
            className="h-2 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-violet-400 transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>

          {link && (
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="mb-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
                Temporary link · Expires at {expiresAt}
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={link}
                  aria-label="Temporary share link"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-300 outline-none"
                />
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-400"
                >
                  Copy
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-amber-200/75">
                The link includes the decryption key. Share it only with your recipient.
              </p>
              {localOnlyLink && (
                <p className="mt-2 text-xs leading-5 text-amber-200/75" role="note">
                  Local-only link: it works on this computer, not on another device.
                  For cross-device sharing, use a reachable frontend URL and configure
                  the API and signaling URLs.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
          {phase === "complete" && (
            <button
              type="button"
              onClick={reset}
              className="w-full rounded-xl border border-white/10 py-3 text-sm text-zinc-300 hover:bg-white/5"
            >
              Send another file
            </button>
          )}
        </div>
      )}
      {phase === "error" && error && (
        <p className="mt-4 text-sm text-red-300" role="alert">{error}</p>
      )}
    </div>
  );
}
