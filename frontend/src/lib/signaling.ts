export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const SIGNALING_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL ?? "ws://localhost:4000/ws";

export function getShareBaseUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const value = configuredUrl || window.location.origin;
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Set NEXT_PUBLIC_APP_URL to your public website URL.");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    throw new Error(
      "Share links need a public website URL. Set NEXT_PUBLIC_APP_URL to your deployed frontend URL.",
    );
  }

  return url.origin;
}

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
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/transfers`, { method: "POST" });
  } catch {
    throw new Error(
      `Cannot reach the VaultShare backend at ${API_URL}. Start the backend and Redis, or set NEXT_PUBLIC_API_URL to your deployed backend.`,
    );
  }
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
  let response: Response;
  try {
    response = await fetch(
      `${API_URL}/api/transfers/${encodeURIComponent(transferId)}`,
    );
  } catch {
    throw new Error(
      `Cannot reach the VaultShare backend at ${API_URL}. Check that the backend and Redis are running.`,
    );
  }
  if (!response.ok) {
    const result = (await response.json()) as { error?: string };
    throw new Error(result.error ?? "This transfer link has expired");
  }
}
