# VaultShare

VaultShare is a prototype for time-limited, end-to-end encrypted file sharing. The
browser encrypts each file in AES-GCM chunks before transfer. WebRTC is attempted
first; if a peer-to-peer connection cannot be established, the encrypted chunks
are relayed through the signaling server over WebSocket. The backend stores only
a random transfer ID and creation timestamp in Redis for five minutes.

The AES-GCM key is placed in the URL fragment. URL fragments are not included in
HTTP requests, and the backend never receives that key. Anyone with the complete
link can decrypt the file, so share it only with the intended recipient.

## Directory structure

```text
.
├── backend/
│   ├── .env.example
│   ├── Dockerfile
│   ├── package-lock.json
│   ├── package.json
│   └── src/
│       └── server.js
├── .gitignore
├── frontend/
│   ├── .env.example
│   ├── next-env.d.ts
│   ├── next.config.ts
│   ├── package-lock.json
│   ├── package.json
│   ├── postcss.config.mjs
│   ├── tsconfig.json
│   └── src/
│       ├── app/
│       │   ├── globals.css
│       │   ├── layout.tsx
│       │   ├── page.tsx
│       │   └── receive/
│       │       └── [transferId]/
│       │           └── page.tsx
│       ├── components/
│       │   ├── receiver-panel.tsx
│       │   └── upload-panel.tsx
│       └── lib/
│           ├── crypto.ts
│           └── signaling.ts
└── README.md
```

## Requirements

- Node.js 20 or later
- Redis (local or a hosted Redis-compatible service)

## Local run

Start Redis locally, then open two terminals.

### Backend

```sh
cd backend
npm install
```

Copy `.env.example` to `.env` and set `REDIS_URL` to your Redis connection URL.

```sh
npm run dev
```

The API and WebSocket signaling endpoint are served on `http://localhost:4000`
and `ws://localhost:4000/ws`. Check `http://localhost:4000/health` for the
health response.

### Frontend

```sh
cd frontend
npm install
```

Copy `.env.example` to `.env.local`. The defaults target the local backend.

```sh
npm run dev
```

Open `http://localhost:3000`, choose or drop a file, and send the generated
link to the recipient. Both users must keep their browser tab open during the
transfer. The sender sees **Encrypting file**, **Link generated**, and
**Transfer complete** as the transfer progresses.

## Deployment

### Frontend (Vercel)

Import the repository into Vercel and set the project root to `frontend`.
Configure:

- `NEXT_PUBLIC_API_URL`: public HTTPS base URL for the backend, without a trailing slash.
- `NEXT_PUBLIC_SIGNALING_URL`: public WSS URL for the backend WebSocket endpoint, e.g. `wss://your-backend.example/ws`.

Deploy with the Next.js framework preset.

### Backend (Fly.io or Heroku)

Deploy `backend/` (the included Dockerfile can be used by Fly.io). Configure:

- `REDIS_URL`: Redis connection URL.
- `FRONTEND_ORIGIN`: exact deployed frontend origin, e.g. `https://your-app.vercel.app`.
- `PORT`: optional; the platform-provided port is used when set.

The backend requires a Redis-compatible instance; provision one with your
hosting provider and use its connection URL. Make sure the platform supports
WebSocket upgrades. Signaling messages and fallback file data are relayed in
memory and are not persisted.

## Transfer and security notes

- Each transfer uses a newly generated 256-bit AES-GCM key and a fresh 96-bit
  IV for every 32 KiB file chunk.
- The key is shared only in the link fragment and imported locally by the receiver.
- The API stores only the transfer identifier and creation timestamp with a
  five-minute Redis TTL. No files, keys, or file names are stored by the backend.
- WebRTC STUN is configured for connection discovery. Some restrictive networks
  require a TURN server; add a TURN service to the `iceServers` configuration
  when deploying for those networks.
- If WebRTC does not connect, encrypted file chunks are relayed through the
  WebSocket signaling service. The server does not decrypt or persist them.
- The prototype holds encrypted chunks in browser memory and is intended for
  files up to 1 GB. Do not close either tab before the receiver confirms completion.

## Example commit sequence

To build the project in small, reviewable changes in a Git repository:

```text
init: setup project structure
feat: add backend signaling server
feat: add Redis TTL link storage
feat: implement WebRTC data channel
feat: add frontend upload + encryption
feat: add decryption on receiver side
chore: add README with run instructions
```
