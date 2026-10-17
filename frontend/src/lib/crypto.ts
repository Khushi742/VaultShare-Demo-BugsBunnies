export const ENCRYPTION_CHUNK_SIZE = 32 * 1024;
const IV_LENGTH = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createTransferKey(): Promise<{
  key: CryptoKey;
  encodedKey: string;
}> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const rawKey = await crypto.subtle.exportKey("raw", key);
  return { key, encodedKey: toBase64Url(new Uint8Array(rawKey)) };
}

export async function importTransferKey(encodedKey: string): Promise<CryptoKey> {
  const rawKey = new Uint8Array(fromBase64Url(encodedKey));
  if (rawKey.byteLength !== 32) {
    throw new Error("This transfer link contains an invalid encryption key");
  }
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
}

export async function encryptFile(
  file: File,
  key: CryptoKey,
  onProgress: (percentage: number) => void,
): Promise<ArrayBuffer[]> {
  const encryptedChunks: ArrayBuffer[] = [];
  const chunkCount = Math.ceil(file.size / ENCRYPTION_CHUNK_SIZE);

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * ENCRYPTION_CHUNK_SIZE;
    const plaintext = await file.slice(start, start + ENCRYPTION_CHUNK_SIZE).arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const chunkIndex = new Uint8Array(4);
    new DataView(chunkIndex.buffer).setUint32(0, index);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: chunkIndex },
      key,
      plaintext,
    );
    const packet = new Uint8Array(chunkIndex.byteLength + IV_LENGTH + ciphertext.byteLength);
    packet.set(chunkIndex, 0);
    packet.set(iv, chunkIndex.byteLength);
    packet.set(new Uint8Array(ciphertext), chunkIndex.byteLength + IV_LENGTH);
    encryptedChunks.push(packet.buffer);
    onProgress(Math.round(((index + 1) / chunkCount) * 100));
  }

  return encryptedChunks;
}

export async function decryptChunk(
  packet: ArrayBuffer,
  key: CryptoKey,
): Promise<{ index: number; plaintext: ArrayBuffer }> {
  const headerLength = 4 + IV_LENGTH;
  if (packet.byteLength <= headerLength) {
    throw new Error("Received an invalid encrypted chunk");
  }
  const bytes = new Uint8Array(packet);
  const indexHeader = bytes.slice(0, 4);
  const index = new DataView(indexHeader.buffer).getUint32(0);
  const iv = bytes.slice(4, headerLength);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: indexHeader },
    key,
    bytes.slice(headerLength),
  );
  return { index, plaintext };
}
