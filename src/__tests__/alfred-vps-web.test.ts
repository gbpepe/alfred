import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { tryHandleAlfredVps } from '../web/routes/alfred-vps.js'
import type { RouteContext } from '../web/routes/types.js'

function mockReqRes(method: string, path: string, body?: unknown): {
  ctx: RouteContext
  getStatus: () => number
  getJson: () => Record<string, unknown>
} {
  const req = new EventEmitter() as http.IncomingMessage
  req.method = method
  req.url = path
  req.headers = { 'content-type': 'application/json' }
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'))
      req.emit('end')
    })
  } else {
    queueMicrotask(() => req.emit('end'))
  }

  let status = 200
  let rawBody = ''
  const res = {
    writeHead(code: number) {
      status = code
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString()
      return this
    },
    setHeader() {
      return this
    },
  } as unknown as http.ServerResponse

  const url = new URL(`http://127.0.0.1:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url },
    getStatus: () => status,
    getJson: () => JSON.parse(rawBody || '{}') as Record<string, unknown>,
  }
}

describe('alfred-vps web routes', () => {
  it('returns false for unrelated paths', async () => {
    const { ctx } = mockReqRes('GET', '/api/kanban')
    expect(await tryHandleAlfredVps(ctx)).toBe(false)
  })

  it('rejects non-whitelisted systemd unit in /api/vps/logs', async () => {
    const { ctx, getStatus, getJson } = mockReqRes('GET', '/api/vps/logs?unit=ssh')
    expect(await tryHandleAlfredVps(ctx)).toBe(true)
    expect(getStatus()).toBe(400)
    expect(getJson()['error']).toMatch(/Unsupported systemd unit/)
  })

  it('rejects non-whitelisted action in /api/vps/ops', async () => {
    const { ctx, getStatus, getJson } = mockReqRes('POST', '/api/vps/ops', { action: 'rm-rf' })
    expect(await tryHandleAlfredVps(ctx)).toBe(true)
    expect(getStatus()).toBe(400)
    expect(getJson()['error']).toMatch(/Unsupported ops action/)
  })

  it('returns system + services payload on /api/vps/status', async () => {
    const { ctx, getStatus, getJson } = mockReqRes('GET', '/api/vps/status')
    expect(await tryHandleAlfredVps(ctx)).toBe(true)
    expect(getStatus()).toBe(200)
    const data = getJson()
    expect(data['ok']).toBe(true)
    expect(Array.isArray(data['services'])).toBe(true)
    expect(data['system']).toBeTruthy()
  })
})
