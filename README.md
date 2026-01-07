# Music Assistant Signaling Server

WebRTC signaling server for Music Assistant remote connections. This server enables secure peer-to-peer connections between the hosted PWA and local Music Assistant instances without requiring port forwarding.

## Quick Start

### Option 1: Render.com (Recommended for Testing)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Fork this repository
2. Connect to Render.com
3. Create a new Web Service pointing to your fork
4. Set root directory to `/` and start command to `pnpm start`
5. Your signaling server will be at `wss://your-app.onrender.com/ws`

### Option 2: Local Development

```bash
pnpm install
pnpm start
# Server runs at ws://localhost:8787/ws
```

### Option 3: Using Mise

```bash
mise install        # Install Node.js 20
mise run dev        # Run locally
# Or with Docker:
mise run docker:up  # Build and run with Docker
# Server runs at ws://localhost:8787/ws
```

### Option 4: Docker

```bash
docker run -p 8787:8787 ghcr.io/music-assistant/signaling-server:latest
# Server runs at ws://localhost:8787/ws
```

### Option 5: Cloudflare Workers (Production)

```bash
pnpm install
pnpm dlx wrangler login
pnpm deploy
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Signaling Server (Cloudflare Workers)            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Durable Object                            │   │
│  │  - Maintains WebSocket connections                          │   │
│  │  - Routes signaling messages                                │   │
│  │  - Manages Remote ID registry                               │   │
│  └─────────────────────────────────────────────────────────────┘   │
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

## Deployment

### Docker (Recommended)

```bash
docker run -p 8787:8787 ghcr.io/music-assistant/signaling-server:latest
```

Or use mise tasks for local development:

```bash
mise run docker:up          # Build and run
mise run docker:up:detached # Run in background
```

### Cloudflare Workers

Prerequisites: Cloudflare account, Node.js 20+, Wrangler CLI

```bash
pnpm install
pnpm dlx wrangler login
pnpm deploy
```

### Local Development

```bash
pnpm install
pnpm start
# Or with mise:
mise run dev
```

The server will be available at `http://localhost:8787`

## API

### WebSocket Endpoint: `/ws`

Connect via WebSocket for signaling.

#### Messages from MA Server

**Register Server**
```json
{
  "type": "register-server",
  "remoteId": "MA-X7K9-P2M4"
}
```

Response:
```json
{
  "type": "registered",
  "remoteId": "MA-X7K9-P2M4"
}
```

**Signaling Messages (to client)**
```json
{
  "type": "answer|ice-candidate",
  "sessionId": "abc123",
  "data": { /* SDP or ICE candidate */ }
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
  "sessionId": "abc123"
}
```

**Signaling Messages (to server)**
```json
{
  "type": "offer|ice-candidate",
  "data": { /* SDP or ICE candidate */ }
}
```

### REST Endpoints

**Health Check**
```
GET /health
```

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

3. **Rate Limiting**: Built-in rate limiting protects against brute force attacks on the `/api/check` endpoint and WebSocket connections.

## Docker

### Pre-built Images

Docker images are automatically published to GitHub Container Registry on each release:

```bash
# Latest version
docker run -p 8787:8787 ghcr.io/music-assistant/signaling-server:latest

# Specific version
docker run -p 8787:8787 ghcr.io/music-assistant/signaling-server:2.0.0

# Custom port
docker run -p 9000:9000 -e PORT=9000 ghcr.io/music-assistant/signaling-server:latest
```

### Build Locally

```bash
docker build -t ma-signaling-server .
docker run -p 8787:8787 ma-signaling-server
```

### Docker Compose

```yaml
services:
  signaling:
    image: ghcr.io/music-assistant/signaling-server:latest
    ports:
      - "8787:8787"
    environment:
      - PORT=8787
    restart: unless-stopped
```

## Mise Tasks

This project uses [mise](https://mise.jdx.dev/) for version management and task running.

Run `mise run` to see all available tasks.

```bash
mise run docker:build       # Build the Docker image
mise run docker:build:nocache # Build without cache
mise run docker:up          # Build and run container
mise run docker:up:detached # Build and run in background
mise run docker:down        # Stop and remove container
mise run docker:logs        # Follow container logs
mise run docker:test        # Test build and run
mise run docker:clean       # Remove built images
mise run dev                # Run local dev server
mise run build              # Build TypeScript
```

## Environment Variables

- `PORT`: Server port (default: `8787`)
- `ENVIRONMENT`: Set to "production" or "development"

## Custom Domain

To use a custom domain (e.g., `signaling.music-assistant.io`):

1. Add the domain to Cloudflare
2. Update `wrangler.toml`:

```toml
routes = [
  { pattern = "signaling.music-assistant.io/*", zone_name = "music-assistant.io" }
]
```

3. Deploy with `pnpm deploy`
