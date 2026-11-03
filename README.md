# Music Assistant Signaling Server

WebRTC signaling server for Music Assistant remote connections. It lets the hosted PWA at app.music-assistant.io reach a local Music Assistant server without port forwarding: both sides connect to this server over WebSocket, exchange the WebRTC offer, answer and ICE candidates through it, and then stream peer to peer.

The server keeps its registry in memory and runs as a single Node.js process in a container.

## Running it

### Docker

```bash
docker run -p 8787:8787 ghcr.io/music-assistant/signaling-server:latest
# WebSocket at ws://localhost:8787/ws, health at http://localhost:8787/health
```

Images are published to GitHub Container Registry on every release, for `linux/amd64` and `linux/arm64`, with signed build provenance:

```bash
docker run -p 8787:8787 ghcr.io/music-assistant/signaling-server:v2.0.2  # specific version
docker run -p 9000:9000 -e PORT=9000 ghcr.io/music-assistant/signaling-server:latest
gh attestation verify oci://ghcr.io/music-assistant/signaling-server:v2.0.2 --owner music-assistant
```

### Docker Compose

```yaml
services:
  signaling:
    image: ghcr.io/music-assistant/signaling-server:latest
    ports:
      - '8787:8787'
    environment:
      - PORT=8787
    restart: unless-stopped
```

The `docker-compose.yml` in this repository builds the image from source instead.

### Local development

Install [mise](https://mise.jdx.dev/); it provides the pinned Node.js and pnpm.

```bash
mise install
mise run setup      # install dependencies
mise run dev        # build and start on http://localhost:8787
mise run test       # protocol tests against the built server
mise run ci         # everything CI runs
```

Run `mise run` to see all tasks:

```bash
mise run setup              # First-time setup (installs dependencies)
mise run update             # Update after git pull
mise run dev                # Build and run the server
mise run test               # Protocol tests: build, start, exercise the API
mise run ci                 # Everything CI runs: lint, format, typecheck, test, build, audit
mise run check              # Lint, format and type checks only
mise run build              # Compile TypeScript to dist/
mise run docker:build       # Build the Docker image
mise run docker:build:nocache # Build without cache
mise run docker:up          # Build and run container
mise run docker:up:detached # Build and run in background
mise run docker:down        # Stop and remove container
mise run docker:logs        # Follow container logs
mise run docker:test        # Build the image and check /health
mise run docker:clean       # Remove built images
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Signaling Server (Node.js)                       │
│                                                                     │
│  - Maintains WebSocket connections                                  │
│  - Routes signaling messages                                        │
│  - Manages the Remote ID registry (in memory)                       │
│  - Rate limits lookups and connections per IP                       │
└─────────────────────────────────────────────────────────────────────┘
              ↑                                    ↑
              │ WebSocket                          │ WebSocket
              │ (register-server)                  │ (connect-request)
              │                                    │
┌─────────────┴─────────────┐        ┌────────────┴────────────┐
│   MA Server Instance      │        │     PWA Client          │
│   (Local Network)         │        │   (app.music-assistant.io)│
│                           │        │                          │
│   Remote ID: MA-X7K9-P2M4 │◄──────►│   Connects to: MA-X7K9   │
└───────────────────────────┘  P2P   └──────────────────────────┘
                             WebRTC
```

`src/signaling-core.ts` holds the protocol logic and is generic over the WebSocket type; `src/standalone.ts` is the HTTP and WebSocket entry point; `src/rate-limiter.ts` is the per-IP rate limiter. `test/protocol.test.ts` drives the whole protocol against a running build.

## API

### WebSocket Endpoint: `/ws`

Connect via WebSocket for signaling.

#### Messages from MA Server

**Register Server**

```json
{
  "type": "register-server",
  "remoteId": "MA-X7K9-P2M4",
  "iceServers": [{ "urls": "stun:stun.example.org" }]
}
```

Response:

```json
{
  "type": "registered",
  "remoteId": "MA-X7K9-P2M4"
}
```

When a client asks for this server, the server receives `{"type": "client-connected", "sessionId": "abc123"}` and answers with fresh ICE servers:

```json
{
  "type": "session-ready",
  "sessionId": "abc123",
  "iceServers": [{ "urls": "turn:turn.example.org", "username": "u", "credential": "c" }]
}
```

If no `session-ready` arrives within 10 seconds, the client is connected with the ICE servers cached at registration.

**Signaling Messages (to client)**

```json
{
  "type": "answer|ice-candidate",
  "sessionId": "abc123",
  "data": {/* SDP or ICE candidate */}
}
```

#### Messages from PWA Client

**Connect Request**

```json
{
  "type": "connect-request",
  "remoteId": "MA-X7K9-P2M4"
}
```

Response:

```json
{
  "type": "connected",
  "remoteId": "MA-X7K9-P2M4",
  "sessionId": "abc123",
  "iceServers": [{ "urls": "turn:turn.example.org", "username": "u", "credential": "c" }]
}
```

**Signaling Messages (to server)**

```json
{
  "type": "offer|ice-candidate",
  "data": {/* SDP or ICE candidate */}
}
```

#### Lifecycle messages

- `{"type": "ping"}` is answered with `{"type": "pong"}`; the server also sends `{"type": "ping"}` every 30 seconds and terminates connections that stop answering protocol-level pings.
- A server receives `{"type": "client-disconnected", "sessionId": "..."}` when a client leaves; a client receives `{"type": "peer-disconnected"}` when its server leaves.
- Registering a Remote ID that is already registered replaces the old connection, which is closed with code `4000`.
- Errors are reported as `{"type": "error", "error": "..."}`.

### REST Endpoints

**Health Check**

```
GET /health
```

Returns the version, the commit the image was built from, and counters for connected servers, clients, pending clients and the rate limiter.

**Check Remote ID Status**

```
GET /api/check/:remoteId
```

Response:

```json
{
  "online": true
}
```

## Security Considerations

1. **No Authentication on Signaling**: The signaling server only facilitates connection establishment. Actual authentication happens over the WebRTC connection directly with the MA server.

2. **Remote ID Security**: Remote IDs should be sufficiently random to prevent guessing. The MA server generates these IDs.

3. **Rate Limiting**: Built-in rate limiting protects against brute force attacks on the `/api/check` endpoint and WebSocket connections. Blocked clients get HTTP `429` or WebSocket close code `4029`.

## Environment Variables

- `PORT`: Server port (default: `8787`)
- `GIT_COMMIT`: Reported by `/health`; set by the release build

## Releasing

Commits on `main` follow Conventional Commits. release-please opens a release PR that bumps the version and changelog; merging it publishes the GitHub release, which builds and pushes the container image.
