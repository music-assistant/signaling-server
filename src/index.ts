/**
 * Music Assistant WebRTC Signaling Server
 *
 * A Cloudflare Workers-based signaling server for WebRTC connections
 * between the hosted PWA and local Music Assistant instances.
 *
 * Architecture:
 * - Each MA instance registers with a unique Remote ID
 * - PWA clients connect and request connection to a Remote ID
 * - Server brokers WebRTC signaling (SDP offers/answers, ICE candidates)
 * - Uses Durable Objects to maintain WebSocket connections
 *
 * This implementation uses the shared SignalingCore for business logic.
 */

import { SignalingCore, SignalingMessage } from './signaling-core';

export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  ENVIRONMENT: string;
}

/**
 * Main Worker - Routes requests to appropriate Durable Objects
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (url.pathname === '/ws') {
      // Get or create the global signaling room
      const roomId = env.SIGNALING_ROOM.idFromName('global');
      const room = env.SIGNALING_ROOM.get(roomId);
      return room.fetch(request);
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      const roomId = env.SIGNALING_ROOM.idFromName('global');
      const room = env.SIGNALING_ROOM.get(roomId);
      return room.fetch(new Request(`${url.origin}/stats`, { method: 'GET' }));
    }

    // API endpoint to check if a remote ID is online
    if (url.pathname.startsWith('/api/check/')) {
      const remoteId = url.pathname.split('/').pop();
      const roomId = env.SIGNALING_ROOM.idFromName('global');
      const room = env.SIGNALING_ROOM.get(roomId);

      // Forward check request to the Durable Object
      const checkRequest = new Request(`${url.origin}/check/${remoteId}`, {
        method: 'GET',
      });
      return room.fetch(checkRequest);
    }

    return new Response('Music Assistant Signaling Server\n\nEndpoints:\n- /ws - WebSocket connection\n- /health - Health check\n- /api/check/:remoteId - Check if remote ID is online', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

/**
 * Signaling Room Durable Object
 * Maintains WebSocket connections and handles signaling messages
 * Uses the shared SignalingCore for all business logic.
 */
export class SignalingRoom {
  private state: DurableObjectState;
  private core: SignalingCore<WebSocket>;

  // Map of WebSocket -> ping interval ID
  private pingIntervals: Map<WebSocket, ReturnType<typeof setInterval>> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;

    // Initialize the shared signaling core with Cloudflare-specific callbacks
    this.core = new SignalingCore<WebSocket>({
      send: (ws, message) => {
        try {
          ws.send(message);
        } catch (error) {
          console.error('Failed to send message:', error);
        }
      },
      close: (ws, code, reason) => {
        try {
          ws.close(code, reason);
        } catch (error) {
          console.error('Failed to close WebSocket:', error);
        }
      },
      log: (message) => console.log(message),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle stats request
    if (url.pathname === '/stats') {
      const stats = this.core.getStats();
      return new Response(JSON.stringify({
        status: 'ok',
        version: '2.0.0',
        ...stats,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle check request
    if (url.pathname.startsWith('/check/')) {
      const remoteId = url.pathname.split('/').pop() || '';
      const isOnline = this.core.isOnline(remoteId);
      return new Response(JSON.stringify({ online: isOnline }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleWebSocket(ws: WebSocket): void {
    ws.accept();

    // Set up ping interval (every 30 seconds)
    const pingInterval = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (error) {
        console.error('Failed to send ping:', error);
        clearInterval(pingInterval);
      }
    }, 30000);

    this.pingIntervals.set(ws, pingInterval);

    ws.addEventListener('message', (event) => {
      try {
        const message: SignalingMessage = JSON.parse(event.data as string);
        this.core.handleMessage(ws, message);
      } catch (error) {
        console.error('Failed to parse message:', error);
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
      }
    });

    ws.addEventListener('close', () => {
      this.cleanup(ws);
    });

    ws.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
      this.cleanup(ws);
    });
  }

  private cleanup(ws: WebSocket): void {
    const pingInterval = this.pingIntervals.get(ws);
    if (pingInterval) {
      clearInterval(pingInterval);
      this.pingIntervals.delete(ws);
    }
    this.core.handleDisconnect(ws);
  }
}
