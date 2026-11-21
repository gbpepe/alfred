import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { getDb } from '../../db.js'
import { readEnvFile } from '../../env.js'
import { logger } from '../../logger.js'
import {
  ALLOWED_PROVIDERS,
  loadAlfredAgentsConfig,
  normalizeRoleId,
  type AlfredAgentDefinition,
  type AlfredProviderName,
} from '../../alfred/agents-config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { mayActAsOwner, OWNER_SESSION_REQUIRED } from './auth.js'
import {
  evaluateCircuitBreaker,
  resolveEffectiveTokenPrices,
} from '../../alfred/circuit-breaker.js'
import { runHybridAgentTurn, type ChatMessage } from '../../alfred/model-router.js'
import { resolveAlfredRuntimeEnv } from '../../alfred/runtime-env.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const execFileAsync = promisify(execFile)

async function readJsonBody<T>(req: RouteContext['req']): Promise<T> {
  const buf = await readBody(req)
  if (!buf || buf.length === 0) return {} as T
  return JSON.parse(buf.toString('utf-8')) as T
}

const ALLOWED_LOG_UNITS = new Set(['alfred-prod', 'alfred-ops', 'alfred-test', 'alfred-web'])
const ALLOWED_OPS_ACTIONS = new Set(['check-health', 'reload-test', 'teardown-test'])

interface VpsEnvSpec {
  id: 'prod' | 'ops' | 'test'
  label: string
  unit: string
  dir: string
  dbPath: string
}

function resolveVpsEnvSpecs(): VpsEnvSpec[] {
  const isLinuxSystemd = process.platform === 'linux' && existsSync('/opt/alfred-prod')
  if (isLinuxSystemd) {
    return [
      {
        id: 'prod',
        label: 'Production',
        unit: 'alfred-prod',
        dir: process.env['ALFRED_PROD_DIR'] || '/opt/alfred-prod',
        dbPath: process.env['ALFRED_PROD_DB_PATH'] || '/opt/alfred-prod/store/alfred-prod.db',
      },
      {
        id: 'ops',
        label: 'Ops',
        unit: 'alfred-ops',
        dir: process.env['ALFRED_OPS_DIR'] || '/opt/alfred-ops',
        dbPath: process.env['ALFRED_OPS_DB_PATH'] || '/opt/alfred-ops/store/alfred-ops.db',
      },
      {
        id: 'test',
        label: 'Staging / Test',
        unit: 'alfred-test',
        dir: process.env['ALFRED_TEST_DIR'] || '/opt/alfred-worktrees/alfred-test',
        dbPath: process.env['ALFRED_TEST_DB_PATH'] || '/opt/alfred-worktrees/alfred-test/store/alfred-test.db',
      },
    ]
  }
  const runtime = resolveAlfredRuntimeEnv()
  return [
    {
      id: 'prod',
      label: 'Local',
      unit: 'alfred-prod',
      dir: process.cwd(),
      dbPath: runtime.dbPath,
    },
  ]
}

function sanitizeOutput(text: string): string {
  return text
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
}

async function getUnitStatus(unit: string): Promise<string> {
  if (process.platform !== 'linux') return 'local'
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', unit], { timeout: 3000 })
    return stdout.trim() || 'unknown'
  } catch (err) {
    const out = (err as { stdout?: string }).stdout?.trim()
    return out || 'inactive'
  }
}

async function getGitSummary(dir: string): Promise<{ branch: string; sha: string } | null> {
  if (!existsSync(dir)) return null
  try {
    const [{ stdout: b }, { stdout: s }] = await Promise.all([
      execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 }),
      execFileAsync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 3000 }),
    ])
    return { branch: b.trim(), sha: s.trim() }
  } catch {
    return null
  }
}

function getSystemMetrics(): {
  hostname: string
  uptimeSec: number
  memTotalMb: number
  memUsedMb: number
  memAvailMb: number
  diskSummary: string | null
} {
  const totalBytes = os.totalmem()
  let availBytes = os.freemem()
  if (process.platform === 'linux' && existsSync('/proc/meminfo')) {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8')
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)
      if (match) availBytes = Number(match[1]) * 1024
    } catch { /* fallback to os.freemem */ }
  }
  const totalMb = Math.round(totalBytes / 1048576)
  const availMb = Math.round(availBytes / 1048576)
  return {
    hostname: os.hostname(),
    uptimeSec: Math.round(os.uptime()),
    memTotalMb: totalMb,
    memUsedMb: Math.max(0, totalMb - availMb),
    memAvailMb: availMb,
    diskSummary: null,
  }
}

async function getDiskSummary(): Promise<string | null> {
  if (process.platform !== 'linux') return null
  try {
    const { stdout } = await execFileAsync('df', ['-h', '/'], { timeout: 3000 })
    const lines = stdout.trim().split('\n')
    return lines[1]?.trim().replace(/\s+/g, ' ') ?? null
  } catch {
    return null
  }
}

function readAgentCostsForEnv(
  spec: VpsEnvSpec,
  agents: AlfredAgentDefinition[],
  globalDailyBudgetUsd: number,
): {
  globalSpendUsd: number
  globalBudgetUsd: number
  agents: Array<{
    id: string
    channelName: string
    provider: string
    model: string
    spendUsd: number
    dailyBudgetUsd: number
    allowed: boolean
  }>
} | null {
  if (!existsSync(spec.dbPath)) return null
  let db: Database.Database | null = null
  try {
    db = new Database(spec.dbPath, { readonly: true, fileMustExist: true })
    const prices = resolveEffectiveTokenPrices()
    let globalSpendUsd = 0
    const agentRows = agents.map((agent) => {
      const ev = evaluateCircuitBreaker({
        db: db!,
        agentId: agent.id,
        agentDailyLimitUsd: agent.dailyBudgetUsd,
        globalDailyLimitUsd: globalDailyBudgetUsd,
        tokenPrices: prices,
      })
      globalSpendUsd = ev.globalSpendUsd
      return {
        id: agent.id,
        channelName: agent.channelName,
        provider: agent.provider,
        model: agent.model,
        spendUsd: ev.agentSpendUsd,
        dailyBudgetUsd: ev.agentLimitUsd,
        allowed: ev.allowed,
      }
    })
    return {
      globalSpendUsd,
      globalBudgetUsd: globalDailyBudgetUsd,
      agents: agentRows,
    }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

function resolveEnvSpecById(envId: string): VpsEnvSpec | undefined {
  return resolveVpsEnvSpecs().find((s) => s.id === envId)
}

export async function tryHandleAlfredVps(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/vps/status' && method === 'GET') {
    const specs = resolveVpsEnvSpecs()
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const [services, disk] = await Promise.all([
      Promise.all(
        specs.map(async (s) => {
          const [active, git] = await Promise.all([getUnitStatus(s.unit), getGitSummary(s.dir)])
          const costs = readAgentCostsForEnv(s, cfg?.agents ?? [], cfg?.global.dailyBudgetUsd ?? 5)
          return {
            id: s.id,
            label: s.label,
            unit: s.unit,
            active,
            dirExists: existsSync(s.dir),
            git,
            costs,
          }
        }),
      ),
      getDiskSummary(),
    ])
    const sys = getSystemMetrics()
    sys.diskSummary = disk

    json(res, {
      ok: true,
      system: sys,
      services,
      roles: cfg ? Object.values(cfg.roles) : [],
      agents: (cfg?.agents ?? []).map((a) => ({
        id: a.id,
        role: a.role ?? null,
        channelName: a.channelName,
        provider: a.provider,
        model: a.model,
        dailyBudgetUsd: a.dailyBudgetUsd,
        tools: a.tools,
      })),
    })
    return true
  }

  if (path === '/api/vps/roles' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Updating role models requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ role?: string; provider?: string; model?: string }>(req)
    const roleId = typeof body?.role === 'string' ? normalizeRoleId(body.role) : null
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
    const model = typeof body?.model === 'string' ? body.model.trim() : ''
    if (!roleId) {
      json(res, { error: 'Unknown role. Allowed: tervezo, technikus, szakmunkas, segedmunkas' }, 400)
      return true
    }
    if (!ALLOWED_PROVIDERS.has(provider as AlfredProviderName)) {
      json(res, { error: `Unsupported provider "${provider}". Allowed: ${[...ALLOWED_PROVIDERS].join(', ')}` }, 400)
      return true
    }
    if (!model || model.length > 100) {
      json(res, { error: 'Valid model name is required' }, 400)
      return true
    }

    const targets = [
      process.env['ALFRED_AGENTS_CONFIG'] || join(process.cwd(), 'config', 'agents.json'),
      '/opt/alfred-prod/config/agents.json',
    ].filter((p, idx, arr) => arr.indexOf(p) === idx && existsSync(p))

    if (targets.length === 0) {
      json(res, { error: 'config/agents.json not found' }, 404)
      return true
    }

    for (const cfgPath of targets) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>
      const rolesObj = (parsed.roles && typeof parsed.roles === 'object' && !Array.isArray(parsed.roles))
        ? (parsed.roles as Record<string, Record<string, unknown>>)
        : {}
      const prev = rolesObj[roleId] ?? {}
      rolesObj[roleId] = {
        ...prev,
        provider,
        model,
      }
      parsed.roles = rolesObj
      atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
    }

    const env = { ...readEnvFile(), ...process.env }
    const updatedCfg = loadAlfredAgentsConfig({ env })
    json(res, { ok: true, roles: Object.values(updatedCfg.roles) })
    return true
  }

  if (path === '/api/vps/logs' && method === 'GET') {
    const unit = url.searchParams.get('unit') || 'alfred-prod'
    if (!ALLOWED_LOG_UNITS.has(unit)) {
      json(res, { error: 'Unsupported systemd unit' }, 400)
      return true
    }
    const rawLines = Number(url.searchParams.get('lines') || '50')
    const lines = Math.max(10, Math.min(200, Number.isFinite(rawLines) ? Math.floor(rawLines) : 50))
    if (process.platform !== 'linux') {
      json(res, { ok: true, unit, lines: 0, output: '(journalctl is only available on Linux VPS)' })
      return true
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        'journalctl',
        ['-u', unit, '-n', String(lines), '--no-pager'],
        { timeout: 5000 },
      )
      json(res, { ok: true, unit, output: sanitizeOutput(stdout || stderr || '(empty)') })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, unit, output: sanitizeOutput(msg) }, 500)
    }
    return true
  }

  if (path === '/api/vps/ops' && method === 'POST') {
    const body = await readJsonBody<{ action?: string }>(req)
    const action = (body?.action || '').trim()
    if (!ALLOWED_OPS_ACTIONS.has(action)) {
      json(res, { error: `Unsupported ops action: ${action}` }, 400)
      return true
    }
    const opsDir = process.env['ALFRED_OPS_DIR'] || '/opt/alfred-ops'
    const scriptPath = join(opsDir, 'deploy', `${action}.sh`)
    if (!existsSync(scriptPath)) {
      json(res, { error: `Deploy script not found: ${scriptPath}` }, 404)
      return true
    }
    try {
      const { stdout, stderr } = await execFileAsync('bash', [scriptPath], {
        cwd: opsDir,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      })
      json(res, {
        ok: true,
        action,
        output: sanitizeOutput([stdout, stderr].filter(Boolean).join('\n')),
      })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      json(
        res,
        {
          ok: false,
          action,
          output: sanitizeOutput([e.stdout, e.stderr, e.message].filter(Boolean).join('\n')),
        },
        500,
      )
    }
    return true
  }

  if (path === '/api/vps/conversations' && method === 'GET') {
    const envId = url.searchParams.get('env') || 'prod'
    const agentId = url.searchParams.get('agentId') || ''
    const rawLimit = Number(url.searchParams.get('limit') || '40')
    const limit = Math.max(5, Math.min(100, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 40))

    const spec = resolveEnvSpecById(envId)
    if (!spec || !existsSync(spec.dbPath)) {
      json(res, { ok: true, env: envId, messages: [] })
      return true
    }

    let db: Database.Database | null = null
    try {
      db = new Database(spec.dbPath, { readonly: true, fileMustExist: true })
      const sql = agentId
        ? `SELECT id, agent_id, chat_id, direction, text, ts, created_at, source, sender_name
           FROM conversation_log WHERE agent_id = ? ORDER BY id DESC LIMIT ?`
        : `SELECT id, agent_id, chat_id, direction, text, ts, created_at, source, sender_name
           FROM conversation_log ORDER BY id DESC LIMIT ?`
      const rows = agentId ? db.prepare(sql).all(agentId, limit) : db.prepare(sql).all(limit)
      json(res, { ok: true, env: envId, messages: (rows as unknown[]).reverse() })
    } catch (err) {
      logger.warn({ err, envId }, 'Failed to read VPS conversation_log')
      json(res, { ok: true, env: envId, messages: [] })
    } finally {
      db?.close()
    }
    return true
  }

  if (path === '/api/vps/chat' && method === 'POST') {
    const body = await readJsonBody<{ agentId?: string; message?: string; chatId?: string }>(req)
    const agentId = (body?.agentId || 'alfred-core').trim()
    const message = (body?.message || '').trim()
    const chatId = (body?.chatId || 'web-dashboard').trim()
    if (!message) {
      json(res, { error: 'Message is required' }, 400)
      return true
    }

    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const agent = cfg?.agents.find((a) => a.id === agentId)
    if (!cfg || !agent) {
      json(res, { error: `Unknown agent: ${agentId}` }, 404)
      return true
    }

    const db = getDb()
    const historyRows = db
      .prepare(
        `SELECT direction, text FROM conversation_log
         WHERE agent_id = ? AND chat_id = ?
         ORDER BY id DESC LIMIT 12`,
      )
      .all(agent.memoryNamespace, chatId) as Array<{ direction: 'in' | 'out'; text: string }>
    const history: ChatMessage[] = historyRows.reverse().map((r) => ({
      role: r.direction === 'in' ? 'user' : 'assistant',
      content: r.text,
    }))

    const nowSec = Math.floor(Date.now() / 1000)
    const tsIso = new Date(nowSec * 1000).toISOString()
    db.prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at, source, sender_name)
       VALUES (?, ?, 'in', ?, ?, ?, ?, 'web', ?)`,
    ).run(agent.memoryNamespace, chatId, `web-in-${Date.now()}`, message, tsIso, nowSec, ctx.auth?.user ?? 'owner')

    const outcome = await runHybridAgentTurn({
      db,
      agent,
      globalDailyBudgetUsd: cfg.global.dailyBudgetUsd,
      userMessage: message,
      conversationHistory: history,
      sessionId: `web:${agent.id}:${chatId}`,
      chatId,
      env,
      nowSec,
    })

    if (!outcome.ok) {
      json(res, { ok: false, error: outcome.discordMessage }, 429)
      return true
    }

    const outSec = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at, source, sender_name)
       VALUES (?, ?, 'out', ?, ?, ?, ?, 'web', ?)`,
    ).run(
      agent.memoryNamespace,
      chatId,
      `web-out-${Date.now()}`,
      outcome.replyText,
      new Date(outSec * 1000).toISOString(),
      outSec,
      agent.id,
    )

    json(res, {
      ok: true,
      agentId: agent.id,
      replyText: outcome.replyText,
      provider: outcome.provider,
      model: outcome.model,
      totalUsage: outcome.totalUsage,
      toolCallsExecuted: outcome.toolCallsExecuted.map((t) => ({ name: t.name })),
    })
    return true
  }

  return false
}
