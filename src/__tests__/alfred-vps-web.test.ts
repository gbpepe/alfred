import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAlfredAgentsConfig, normalizeRoleId } from '../alfred/agents-config.js'
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
    expect(Array.isArray(data['roles'])).toBe(true)
    expect(data['system']).toBeTruthy()
  })

  it('rejects unauthenticated POST /api/vps/roles', async () => {
    const { ctx, getStatus } = mockReqRes('POST', '/api/vps/roles', {
      role: 'szakmunkas',
      provider: 'xai',
      model: 'grok-3-mini',
    })
    expect(await tryHandleAlfredVps(ctx)).toBe(true)
    expect(getStatus()).toBe(403)
  })

  it('validates provider on authenticated POST /api/vps/roles', async () => {
    const { ctx, getStatus, getJson } = mockReqRes('POST', '/api/vps/roles', {
      role: 'szakmunkas',
      provider: 'bogus-provider',
      model: 'grok-3-mini',
    })
    ctx.auth = { kind: 'session', user: 'gbpepe' }
    expect(await tryHandleAlfredVps(ctx)).toBe(true)
    expect(getStatus()).toBe(400)
    expect(getJson()['error']).toMatch(/Unsupported provider/)
  })
})

describe('alfred role-based model routing', () => {
  it('normalizes accented role aliases and resolves agent provider/model from role', () => {
    expect(normalizeRoleId('tervező')).toBe('tervezo')
    expect(normalizeRoleId('szakmunkás')).toBe('szakmunkas')
    expect(normalizeRoleId('segédmunkás')).toBe('segedmunkas')

    const dir = mkdtempSync(join(tmpdir(), 'alfred-roles-'))
    try {
      mkdirSync(join(dir, 'config'), { recursive: true })
      writeFileSync(
        join(dir, 'config', 'agents.json'),
        JSON.stringify({
          version: 1,
          global: { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', dailyBudgetUsd: 10 },
          roles: {
            tervezo: { label: 'Tervező', provider: 'xai', model: 'grok-3' },
            segedmunkas: { label: 'Segédmunkás', provider: 'gemini', model: 'gemini-2.0-flash' },
          },
          agents: [
            { id: 'planner', role: 'tervező', tools: ['fs_read'] },
            { id: 'helper', role: 'segédmunkás', tools: [] },
            { id: 'custom', role: 'tervezo', provider: 'openai', model: 'gpt-4o', tools: [] },
          ],
        }),
      )
      const cfg = loadAlfredAgentsConfig({ projectRoot: dir, env: {} })
      expect(cfg.agents.find((a) => a.id === 'planner')).toMatchObject({
        role: 'tervezo',
        provider: 'xai',
        model: 'grok-3',
      })
      expect(cfg.agents.find((a) => a.id === 'helper')).toMatchObject({
        role: 'segedmunkas',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
      })
      expect(cfg.agents.find((a) => a.id === 'custom')).toMatchObject({
        role: 'tervezo',
        provider: 'openai',
        model: 'gpt-4o',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
