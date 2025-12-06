#!/usr/bin/env node
/**
 * Music Assistant Signaling Server (Standalone Node.js version)
 *
 * Run with: node standalone.js
 *
 * Default port: 8787
 * Custom port: PORT=9000 node standalone.js
 *
 * This server handles WebRTC signaling between PWA clients and MA server instances.
 * It supports relaying ICE servers (including TURN credentials) from the MA server to clients.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;

// Storage
// Map of Remote ID -> { ws, iceServers } (MA server instances)
const servers = new Map();
// Map of Session ID -> { ws, remoteId } (PWA clients)
const clients = new Map();
// Map of Session ID -> { ws, remoteId, timeout } (pending client connections waiting for fresh ICE servers)
const pendingClients = new Map();
// Map of WebSocket -> { type, id }
const wsMetadata = new Map();

function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function sendError(ws, error) {
  ws.send(JSON.stringify({ type: 'error', error }));
}

function handleMessage(ws, message) {
  let msg;
  try {
    msg = JSON.parse(message);
  } catch (e) {
    sendError(ws, 'Invalid JSON');
    return;
  }

  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    case 'pong':
      break;

    case 'register-server':
      handleServerRegister(ws, msg);
      break;

    case 'connect-request':
      handleConnectRequest(ws, msg);
      break;

    case 'session-ready':
      handleSessionReady(ws, msg);
      break;

    case 'offer':
    case 'answer':
    case 'ice-candidate':
      forwardSignalingMessage(ws, msg);
      break;

    default:
      console.log(`Unknown message type: ${msg.type}`);
      sendError(ws, `Unknown message type: ${msg.type}`);
  }
}

function handleServerRegister(ws, msg) {
  const remoteId = msg.remoteId?.toUpperCase();
  if (!remoteId) {
    sendError(ws, 'Remote ID required');
    return;
  }

  const existingMetadata = wsMetadata.get(ws);
  if (existingMetadata && existingMetadata.type === 'server' && existingMetadata.id === remoteId) {
    const existingServer = servers.get(remoteId);
    if (existingServer && msg.iceServers) {
      existingServer.iceServers = msg.iceServers;
    }
    ws.send(JSON.stringify({ type: 'registered', remoteId }));
    return;
  }

  const existingServer = servers.get(remoteId);
  if (existingServer && existingServer.ws !== ws) {
    servers.delete(remoteId);
    wsMetadata.delete(existingServer.ws);
    existingServer.ws.close(4000, 'Replaced by new connection');
  }

  servers.set(remoteId, { ws, iceServers: msg.iceServers });
  wsMetadata.set(ws, { type: 'server', id: remoteId });

  console.log(`✓ Server registered: ${remoteId}`);
  ws.send(JSON.stringify({ type: 'registered', remoteId }));
}

function handleConnectRequest(ws, msg) {
  const remoteId = msg.remoteId?.toUpperCase();
  if (!remoteId) {
    sendError(ws, 'Remote ID required');
    return;
  }

  const serverData = servers.get(remoteId);
  if (!serverData) {
    sendError(ws, 'Server not found. Make sure your Music Assistant server is running and has Remote Access enabled.');
    return;
  }

  const sessionId = generateSessionId();

  // Store pending client - complete when server sends fresh ICE servers
  const timeoutId = setTimeout(() => {
    const pending = pendingClients.get(sessionId);
    if (pending) {
      pendingClients.delete(sessionId);
      clients.set(sessionId, { ws: pending.ws, remoteId });
      pending.ws.send(JSON.stringify({
        type: 'connected',
        remoteId: remoteId,
        sessionId: sessionId,
        iceServers: serverData.iceServers,
      }));
    }
  }, 10000);

  pendingClients.set(sessionId, { ws, remoteId, timeout: timeoutId });
  wsMetadata.set(ws, { type: 'client', id: sessionId });

  serverData.ws.send(JSON.stringify({
    type: 'client-connected',
    sessionId: sessionId,
  }));
}

function handleSessionReady(ws, msg) {
  const sessionId = msg.sessionId;
  if (!sessionId) {
    sendError(ws, 'Session ID required');
    return;
  }

  const pending = pendingClients.get(sessionId);
  if (!pending) {
    return;
  }

  const serverMetadata = wsMetadata.get(ws);
  if (!serverMetadata || serverMetadata.type !== 'server') {
    sendError(ws, 'Not a registered server');
    return;
  }
  const remoteId = serverMetadata.id;

  clearTimeout(pending.timeout);
  pendingClients.delete(sessionId);
  clients.set(sessionId, { ws: pending.ws, remoteId });

  pending.ws.send(JSON.stringify({
    type: 'connected',
    remoteId: remoteId,
    sessionId: sessionId,
    iceServers: msg.iceServers,
  }));
}

function forwardSignalingMessage(ws, msg) {
  const metadata = wsMetadata.get(ws);
  if (!metadata) {
    sendError(ws, 'Not registered');
    return;
  }

  if (metadata.type === 'client') {
    // Client -> Server
    const sessionId = metadata.id;
    const clientData = clients.get(sessionId);
    if (!clientData) {
      sendError(ws, 'Session not found');
      return;
    }

    const serverData = servers.get(clientData.remoteId);
    if (!serverData) {
      sendError(ws, 'Server disconnected');
      return;
    }

    serverData.ws.send(JSON.stringify({ ...msg, sessionId }));
  } else if (metadata.type === 'server') {
    // Server -> Client
    const sessionId = msg.sessionId;
    if (!sessionId) {
      sendError(ws, 'Session ID required');
      return;
    }

    const clientData = clients.get(sessionId);
    if (!clientData) {
      sendError(ws, 'Client not found');
      return;
    }

    clientData.ws.send(JSON.stringify(msg));
  }
}

/**
 * Handle WebSocket disconnection
 */
function handleDisconnect(ws) {
  const metadata = wsMetadata.get(ws);
  if (!metadata) {
    return;
  }

  if (metadata.type === 'server') {
    const remoteId = metadata.id;
    const serverData = servers.get(remoteId);

    // Only delete if this WebSocket is still the registered one
    if (serverData && serverData.ws === ws) {
      servers.delete(remoteId);
      wsMetadata.delete(ws);
      console.log(`✗ Server disconnected: ${remoteId}`);

      // Notify connected clients
      for (const [sessionId, clientData] of clients.entries()) {
        if (clientData.remoteId === remoteId) {
          clientData.ws.send(JSON.stringify({ type: 'peer-disconnected' }));
          clients.delete(sessionId);
        }
      }

      // Clean up pending clients
      for (const [sessionId, pending] of pendingClients.entries()) {
        if (pending.remoteId === remoteId) {
          clearTimeout(pending.timeout);
          pending.ws.send(JSON.stringify({ type: 'error', error: 'Server disconnected' }));
          pendingClients.delete(sessionId);
        }
      }
    } else {
      wsMetadata.delete(ws);
      console.log(`[${remoteId}] Old connection closed (was already replaced)`);
    }
  } else if (metadata.type === 'client') {
    const sessionId = metadata.id;

    // Check if in pending
    const pending = pendingClients.get(sessionId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingClients.delete(sessionId);
    }

    // Check if in active clients
    const clientData = clients.get(sessionId);
    if (clientData) {
      const serverData = servers.get(clientData.remoteId);
      if (serverData) {
        serverData.ws.send(JSON.stringify({ type: 'client-disconnected', sessionId }));
      }
      clients.delete(sessionId);
    }

    wsMetadata.delete(ws);
    console.log(`✗ Client disconnected: ${sessionId}`);
  }
}

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '2.0.0',
      servers: servers.size,
      clients: clients.size,
      pendingClients: pendingClients.size,
    }));
  } else if (req.url?.startsWith('/api/check/')) {
    const remoteId = req.url.split('/').pop()?.toUpperCase();
    const online = remoteId ? servers.has(remoteId) : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ online }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Music Assistant Signaling Server

Status: Running
Version: 2.0.0 (with ICE server relay support)
Connected servers: ${servers.size}
Connected clients: ${clients.size}
Pending clients: ${pendingClients.size}

Endpoints:
  WebSocket: ws://localhost:${PORT}/ws
  Health:    http://localhost:${PORT}/health
  Check:     http://localhost:${PORT}/api/check/:remoteId
`);
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// Ping interval to keep connections alive
const PING_INTERVAL = 30000;

wss.on('connection', (ws) => {
  console.log(`[${new Date().toISOString()}] New connection`);

  // Set up ping interval
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL);

  ws.on('message', (data) => handleMessage(ws, data.toString()));

  ws.on('close', () => {
    clearInterval(pingInterval);
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    clearInterval(pingInterval);
    handleDisconnect(ws);
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Music Assistant Signaling Server v2.0.0               ║
║     (with ICE server relay support)                       ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  WebSocket URL:  ws://localhost:${PORT}/ws                   ║
║  Health Check:   http://localhost:${PORT}/health             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
});
