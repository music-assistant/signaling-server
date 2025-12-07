#!/usr/bin/env node
/**
 * Music Assistant Signaling Server (Standalone Node.js version)
 *
 * Run with: node standalone.js
 *
 * Default port: 8787
 * Custom port: PORT=9000 node standalone.js
 *
 * This server uses the shared SignalingCore for all business logic.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { SignalingCore, RateLimiter } = require('./dist/signaling-core.js');

const PORT = process.env.PORT || 8787;

// Initialize rate limiter
const rateLimiter = new RateLimiter({
  windowMs: 60000,
  maxRequests: 100,
  maxFailedLookups: 10,
  failedLookupWindowMs: 60000,
  baseBlockDurationMs: 60000,
});

// Initialize the shared signaling core
const core = new SignalingCore({
  send: (ws, message) => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
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
  rateLimiter,
});

// Map of WebSocket -> ping interval
const pingIntervals = new Map();

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.socket?.remoteAddress ||
         'unknown';
}

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = getClientIp(req);

  if (req.url === '/health') {
    const stats = core.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '2.0.0',
      ...stats,
    }));
  } else if (req.url?.startsWith('/api/check/')) {
    // Rate limit the check endpoint
    const rateCheck = rateLimiter.checkRequest(clientIp);
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rateCheck.retryAfter),
      });
      res.end(JSON.stringify({ error: 'Rate limited', retryAfter: rateCheck.retryAfter }));
      return;
    }

    const remoteId = req.url.split('/').pop()?.toUpperCase() || '';
    const online = core.isOnline(remoteId);

    // Track failed lookups for brute force detection
    if (!online && clientIp !== 'unknown') {
      const blocked = rateLimiter.recordFailedLookup(clientIp);
      if (blocked) {
        console.log(`⚠ Blocked IP ${clientIp} for brute force on /check endpoint`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many failed attempts. You have been temporarily blocked.' }));
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ online }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Music Assistant Signaling Server

Status: Running
Version: 2.0.0 (with ICE server relay support)
Connected servers: ${core.servers.size}
Connected clients: ${core.clients.size}
Pending clients: ${core.pendingClients.size}

Endpoints:
  WebSocket: ws://localhost:${PORT}/ws
  Health:    http://localhost:${PORT}/health
  Check:     http://localhost:${PORT}/api/check/:remoteId
`);
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

const PING_INTERVAL = 30000;

wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req);
  console.log(`[${new Date().toISOString()}] New connection from ${clientIp}`);

  // Rate limit check before accepting connection
  const rateCheck = rateLimiter.checkRequest(clientIp);
  if (!rateCheck.allowed) {
    console.log(`⚠ Rate limited connection attempt from ${clientIp}`);
    ws.close(4029, `Rate limited. Try again in ${rateCheck.retryAfter} seconds.`);
    return;
  }

  // Register client IP for rate limiting
  core.setClientIp(ws, clientIp);

  // Set up ping interval
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_INTERVAL);
  pingIntervals.set(ws, pingInterval);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      core.handleMessage(ws, message);
    } catch (error) {
      console.error('Failed to parse message:', error);
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    const interval = pingIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      pingIntervals.delete(ws);
    }
    core.handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    const interval = pingIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      pingIntervals.delete(ws);
    }
    core.handleDisconnect(ws);
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
