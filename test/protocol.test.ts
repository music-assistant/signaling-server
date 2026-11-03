/**
 * Protocol test: starts the built server on a spare port and drives every
 * message type the MA server and the PWA exchange, plus the HTTP endpoints
 * and the rate limiter. Expected responses are the ones the production
 * server has been sending since v2.0.1; change them only with a protocol
 * change on both ends.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const PORT = Number(process.env.TEST_PORT) || 18787
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.join(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string
}

type Msg = Record<string, unknown> & { type: string }

class Peer {
  private queue: Msg[] = []
  private waiters: Array<(m: Msg | null) => void> = []
  closed: Promise<{ code: number; reason: string }>
  private ws: WebSocket

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.closed = new Promise((resolve) => {
      ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason })
    })
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Msg
      const waiter = this.waiters.shift()
      if (waiter) waiter(msg)
      else this.queue.push(msg)
    }
  }

  static connect(): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
      ws.onopen = () => resolve(new Peer(ws))
      ws.onerror = () => reject(new Error('websocket connect failed'))
    })
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg))
  }

  sendRaw(data: string): void {
    this.ws.send(data)
  }

  next(timeoutMs = 2000): Promise<Msg | null> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (m: Msg | null): void => {
        clearTimeout(timer)
        resolve(m)
      }
      this.waiters.push(waiter)
    })
  }

  async expect(expected: object, timeoutMs?: number): Promise<Msg> {
    const msg = await this.next(timeoutMs)
    assert.ok(msg, `expected ${JSON.stringify(expected)}, got nothing`)
    assert.deepEqual(msg, expected)
    return msg
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch {
      // not up yet
    }
    await sleep(100)
  }
  throw new Error('server did not become healthy')
}

let server: ChildProcess

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'dist', 'standalone.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })
  await waitForHealth()
})

after(() => {
  server.kill()
})

describe('HTTP endpoints', () => {
  it('serves /health with CORS headers', async () => {
    const r = await fetch(`${BASE}/health`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/json')
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    const body = (await r.json()) as Record<string, unknown>
    assert.equal(body.status, 'ok')
    assert.equal(body.version, version)
    assert.equal(body.servers, 0)
    assert.equal(body.clients, 0)
    assert.equal(body.pendingClients, 0)
    assert.deepEqual(body.rateLimiter, { trackedIps: 0, blockedIps: 0, failedLookupTracked: 0 })
  })

  it('answers CORS preflight', async () => {
    const r = await fetch(`${BASE}/health`, { method: 'OPTIONS' })
    assert.equal(r.status, 204)
    assert.equal(r.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
    assert.equal(r.headers.get('access-control-allow-headers'), 'Content-Type')
  })

  it('serves the status page for any other path', async () => {
    const r = await fetch(`${BASE}/anything`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'text/plain')
    assert.match(await r.text(), /Music Assistant Signaling Server/)
  })

  it('reports unknown remote IDs as offline', async () => {
    const r = await fetch(`${BASE}/api/check/MA-NOPE-0001`)
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { online: false })
  })
})

describe('WebSocket validation', () => {
  it('rejects bad input with the documented errors', async () => {
    const probe = await Peer.connect()
    probe.sendRaw('not json')
    await probe.expect({ type: 'error', error: 'Invalid message format' })
    probe.send({ type: 'bogus' })
    await probe.expect({ type: 'error', error: 'Unknown message type: bogus' })
    probe.send({ type: 'ping' })
    await probe.expect({ type: 'pong' })
    probe.send({ type: 'pong' })
    assert.equal(await probe.next(300), null)
    probe.send({ type: 'register-server' })
    await probe.expect({ type: 'error', error: 'Remote ID required' })
    probe.send({ type: 'offer', data: {} })
    await probe.expect({ type: 'error', error: 'Not registered' })
    probe.send({ type: 'session-ready' })
    await probe.expect({ type: 'error', error: 'Session ID required' })
    probe.send({ type: 'connect-request' })
    await probe.expect({ type: 'error', error: 'Remote ID required' })
    probe.close(1000, 'bye')
    assert.deepEqual(await probe.closed, { code: 1000, reason: 'bye' })
  })
})

describe('Signaling session', () => {
  it('brokers a full MA server / PWA client session', async () => {
    const maServer = await Peer.connect()
    maServer.send({
      type: 'register-server',
      remoteId: 'ma-test-abcd',
      iceServers: [{ urls: 'stun:a' }],
    })
    await maServer.expect({ type: 'registered', remoteId: 'MA-TEST-ABCD' })
    // Re-registering on the same socket refreshes the cached ICE servers.
    maServer.send({
      type: 'register-server',
      remoteId: 'MA-TEST-ABCD',
      iceServers: [{ urls: 'stun:b' }],
    })
    await maServer.expect({ type: 'registered', remoteId: 'MA-TEST-ABCD' })

    const check = await fetch(`${BASE}/api/check/ma-test-abcd`)
    assert.deepEqual(await check.json(), { online: true })

    maServer.send({ type: 'answer', data: {} })
    await maServer.expect({ type: 'error', error: 'Session ID required' })
    maServer.send({ type: 'answer', sessionId: 'nosuch', data: {} })
    await maServer.expect({ type: 'error', error: 'Client not found' })

    const client = await Peer.connect()
    client.send({ type: 'connect-request', remoteId: 'MA-MISSING-1' })
    await client.expect({
      type: 'error',
      error:
        'Server not found. Make sure your Music Assistant server is running and has Remote Access enabled.',
    })

    client.send({ type: 'connect-request', remoteId: 'ma-test-abcd' })
    const connected = await maServer.next()
    assert.ok(connected)
    assert.equal(connected.type, 'client-connected')
    const sessionId = connected.sessionId as string
    assert.match(sessionId, /^[A-Za-z0-9_-]+$/)

    let health = (await (await fetch(`${BASE}/health`)).json()) as Record<string, unknown>
    assert.equal(health.pendingClients, 1)

    const fresh = [{ urls: 'turn:fresh', username: 'u', credential: 'c' }]
    maServer.send({ type: 'session-ready', sessionId, iceServers: fresh })
    await client.expect({
      type: 'connected',
      remoteId: 'MA-TEST-ABCD',
      sessionId,
      iceServers: fresh,
    })

    health = (await (await fetch(`${BASE}/health`)).json()) as Record<string, unknown>
    assert.equal(health.servers, 1)
    assert.equal(health.clients, 1)
    assert.equal(health.pendingClients, 0)

    client.send({ type: 'offer', data: { sdp: 'offer-sdp' } })
    await maServer.expect({ type: 'offer', data: { sdp: 'offer-sdp' }, sessionId })
    maServer.send({ type: 'answer', sessionId, data: { sdp: 'answer-sdp' } })
    await client.expect({ type: 'answer', sessionId, data: { sdp: 'answer-sdp' } })
    client.send({ type: 'ice-candidate', data: { candidate: 'c1' } })
    await maServer.expect({ type: 'ice-candidate', data: { candidate: 'c1' }, sessionId })
    maServer.send({ type: 'ice-candidate', sessionId, data: { candidate: 'c2' } })
    await client.expect({ type: 'ice-candidate', sessionId, data: { candidate: 'c2' } })
    // A late session-ready for an established session is ignored.
    maServer.send({ type: 'session-ready', sessionId })
    assert.equal(await maServer.next(300), null)

    // A client whose server never answers session-ready gets the cached ICE
    // servers after the 10 s fallback.
    const client2 = await Peer.connect()
    client2.send({ type: 'connect-request', remoteId: 'MA-TEST-ABCD' })
    const pending2 = await maServer.next()
    assert.ok(pending2)
    assert.equal(pending2.type, 'client-connected')
    await client2.expect(
      {
        type: 'connected',
        remoteId: 'MA-TEST-ABCD',
        sessionId: pending2.sessionId,
        iceServers: [{ urls: 'stun:b' }],
      },
      12000,
    )

    // A new socket registering the same remote ID replaces the old one and
    // takes over its sessions.
    const maServer2 = await Peer.connect()
    maServer2.send({ type: 'register-server', remoteId: 'MA-TEST-ABCD', iceServers: [] })
    await maServer2.expect({ type: 'registered', remoteId: 'MA-TEST-ABCD' })
    assert.deepEqual(await maServer.closed, { code: 4000, reason: 'Replaced by new connection' })
    client.send({ type: 'offer', data: { sdp: 'to-new-server' } })
    await maServer2.expect({ type: 'offer', data: { sdp: 'to-new-server' }, sessionId })

    // Disconnects are relayed to the other side.
    client.close(1000, 'client leaves')
    await maServer2.expect({ type: 'client-disconnected', sessionId })
    maServer2.close(1000, 'server leaves')
    await client2.expect({ type: 'peer-disconnected' })
    client2.close(1000, 'done')

    await sleep(200)
    const after = await fetch(`${BASE}/api/check/MA-TEST-ABCD`)
    assert.deepEqual(await after.json(), { online: false })
  })

  it('sends an application-level ping every 30 s', async () => {
    const idle = await Peer.connect()
    await idle.expect({ type: 'ping' }, 32000)
    idle.close(1000, 'done')
  })
})

describe('Rate limiting', () => {
  // Runs last: it blocks the test client's IP for several minutes.
  it('blocks brute-force lookups over HTTP and WebSocket', async () => {
    let blockedAt = -1
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${BASE}/api/check/MA-BRUTE-${i}`)
      if (r.status === 429) {
        assert.deepEqual(await r.json(), {
          error: 'Too many failed attempts. You have been temporarily blocked.',
        })
        blockedAt = i
        break
      }
      assert.deepEqual(await r.json(), { online: false })
    }
    assert.ok(blockedAt >= 0, 'never blocked')

    const peer = await Peer.connect()
    peer.send({ type: 'connect-request', remoteId: 'MA-BRUTE-WS' })
    const closed = await peer.closed
    assert.equal(closed.code, 4029)
    assert.match(closed.reason, /^Rate limited\. Try again in \d+ seconds\.$/)

    const health = (await (await fetch(`${BASE}/health`)).json()) as {
      rateLimiter: { blockedIps: number }
    }
    assert.equal(health.rateLimiter.blockedIps, 1)
  })
})
