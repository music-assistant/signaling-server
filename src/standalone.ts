/**
 * Music Assistant Signaling Server
 *
 * Run with: node dist/standalone.js
 *
 * Default port: 8787
 * Custom port: PORT=9000 node dist/standalone.js
 *
 * This entry point owns the HTTP and WebSocket plumbing; SignalingCore holds
 * all the business logic.
 */

import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { RateLimiter, SignalingCore, SignalingMessage } from './signaling-core.js'

const { version } = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

const PORT = Number(process.env.PORT) || 8787
const GIT_COMMIT = process.env.GIT_COMMIT || 'dev'
const PING_INTERVAL = 30000

// Initialize rate limiter
const rateLimiter = new RateLimiter({
  windowMs: 60000,
  maxRequests: 100,
  maxFailedLookups: 10,
  failedLookupWindowMs: 60000,
  baseBlockDurationMs: 60000,
})

// Initialize the shared signaling core
const core = new SignalingCore<WebSocket>({
  send: (ws, message) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      }
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  },
  close: (ws, code, reason) => {
    try {
      ws.close(code, reason)
    } catch (error) {
      console.error('Failed to close WebSocket:', error)
    }
  },
  log: (message) => console.log(message),
  rateLimiter,
})

// Map of WebSocket -> ping interval
const pingIntervals = new Map<WebSocket, ReturnType<typeof setInterval>>()

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function getClientIp(req: http.IncomingMessage): string {
  return (
    headerValue(req.headers['x-forwarded-for'])?.split(',')[0]?.trim() ||
    headerValue(req.headers['x-real-ip']) ||
    req.socket?.remoteAddress ||
    'unknown'
  )
}

function clearPing(ws: WebSocket): void {
  const interval = pingIntervals.get(ws)
  if (interval) {
    clearInterval(interval)
    pingIntervals.delete(ws)
  }
}

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const clientIp = getClientIp(req)

  if (req.url === '/health') {
    const stats = core.getStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version,
        commit: GIT_COMMIT,
        ...stats,
      }),
    )
  } else if (req.url?.startsWith('/api/check/')) {
    // Rate limit the check endpoint
    const rateCheck = rateLimiter.checkRequest(clientIp)
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rateCheck.retryAfter),
      })
      res.end(JSON.stringify({ error: 'Rate limited', retryAfter: rateCheck.retryAfter }))
      return
    }

    const remoteId = req.url.split('/').pop()?.toUpperCase() || ''
    const online = core.isOnline(remoteId)

    // Track failed lookups for brute force detection
    if (!online && clientIp !== 'unknown') {
      const blocked = rateLimiter.recordFailedLookup(clientIp)
      if (blocked) {
        console.log(`⚠ Blocked IP ${clientIp} for brute force on /check endpoint`)
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: 'Too many failed attempts. You have been temporarily blocked.' }),
        )
        return
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ online }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`Music Assistant Signaling Server

Status: Running
Version: ${version} (with ICE server relay support)
Connected servers: ${core.servers.size}
Connected clients: ${core.clients.size}
Pending clients: ${core.pendingClients.size}

Endpoints:
  WebSocket: ws://localhost:${PORT}/ws
  Health:    http://localhost:${PORT}/health
  Check:     http://localhost:${PORT}/api/check/:remoteId
`)
  }
})

// Create WebSocket server
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const clientIp = getClientIp(req)
  console.log(`[${new Date().toISOString()}] New connection from ${clientIp}`)

  // Rate limit check before accepting connection
  const rateCheck = rateLimiter.checkRequest(clientIp)
  if (!rateCheck.allowed) {
    console.log(`⚠ Rate limited connection attempt from ${clientIp}`)
    ws.close(4029, `Rate limited. Try again in ${rateCheck.retryAfter} seconds.`)
    return
  }

  // Register client IP for rate limiting
  core.setClientIp(ws, clientIp)

  // Track if we're waiting for a pong
  let isAlive = true

  // Handle pong responses (WebSocket protocol level)
  ws.on('pong', () => {
    isAlive = true
  })

  // Set up ping interval using WebSocket protocol pings (not JSON messages)
  // This properly detects dead connections when network is interrupted
  const pingInterval = setInterval(() => {
    if (!isAlive) {
      // No pong received since last ping - connection is dead
      console.log(
        `[${new Date().toISOString()}] Connection dead (no pong), terminating: ${clientIp}`,
      )
      ws.terminate()
      return
    }
    isAlive = false
    if (ws.readyState === WebSocket.OPEN) {
      // Send WebSocket protocol ping (handled automatically by ws library)
      ws.ping()
      // Also send application-level ping for backward compatibility
      ws.send(JSON.stringify({ type: 'ping' }))
    }
  }, PING_INTERVAL)
  pingIntervals.set(ws, pingInterval)

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString()) as SignalingMessage
      core.handleMessage(ws, message)
    } catch (error) {
      console.error('Failed to parse message:', error)
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }))
    }
  })

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(
      `[${new Date().toISOString()}] WebSocket closed: code=${code}, reason=${reason?.toString() || 'none'}, clientIp=${clientIp}`,
    )
    clearPing(ws)
    core.handleDisconnect(ws)
  })

  ws.on('error', (err: Error) => {
    console.error('WebSocket error:', err)
    clearPing(ws)
    core.handleDisconnect(ws)
  })
})

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Music Assistant Signaling Server v${version.padEnd(14)}║
║     (with ICE server relay support)                       ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  WebSocket URL:  ws://localhost:${PORT}/ws                   ║
║  Health Check:   http://localhost:${PORT}/health             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`)
})
