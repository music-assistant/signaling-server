/**
 * Signaling Server Core Logic
 *
 * This module contains the shared business logic for the signaling server.
 * It's designed to be platform-agnostic and can be used by both:
 * - Cloudflare Workers (with Durable Objects)
 * - Node.js standalone server (with ws library)
 *
 * The platform-specific code just needs to:
 * 1. Handle WebSocket connections
 * 2. Call the appropriate handler methods
 * 3. Implement the send callback
 */

export { RateLimiter } from './rate-limiter';
import { RateLimiter } from './rate-limiter';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SignalingMessage {
  type: string;
  remoteId?: string;
  sessionId?: string;
  data?: unknown;
  error?: string;
  iceServers?: IceServerConfig[];
}

export interface ServerData<WS> {
  ws: WS;
  iceServers?: IceServerConfig[];
}

export interface ClientData<WS> {
  ws: WS;
  remoteId: string;
}

export interface PendingClient<WS> {
  ws: WS;
  remoteId: string;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface ConnectionMetadata {
  type: 'server' | 'client';
  id: string;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Core signaling logic that can be used by any WebSocket implementation
 */
export class SignalingCore<WS> {
  // Map of Remote ID -> { ws, iceServers } (MA server instances)
  public servers: Map<string, ServerData<WS>> = new Map();

  // Map of Session ID -> { ws, remoteId } (PWA clients)
  public clients: Map<string, ClientData<WS>> = new Map();

  // Map of Session ID -> pending client connection (waiting for fresh ICE servers)
  public pendingClients: Map<string, PendingClient<WS>> = new Map();

  // Map of WebSocket -> metadata
  public wsMetadata: Map<WS, ConnectionMetadata> = new Map();

  // Map of WebSocket -> client IP (for rate limiting)
  public wsClientIp: Map<WS, string> = new Map();

  // Rate limiter instance
  public rateLimiter: RateLimiter;

  // Callback to send a message to a WebSocket
  private sendFn: (ws: WS, message: string) => void;

  // Callback to close a WebSocket
  private closeFn: (ws: WS, code: number, reason: string) => void;

  // Callback for logging
  private logFn: (message: string) => void;

  // Timeout for waiting for fresh ICE servers (ms)
  private readonly FRESH_ICE_TIMEOUT = 10000;

  // Cleanup interval for rate limiter
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(options: {
    send: (ws: WS, message: string) => void;
    close: (ws: WS, code: number, reason: string) => void;
    log?: (message: string) => void;
    rateLimiter?: RateLimiter;
  }) {
    this.sendFn = options.send;
    this.closeFn = options.close;
    this.logFn = options.log || console.log;
    this.rateLimiter = options.rateLimiter || new RateLimiter();

    // Set up periodic cleanup of rate limiter (every 5 minutes)
    this.cleanupInterval = setInterval(() => {
      this.rateLimiter.cleanup();
    }, 300000);
  }

  /**
   * Register a WebSocket with its client IP for rate limiting
   */
  setClientIp(ws: WS, ip: string): void {
    this.wsClientIp.set(ws, ip);
  }

  /**
   * Check rate limit for a WebSocket. Returns false if blocked.
   */
  checkRateLimit(ws: WS): boolean {
    const ip = this.wsClientIp.get(ws);
    if (!ip) return true; // No IP tracking, allow

    const result = this.rateLimiter.checkRequest(ip);
    if (!result.allowed) {
      this.send(ws, {
        type: 'error',
        error: `Rate limited. Try again in ${result.retryAfter} seconds.`
      });
      return false;
    }
    return true;
  }

  private send(ws: WS, message: object): void {
    this.sendFn(ws, JSON.stringify(message));
  }

  private sendError(ws: WS, error: string): void {
    this.send(ws, { type: 'error', error });
  }

  private log(message: string): void {
    this.logFn(message);
  }

  /**
   * Handle an incoming message from a WebSocket
   */
  handleMessage(ws: WS, message: SignalingMessage): void {
    // Rate limit check for non-ping/pong messages
    if (message.type !== 'ping' && message.type !== 'pong') {
      if (!this.checkRateLimit(ws)) {
        return;
      }
    }

    switch (message.type) {
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      case 'pong':
        // Connection is alive
        break;

      case 'register-server':
        this.handleServerRegister(ws, message);
        break;

      case 'connect-request':
        this.handleConnectRequest(ws, message);
        break;

      case 'session-ready':
        this.handleSessionReady(ws, message);
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        this.forwardSignalingMessage(ws, message);
        break;

      default:
        this.log(`Unknown message type: ${message.type}`);
        this.sendError(ws, `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle MA server registration
   */
  private handleServerRegister(ws: WS, message: SignalingMessage): void {
    const remoteId = message.remoteId?.toUpperCase();
    if (!remoteId) {
      this.sendError(ws, 'Remote ID required');
      return;
    }

    // Check if this WebSocket is already registered
    const existingMetadata = this.wsMetadata.get(ws);
    if (existingMetadata && existingMetadata.type === 'server' && existingMetadata.id === remoteId) {
      const existingServer = this.servers.get(remoteId);
      if (existingServer && message.iceServers) {
        existingServer.iceServers = message.iceServers;
      }
      this.send(ws, { type: 'registered', remoteId });
      return;
    }

    // Check if Remote ID is already registered with a DIFFERENT WebSocket
    const existingServer = this.servers.get(remoteId);
    if (existingServer && existingServer.ws !== ws) {
      this.servers.delete(remoteId);
      this.wsMetadata.delete(existingServer.ws);
      this.closeFn(existingServer.ws, 4000, 'Replaced by new connection');
    }

    // Register the new server connection with ICE servers
    this.servers.set(remoteId, { ws, iceServers: message.iceServers });
    this.wsMetadata.set(ws, { type: 'server', id: remoteId });

    this.log(`✓ Server registered: ${remoteId}`);
    this.send(ws, { type: 'registered', remoteId });
  }

  /**
   * Handle PWA client connection request
   */
  private handleConnectRequest(ws: WS, message: SignalingMessage): void {
    const remoteId = message.remoteId?.toUpperCase();
    if (!remoteId) {
      this.sendError(ws, 'Remote ID required');
      return;
    }

    const serverData = this.servers.get(remoteId);
    if (!serverData) {
      // Track failed lookup for brute force detection
      const ip = this.wsClientIp.get(ws);
      if (ip) {
        const blocked = this.rateLimiter.recordFailedLookup(ip);
        if (blocked) {
          this.log(`⚠ Blocked IP ${ip} for brute force attempts`);
          this.sendError(ws, 'Too many failed attempts. You have been temporarily blocked.');
          this.closeFn(ws, 4008, 'Blocked for brute force');
          return;
        }
      }
      this.sendError(ws, 'Server not found. Make sure your Music Assistant server is running and has Remote Access enabled.');
      return;
    }

    const sessionId = generateSessionId();

    // Store pending client - we'll complete the connection when server sends fresh ICE servers
    const timeoutId = setTimeout(() => {
      const pending = this.pendingClients.get(sessionId);
      if (pending) {
        this.pendingClients.delete(sessionId);
        this.clients.set(sessionId, { ws: pending.ws, remoteId });

        // Send connected with cached ICE servers as fallback
        this.send(pending.ws, {
          type: 'connected',
          remoteId: remoteId,
          sessionId: sessionId,
          iceServers: serverData.iceServers,
        });
      }
    }, this.FRESH_ICE_TIMEOUT);

    this.pendingClients.set(sessionId, { ws, remoteId, timeout: timeoutId });
    this.wsMetadata.set(ws, { type: 'client', id: sessionId });

    // Request fresh ICE servers from the server
    this.send(serverData.ws, {
      type: 'client-connected',
      sessionId: sessionId,
    });
  }

  /**
   * Handle session-ready message from MA server with fresh ICE servers
   */
  private handleSessionReady(ws: WS, message: SignalingMessage): void {
    const sessionId = message.sessionId;

    if (!sessionId) {
      this.sendError(ws, 'Session ID required');
      return;
    }

    const pending = this.pendingClients.get(sessionId);
    if (!pending) {
      return;
    }

    // Get the remote ID from server metadata
    const serverMetadata = this.wsMetadata.get(ws);
    if (!serverMetadata || serverMetadata.type !== 'server') {
      this.sendError(ws, 'Not a registered server');
      return;
    }
    const remoteId = serverMetadata.id;

    // Clear the timeout
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    // Move from pending to active clients
    this.pendingClients.delete(sessionId);
    this.clients.set(sessionId, { ws: pending.ws, remoteId });

    // Extract ICE servers from message
    const iceServers = message.iceServers;

    // Send connected to client with fresh ICE servers from the server
    this.send(pending.ws, {
      type: 'connected',
      remoteId: remoteId,
      sessionId: sessionId,
      iceServers: iceServers,
    });
  }

  /**
   * Forward signaling messages between client and server
   */
  private forwardSignalingMessage(ws: WS, message: SignalingMessage): void {
    const metadata = this.wsMetadata.get(ws);
    if (!metadata) {
      this.sendError(ws, 'Not registered');
      return;
    }

    if (metadata.type === 'client') {
      // Client -> Server
      const sessionId = metadata.id;
      const clientData = this.clients.get(sessionId);
      if (!clientData) {
        this.sendError(ws, 'Session not found');
        return;
      }

      const serverData = this.servers.get(clientData.remoteId);
      if (!serverData) {
        this.sendError(ws, 'Server disconnected');
        return;
      }

      this.send(serverData.ws, { ...message, sessionId });
    } else if (metadata.type === 'server') {
      // Server -> Client
      const sessionId = message.sessionId;
      if (!sessionId) {
        this.sendError(ws, 'Session ID required');
        return;
      }

      const clientData = this.clients.get(sessionId);
      if (!clientData) {
        this.sendError(ws, 'Client not found');
        return;
      }

      this.send(clientData.ws, message);
    }
  }

  /**
   * Handle WebSocket disconnection
   */
  handleDisconnect(ws: WS): void {
    const metadata = this.wsMetadata.get(ws);
    if (!metadata) {
      return;
    }

    if (metadata.type === 'server') {
      const remoteId = metadata.id;
      const serverData = this.servers.get(remoteId);

      // Only delete if this WebSocket is still the registered one
      if (serverData && serverData.ws === ws) {
        this.servers.delete(remoteId);
        this.wsMetadata.delete(ws);
        this.log(`✗ Server disconnected: ${remoteId}`);

        // Notify connected clients
        for (const [sessionId, clientData] of this.clients.entries()) {
          if (clientData.remoteId === remoteId) {
            this.send(clientData.ws, { type: 'peer-disconnected' });
            this.clients.delete(sessionId);
          }
        }

        // Clean up pending clients
        for (const [sessionId, pending] of this.pendingClients.entries()) {
          if (pending.remoteId === remoteId) {
            if (pending.timeout) clearTimeout(pending.timeout);
            this.send(pending.ws, { type: 'error', error: 'Server disconnected' });
            this.pendingClients.delete(sessionId);
          }
        }
      } else {
        this.wsMetadata.delete(ws);
      }
    } else if (metadata.type === 'client') {
      const sessionId = metadata.id;

      // Check if in pending
      const pending = this.pendingClients.get(sessionId);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pendingClients.delete(sessionId);
      }

      // Check if in active clients
      const clientData = this.clients.get(sessionId);
      if (clientData) {
        const serverData = this.servers.get(clientData.remoteId);
        if (serverData) {
          this.send(serverData.ws, { type: 'client-disconnected', sessionId });
        }
        this.clients.delete(sessionId);
      }

      this.wsMetadata.delete(ws);
    }

    // Clean up IP mapping
    this.wsClientIp.delete(ws);
  }

  /**
   * Check if a remote ID is online
   */
  isOnline(remoteId: string): boolean {
    return this.servers.has(remoteId.toUpperCase());
  }

  /**
   * Get stats about connected servers and clients
   */
  getStats(): {
    servers: number;
    clients: number;
    pendingClients: number;
    rateLimiter: { trackedIps: number; blockedIps: number; failedLookupTracked: number };
  } {
    return {
      servers: this.servers.size,
      clients: this.clients.size,
      pendingClients: this.pendingClients.size,
      rateLimiter: this.rateLimiter.getStats(),
    };
  }
}
