/**
 * Bookkeeping test: drives SignalingCore with fake sockets and checks that a
 * disconnect removes the socket from every per-socket map. A socket that stays
 * in a map stays in memory, and the server sees tens of thousands of short
 * connections a day. Runs against the build in dist/, like the protocol test.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import type { SignalingCore as Core } from '../src/signaling-core.ts'

const ROOT = path.join(import.meta.dirname, '..')
const { SignalingCore } = (await import(
  pathToFileURL(path.join(ROOT, 'dist', 'signaling-core.js')).href
)) as typeof import('../src/signaling-core.ts')

type Msg = Record<string, unknown> & { type: string }

interface FakeSocket {
  ip: string
  sent: Msg[]
  closedWith?: { code: number; reason: string }
}

let core: Core<FakeSocket>
let nextIp = 0

function connect(): FakeSocket {
  nextIp++
  const ws: FakeSocket = { ip: `192.0.2.${nextIp}`, sent: [] }
  core.setClientIp(ws, ws.ip)
  return ws
}

function assertForgotten(): void {
  assert.equal(core.wsClientIp.size, 0, 'wsClientIp still holds a socket')
  assert.equal(core.wsMetadata.size, 0, 'wsMetadata still holds a socket')
  assert.equal(core.servers.size, 0, 'servers still holds a socket')
  assert.equal(core.clients.size, 0, 'clients still holds a socket')
  assert.equal(core.pendingClients.size, 0, 'pendingClients still holds a socket')
}

beforeEach(() => {
  // The core starts a 5-minute rate limiter cleanup interval; mock it so the
  // test process can exit.
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  core = new SignalingCore<FakeSocket>({
    send: (ws, message) => ws.sent.push(JSON.parse(message) as Msg),
    close: (ws, code, reason) => {
      ws.closedWith = { code, reason }
    },
    log: () => {},
  })
})

afterEach(() => {
  mock.timers.reset()
})

describe('SignalingCore disconnect cleanup', () => {
  it('forgets a socket that closes without sending anything', () => {
    const ws = connect()
    core.handleDisconnect(ws)
    assertForgotten()
  })

  it('forgets a client whose remote ID is not online', () => {
    const ws = connect()
    core.handleMessage(ws, { type: 'connect-request', remoteId: 'MA-MISSING-1' })
    assert.equal(ws.sent.at(-1)?.type, 'error')
    core.handleDisconnect(ws)
    assertForgotten()
  })

  it('forgets a server socket replaced by a reconnect', () => {
    const oldWs = connect()
    core.handleMessage(oldWs, { type: 'register-server', remoteId: 'MA-TEST-0001' })
    const newWs = connect()
    core.handleMessage(newWs, { type: 'register-server', remoteId: 'MA-TEST-0001' })
    assert.deepEqual(oldWs.closedWith, { code: 4000, reason: 'Replaced by new connection' })

    core.handleDisconnect(oldWs)
    assert.equal(core.servers.get('MA-TEST-0001')?.ws, newWs)
    core.handleDisconnect(newWs)
    assertForgotten()
  })

  it('forgets a registered server and its client session', () => {
    const server = connect()
    core.handleMessage(server, { type: 'register-server', remoteId: 'MA-TEST-0002' })
    const client = connect()
    core.handleMessage(client, { type: 'connect-request', remoteId: 'MA-TEST-0002' })
    const sessionId = server.sent.at(-1)?.sessionId as string
    core.handleMessage(server, { type: 'session-ready', sessionId, iceServers: [] })
    assert.equal(client.sent.at(-1)?.type, 'connected')

    core.handleDisconnect(client)
    core.handleDisconnect(server)
    assertForgotten()
  })

  it('handles the error-then-close double disconnect of a server', () => {
    const ws = connect()
    core.handleMessage(ws, { type: 'register-server', remoteId: 'MA-TEST-0003' })
    core.handleDisconnect(ws)
    core.handleDisconnect(ws)
    assertForgotten()
  })
})
