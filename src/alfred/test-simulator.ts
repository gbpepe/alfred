import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import {
  ALLOWED_PROVIDERS,
  normalizeRoleId,
  resolveGlobalAllowedUserIds,
  type AlfredAgentsConfig,
  type AlfredProviderName,
} from './agents-config.js'
import { evaluateCircuitBreaker, resolveEffectiveTokenPrices } from './circuit-breaker.js'
import { handleAlfredDiscordMessage } from './discord-adapter.js'

export interface TestSimulatorOptions {
  db: Database.Database
  getAgentsConfig: () => AlfredAgentsConfig
  reloadAgentsConfig: () => AlfredAgentsConfig
  env: Record<string, string | undefined>
  port?: number
  host?: string
  projectRoot?: string
}

function sendJson(res: http.ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readSimJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const c of req) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  return raw ? (JSON.parse(raw) as T) : ({} as T)
}

function effectiveSimChannelId(agentId: string, discordChannelId: string): string {
  const clean = discordChannelId.trim()
  if (clean && !clean.startsWith('${')) return clean
  return `sim-${agentId}`
}

export function startTestSimulatorServer(opts: TestSimulatorOptions): http.Server {
  const port = opts.port ?? 3421
  const host = opts.host ?? '127.0.0.1'
  const rootDir = opts.projectRoot ?? process.cwd()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`)
    const path = url.pathname
    const method = req.method || 'GET'

    try {
      if (path === '/status' && method === 'GET') {
        const cfg = opts.getAgentsConfig()
        const prices = resolveEffectiveTokenPrices()
        let globalSpendUsd = 0
        const agents = cfg.agents.map((a) => {
          const ev = evaluateCircuitBreaker({
            db: opts.db,
            agentId: a.id,
            agentDailyLimitUsd: a.dailyBudgetUsd,
            globalDailyLimitUsd: cfg.global.dailyBudgetUsd,
            tokenPrices: prices,
          })
          globalSpendUsd = ev.globalSpendUsd
          return {
            id: a.id,
            displayName: a.displayName,
            channelName: a.channelName,
            channelId: effectiveSimChannelId(a.id, a.discordChannelId),
            role: a.role ?? null,
            provider: a.provider,
            model: a.model,
            tools: a.tools,
            dailyBudgetUsd: ev.agentLimitUsd,
            spendUsd: ev.agentSpendUsd,
          }
        })
        sendJson(res, {
          ok: true,
          mode: 'test',
          globalSpendUsd,
          globalBudgetUsd: cfg.global.dailyBudgetUsd,
          roles: Object.values(cfg.roles),
          agents,
        })
        return
      }

      if (path === '/messages' && method === 'GET') {
        const agentId = (url.searchParams.get('agentId') || '').trim()
        const limit = Math.max(5, Math.min(100, Number(url.searchParams.get('limit') || '50') || 50))
        const cfg = opts.getAgentsConfig()
        const agent = cfg.agents.find((a) => a.id === agentId) ?? cfg.agents[0]
        if (!agent) {
          sendJson(res, { ok: true, messages: [] })
          return
        }
        const rows = opts.db
          .prepare(
            `SELECT id, agent_id, chat_id, direction, text, ts, created_at, source, sender_name
             FROM conversation_log
             WHERE agent_id = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(agent.memoryNamespace, limit)
        sendJson(res, { ok: true, agentId: agent.id, messages: (rows as unknown[]).reverse() })
        return
      }

      if (path === '/send' && method === 'POST') {
        const body = await readSimJsonBody<{ agentId?: string; content?: string; username?: string }>(req)
        const agentId = (body.agentId || '').trim()
        const content = (body.content || '').trim()
        if (!content) {
          sendJson(res, { error: 'content is required' }, 400)
          return
        }
        const cfg = opts.getAgentsConfig()
        const baseAgent = cfg.agents.find((a) => a.id === agentId) ?? cfg.agents[0]
        if (!baseAgent) {
          sendJson(res, { error: `Unknown agent: ${agentId}` }, 404)
          return
        }

        const channelId = effectiveSimChannelId(baseAgent.id, baseAgent.discordChannelId)
        const simCfg: AlfredAgentsConfig = {
          ...cfg,
          agents: cfg.agents.map((a) => ({
            ...a,
            discordChannelId: effectiveSimChannelId(a.id, a.discordChannelId),
          })),
        }
        const globalUsers = resolveGlobalAllowedUserIds(opts.env)
        const simUserId = baseAgent.allowedUserIds[0] ?? globalUsers[0] ?? 'sim-owner'
        const chunks: string[] = []

        const result = await handleAlfredDiscordMessage({
          db: opts.db,
          agentsConfig: simCfg,
          env: opts.env,
          message: {
            channelId,
            userId: simUserId,
            username: body.username || 'Tester',
            messageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            content,
          },
          sendToDiscord: async (_ch, chunk) => {
            chunks.push(chunk)
          },
        })

        sendJson(res, {
          ok: true,
          status: result.status,
          agentId: baseAgent.id,
          channelName: baseAgent.channelName,
          chunks,
          replyText: chunks.join('\n'),
        })
        return
      }

      if (path === '/roles' && method === 'POST') {
        const body = await readSimJsonBody<{ role?: string; provider?: string; model?: string }>(req)
        const roleId = typeof body.role === 'string' ? normalizeRoleId(body.role) : null
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (!roleId) {
          sendJson(res, { error: 'Unknown role' }, 400)
          return
        }
        if (!ALLOWED_PROVIDERS.has(provider as AlfredProviderName)) {
          sendJson(res, { error: `Unsupported provider: ${provider}` }, 400)
          return
        }
        if (!model) {
          sendJson(res, { error: 'model is required' }, 400)
          return
        }
        const cfgPath = join(rootDir, 'config', 'agents.json')
        if (!existsSync(cfgPath)) {
          sendJson(res, { error: 'config/agents.json not found' }, 404)
          return
        }
        const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>
        const rolesObj = (parsed.roles && typeof parsed.roles === 'object' && !Array.isArray(parsed.roles))
          ? (parsed.roles as Record<string, Record<string, unknown>>)
          : {}
        rolesObj[roleId] = { ...(rolesObj[roleId] ?? {}), provider, model }
        parsed.roles = rolesObj
        atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
        const reloaded = opts.reloadAgentsConfig()
        sendJson(res, { ok: true, roles: Object.values(reloaded.roles) })
        return
      }

      sendJson(res, { error: 'Not found' }, 404)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err: msg, path, method }, 'Test simulator request failed')
      sendJson(res, { error: msg }, 500)
    }
  })

  server.listen(port, host, () => {
    logger.info({ host, port }, 'Alfred Test Simulator HTTP server listening')
  })

  return server
}
