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

import { SignalingCore, SignalingMessage, RateLimiter } from './signaling-core';

/**
 * Get client IP from Cloudflare headers
 */
function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

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
    const clientIp = getClientIp(request);

    // Handle WebSocket upgrade
    if (url.pathname === '/ws') {
      // Get or create the global signaling room
      const roomId = env.SIGNALING_ROOM.idFromName('global');
      const room = env.SIGNALING_ROOM.get(roomId);

      // Forward request with client IP header
      const headers = new Headers(request.headers);
      headers.set('X-Client-IP', clientIp);
      const forwardedRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
      });
      return room.fetch(forwardedRequest);
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

      // Forward check request to the Durable Object with client IP
      const checkRequest = new Request(`${url.origin}/check/${remoteId}`, {
        method: 'GET',
        headers: { 'X-Client-IP': clientIp },
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
  private rateLimiter: RateLimiter;

  // Map of WebSocket -> ping interval ID
  private pingIntervals: Map<WebSocket, ReturnType<typeof setInterval>> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;

    // Create shared rate limiter
    this.rateLimiter = new RateLimiter({
      windowMs: 60000,        // 1 minute window
      maxRequests: 100,       // 100 requests per minute per IP
      maxFailedLookups: 10,   // 10 failed server ID lookups before block
      failedLookupWindowMs: 60000,  // 1 minute window for failed lookups
      baseBlockDurationMs: 60000,   // Start with 1 minute block, exponential backoff
    });

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
      rateLimiter: this.rateLimiter,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const clientIp = request.headers.get('X-Client-IP') || 'unknown';

    // Handle stats request (no rate limiting for stats)
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

    // Handle check request with rate limiting
    if (url.pathname.startsWith('/check/')) {
      // Rate limit the check endpoint (potential brute force vector)
      const rateCheck = this.rateLimiter.checkRequest(clientIp);
      if (!rateCheck.allowed) {
        return new Response(JSON.stringify({
          error: 'Rate limited',
          retryAfter: rateCheck.retryAfter,
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(rateCheck.retryAfter),
          },
        });
      }

      const remoteId = url.pathname.split('/').pop() || '';
      const isOnline = this.core.isOnline(remoteId);

      // Track failed lookups for brute force detection
      if (!isOnline && clientIp !== 'unknown') {
        const blocked = this.rateLimiter.recordFailedLookup(clientIp);
        if (blocked) {
          console.log(`⚠ Blocked IP ${clientIp} for brute force on /check endpoint`);
          return new Response(JSON.stringify({
            error: 'Too many failed attempts. You have been temporarily blocked.',
          }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify({ online: isOnline }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Rate limit check before accepting WebSocket connection
    const rateCheck = this.rateLimiter.checkRequest(clientIp);
    if (!rateCheck.allowed) {
      return new Response(JSON.stringify({
        error: 'Rate limited',
        retryAfter: rateCheck.retryAfter,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(rateCheck.retryAfter),
        },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleWebSocket(server, clientIp);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleWebSocket(ws: WebSocket, clientIp: string): void {
    ws.accept();

    // Register client IP for rate limiting within signaling core
    this.core.setClientIp(ws, clientIp);

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
