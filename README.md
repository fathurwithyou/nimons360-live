# nimons360-live

Livestream coordinator for the Nimons360 family tracking Android app.

## What this is

A tiny service that lets a family member broadcast live video to their family. It does two jobs:

1. Runs **MediaMTX** — a single-binary media server that accepts **RTMP** ingest from the broadcaster and serves **HLS** to viewers.
2. Runs a **TypeScript / Fastify coordinator** that tracks which streams are currently live per family and notifies other members over WebSocket.

The Android app pushes video from the camera to `rtmp://host:1935/live/<streamKey>` using RootEncoder, and viewers pull `http://host:8888/live/<streamKey>/index.m3u8` with ExoPlayer.

## Architecture

```
┌────────────────────┐    RTMP    ┌───────────────┐    HLS    ┌──────────────┐
│ Broadcaster (App)  │──────────▶ │   MediaMTX    │ ────────▶ │ Viewer (App) │
└────────┬───────────┘            └───────────────┘           └──────┬───────┘
         │                                                           │
         │  POST /api/streams/start                                   │  GET /api/families/:id/streams
         │  DELETE /api/streams/:id                                   │  ws /ws/live-streams
         ▼                                                           ▼
                    ┌─────────────────────────────────┐
                    │   Coordinator (Fastify, TS)     │
                    │   in-memory stream registry     │
                    │   broadcasts stream_started /   │
                    │   stream_ended over WebSocket   │
                    └─────────────────────────────────┘
```

## API

### `POST /api/streams/start`

Broadcaster calls this before opening the RTMP connection. The coordinator generates a random `streamKey`, registers the stream in-memory, and broadcasts a `stream_started` event to all WebSocket subscribers.

Request body:

```json
{
  "familyId": "42",
  "broadcasterId": "7",
  "broadcasterName": "Rizky",
  "title": "At the park"
}
```

Response:

```json
{
  "data": {
    "id": "ab12cd34",
    "familyId": "42",
    "broadcasterId": "7",
    "broadcasterName": "Rizky",
    "title": "At the park",
    "startedAt": 1713456789000,
    "rtmpUrl": "rtmp://localhost:1935/live",
    "streamKey": "deadbeef0011223344aabbcc",
    "hlsUrl": "http://localhost:8888/live/deadbeef0011223344aabbcc/index.m3u8"
  }
}
```

### `DELETE /api/streams/:streamId`

Broadcaster calls this after stopping. Body: `{ "broadcasterId": "7" }`. Broadcasts `stream_ended`.

### `GET /api/families/:familyId/streams`

Lists active streams for a family.

### `GET /ws/live-streams`

WebSocket stream of events. On connect, the server sends a `snapshot` message with all active streams. Then `stream_started` and `stream_ended` as they happen.

## Running locally

### Option A — Docker Compose (recommended)

```bash
cp .env.example .env
# edit PUBLIC_HOST to an IP your Android device can reach
# (localhost works only for the emulator with host-gateway; for a physical device use your LAN IP, e.g. 192.168.1.42)
docker compose up --build
```

Ports exposed:
- `1935` — RTMP ingest
- `8888` — HLS playback
- `4000` — coordinator HTTP + WebSocket

### Option B — Node directly + MediaMTX separately

```bash
npm install
npm run dev
# in another shell:
docker run --rm -p 1935:1935 -p 8888:8888 -v $(pwd)/mediamtx.yml:/mediamtx.yml bluenviron/mediamtx
```

## Configuring the Android app

In `data/network/LiveConfig.kt` set `COORDINATOR_BASE_URL` to `http://<PUBLIC_HOST>:4000/` and the WebSocket URL to `ws://<PUBLIC_HOST>:4000/ws/live-streams`. If `API_KEY` is set on the server, send the same value in the `x-api-key` header.

## Deployment

Any host that runs Docker works. Examples:

- **VPS (Hetzner / DigitalOcean / etc.)**: `git clone`, set `PUBLIC_HOST` to the server's public IP, `docker compose up -d`. Open TCP ports 1935, 4000, 8888 in the firewall.
- **Fly.io**: Create two apps (one for `mediamtx`, one for this coordinator) or run them side-by-side in one VM using the same `docker-compose.yml`. RTMP (1935) needs a dedicated IPv4 and a `tcp` service in `fly.toml`.
- **Railway**: Deploy the Node coordinator from this repo; run MediaMTX as a separate service pointing to the same `mediamtx.yml`.

For a production deployment, put an HTTPS/TLS terminator (Caddy or nginx) in front of the HLS and coordinator HTTP endpoints, and use `rtmps://` (port 1936) for the ingest.

## Notes

- The registry is in-memory and not persisted. Restarting the coordinator clears the list of live streams; MediaMTX keeps ingesting until the broadcaster drops. The next `GET /api/families/:id/streams` will simply return an empty list until something new starts.
- No authentication beyond the optional `x-api-key` header. This service trusts `broadcasterId` and `familyId` from the caller; in the Nimons360 app these come from the authenticated session on the main backend (`https://mad.labpro.hmif.dev`).
- Ingest is on RTMP (not RTMPS) because RootEncoder's RTMPS support is limited. For production add an nginx `stream {}` TLS wrapper.
