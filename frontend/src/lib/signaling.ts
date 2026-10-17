export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const SIGNALING_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL ?? "ws://localhost:4000/ws";

export type SignalMessage = {
  type: string;
  [key: string]: unknown;
};

export function createSignalingSocket(
  transferId: string,
  role: "sender" | "receiver",
): WebSocket {
  const url = new URL(SIGNALING_URL);
  url.searchParams.set("transferId", transferId);
  url.searchParams.set("role", role);
  return new WebSocket(url);
}

export async function createTransfer(): Promise<{
  transferId: string;
  expiresInSeconds: number;
}> {
  const response = await fetch(`${API_URL}/api/transfers`, { method: "POST" });
  const result = (await response.json()) as {
    transferId?: string;
    expiresInSeconds?: number;
    error?: string;
  };
  if (!response.ok || !result.transferId || !result.expiresInSeconds) {
    throw new Error(result.error ?? "Could not create a temporary transfer link");
  }
  return {
    transferId: result.transferId,
    expiresInSeconds: result.expiresInSeconds,
  };
}

export async function verifyTransfer(transferId: string): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/transfers/${encodeURIComponent(transferId)}`,
  );
  if (!response.ok) {
    const result = (await response.json()) as { error?: string };
    throw new Error(result.error ?? "This transfer link has expired");
  }
}
