import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { getDb } from '../../db.js'
import { readEnvFile } from '../../env.js'
import { parseEnvContent } from '../../env-parse.js'
import { logger } from '../../logger.js'
import {
  ALLOWED_PROVIDERS,
  CANONICAL_TOOLS,
  loadAlfredAgentsConfig,
  normalizeRoleId,
  type AllowedToolName,
  type AlfredAgentDefinition,
  type AlfredProviderName,
} from '../../alfred/agents-config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { mayActAsOwner, OWNER_SESSION_REQUIRED } from './auth.js'
import {
  evaluateCircuitBreaker,
  resolveEffectiveTokenPrices,
} from '../../alfred/circuit-breaker.js'
import {
  cancelCliLogin,
  CliManagerValidationError,
  getCliInventory,
  getCliLoginStatus,
  getCliQuota,
  installOrUpdateCli,
  logoutCli,
  removeCli,
  saveCliCredentials,
  startCliLogin,
  submitCliLoginCode,
  testCliConnection,
} from '../../alfred/cli-manager.js'
import { getCliQueueStats } from '../../alfred/cli-runner.js'
import {
  callDeepSeekProvider,
  callOpenAiCompatibleProvider,
  callVertexEuProvider,
  runHybridAgentTurn,
  type ChatMessage,
} from '../../alfred/model-router.js'
import { resolveAlfredRuntimeEnv } from '../../alfred/runtime-env.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const execFileAsync = promisify(execFile)

async function readJsonBody<T>(req: RouteContext['req'], maxBytes?: number): Promise<T> {
  const buf = await readBody(req, maxBytes ? { maxBytes } : {})
  if (!buf || buf.length === 0) return {} as T
  return JSON.parse(buf.toString('utf-8')) as T
}

const ALLOWED_LOG_UNITS = new Set(['alfred-prod', 'alfred-ops', 'alfred-test', 'alfred-web'])
const ALLOWED_OPS_ACTIONS = new Set(['check-health', 'spinup-test', 'reload-test', 'teardown-test'])
const SAFE_BRANCH_RE = /^((feat|fix)\/(self|core)-[a-z0-9._/-]{0,79}|core-[a-z0-9._/-]{1,79})$/

function validateOpsBranch(branch: string): boolean {
  if (!SAFE_BRANCH_RE.test(branch)) return false
  if (branch.includes('..') || branch.includes('//') || branch.startsWith('-') || branch.endsWith('.') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return false
  }
  return true
}

async function listMultiBranchTests(includeAccessToken = false): Promise<Array<{
  slug: string
  branch: string
  host: string
  accessUrl: string
  webPort: number
  simPort: number
  active: string
  webActive: string
}>> {
  const worktreeBase = process.env['ALFRED_WORKTREE_BASE'] || '/opt/alfred-worktrees'
  if (process.platform !== 'linux' || !existsSync(worktreeBase)) return []
  const entries = readdirSync(worktreeBase, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('alfred-test-'))
  const results = await Promise.all(
    entries.map(async (d) => {
      const worktreeDir = join(worktreeBase, d.name)
      const portsPath = join(worktreeDir, '.env.ports')
      if (!existsSync(portsPath)) return null
      let vars: Record<string, string> = {}
      try {
        vars = parseEnvContent(readFileSync(portsPath, 'utf-8'))
      } catch {
        vars = {}
      }
      const slug = vars['ALFRED_TEST_SLUG'] || d.name.replace(/^alfred-test-/, '')
      let branch = vars['ALFRED_TEST_BRANCH'] || ''
      if (!branch) {
        const gitInfo = await getGitSummary(worktreeDir)
        branch = gitInfo?.branch || slug
      }
      const host = vars['ALFRED_TEST_HOST'] || `${slug}-test-alfred.princicol.co.uk`
      let accessUrl = `https://${host}/#vps`
      if (includeAccessToken) {
        const tokPath = join(worktreeDir, 'store', '.dashboard-token')
        if (existsSync(tokPath)) {
          try {
            const tok = readFileSync(tokPath, 'utf-8').trim()
            if (tok) {
              accessUrl = `https://${host}/?token=${encodeURIComponent(tok)}#vps`
            }
          } catch { /* ignore unreadable token file */ }
        }
      }
      const webPort = Number(vars['WEB_PORT'] || 0)
      const simPort = Number(vars['ALFRED_SIM_PORT'] || 0)
      const [active, webActive] = await Promise.all([
        getUnitStatus(`alfred-test@${slug}`),
        getUnitStatus(`alfred-test-web@${slug}`),
      ])
      return { slug, branch, host, accessUrl, webPort, simPort, active, webActive }
    }),
  )
  return results.filter((r): r is NonNullable<typeof r> => r !== null)
}

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

function resolveWritableAgentConfigPaths(): string[] {
  const primary = process.env['ALFRED_AGENTS_CONFIG'] || join(process.cwd(), 'config', 'agents.json')
  const candidates = process.env['ALFRED_ENV'] === 'test'
    ? [primary]
    : [primary, '/opt/alfred-prod/config/agents.json']
  return candidates.filter((p, idx, arr) => arr.indexOf(p) === idx && existsSync(p))
}

function resolveEnvSpecById(envId: string): VpsEnvSpec | undefined {
  return resolveVpsEnvSpecs().find((s) => s.id === envId)
}

function safeTokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

function authorizeAdminCliRequest(
  ctx: RouteContext,
  envMap: Record<string, string | undefined>,
): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  if (mayActAsOwner(ctx.auth, ctx.req) || (ctx.auth?.kind === 'token' && !ctx.auth.tokenAgent)) {
    return { ok: true }
  }

  const expectedToken = (envMap['DASHBOARD_TOKEN'] ?? process.env['DASHBOARD_TOKEN'] ?? '').trim()
  if (expectedToken) {
    const authHeader = typeof ctx.req.headers['authorization'] === 'string' ? ctx.req.headers['authorization'].trim() : ''
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader)
    const xDashToken = typeof ctx.req.headers['x-dashboard-token'] === 'string' ? ctx.req.headers['x-dashboard-token'].trim() : ''
    const provided = (bearerMatch?.[1] ?? xDashToken).trim()
    if (provided && safeTokenEquals(provided, expectedToken)) {
      return { ok: true }
    }
  }

  if (ctx.auth) {
    return { ok: false, status: 403, error: 'Forbidden: DASHBOARD_TOKEN or owner session required' }
  }
  return { ok: false, status: 401, error: 'Unauthorized: DASHBOARD_TOKEN or owner session required' }
}

export async function tryHandleAlfredVps(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/admin/overview' && method === 'GET') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    const specs = resolveVpsEnvSpecs()
    const targetSpec = specs.find((s) => s.id === 'prod') ?? specs[0]
    const cfg = loadAlfredAgentsConfig({ env, provisionWorkspaces: false })
    const diskSummary = await getDiskSummary()
    const sys = getSystemMetrics()
    sys.diskSummary = diskSummary
    const costs = targetSpec && cfg
      ? readAgentCostsForEnv(targetSpec, cfg.agents, cfg.global.dailyBudgetUsd)
      : null
    const spendByAgent = new Map<string, number>((costs?.agents ?? []).map((a) => [a.id, a.spendUsd]))

    json(res, {
      ok: true,
      system: sys,
      cliQueue: getCliQueueStats(),
      global: cfg
        ? {
            dailyBudgetUsd: cfg.global.dailyBudgetUsd,
            defaultProvider: cfg.global.defaultProvider,
            defaultModel: cfg.global.defaultModel,
            runtimeMode: cfg.global.runtimeMode,
          }
        : null,
      costs: costs ?? {
        globalSpendUsd: 0,
        globalBudgetUsd: cfg?.global.dailyBudgetUsd ?? 0,
        agents: [],
      },
      agents: (cfg?.agents ?? []).map((a) => ({
        id: a.id,
        displayName: a.displayName,
        channelName: a.channelName,
        role: a.role ?? null,
        provider: a.provider,
        model: a.model,
        fallback: a.fallback ?? null,
        cliTimeoutMs: a.cliTimeoutMs ?? null,
        dailyBudgetUsd: a.dailyBudgetUsd,
        spendUsd: spendByAgent.get(a.id) ?? 0,
        tools: a.tools,
      })),
    })
    return true
  }

  if (path === '/api/admin/clis' && method === 'GET') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    const clis = await getCliInventory({ env })
    json(res, { ok: true, clis })
    return true
  }

  const cliInstallMatch = /^\/api\/admin\/clis\/([^/]+)\/install$/.exec(path)
  if (cliInstallMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const result = await installOrUpdateCli(decodeURIComponent(cliInstallMatch[1]), { env })
      const clis = await getCliInventory({ env })
      json(res, { ok: true, result, clis })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliRemoveMatch = /^\/api\/admin\/clis\/([^/]+)\/remove$/.exec(path)
  if (cliRemoveMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const body = await readJsonBody<{ purgeAuth?: boolean }>(req).catch(() => ({ purgeAuth: false }))
      const result = await removeCli(decodeURIComponent(cliRemoveMatch[1]), {
        env,
        purgeAuth: Boolean(body?.purgeAuth),
      })
      const clis = await getCliInventory({ env })
      json(res, { ok: true, result, clis })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliAuthMatch = /^\/api\/admin\/clis\/([^/]+)\/auth$/.exec(path)
  if (cliAuthMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const body = await readJsonBody<{ token?: string; authJson?: string }>(req)
      const result = await saveCliCredentials(decodeURIComponent(cliAuthMatch[1]), {
        token: body?.token,
        authJson: body?.authJson,
      })
      const freshEnv = { ...readEnvFile(), ...process.env }
      const clis = await getCliInventory({ env: freshEnv })
      json(res, { ok: true, result, clis })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliLogoutMatch = /^\/api\/admin\/clis\/([^/]+)\/logout$/.exec(path)
  if (cliLogoutMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const result = await logoutCli(decodeURIComponent(cliLogoutMatch[1]))
      const freshEnv = { ...readEnvFile(), ...process.env }
      const clis = await getCliInventory({ env: freshEnv })
      json(res, { ok: true, result, clis })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliLoginStartMatch = /^\/api\/admin\/clis\/([^/]+)\/login\/start$/.exec(path)
  if (cliLoginStartMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const session = await startCliLogin(decodeURIComponent(cliLoginStartMatch[1]), { env })
      json(res, { ok: true, session })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliLoginStatusMatch = /^\/api\/admin\/clis\/([^/]+)\/login\/status$/.exec(path)
  if (cliLoginStatusMatch && method === 'GET') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const session = getCliLoginStatus(decodeURIComponent(cliLoginStatusMatch[1]))
      json(res, { ok: true, session })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliLoginCodeMatch = /^\/api\/admin\/clis\/([^/]+)\/login\/code$/.exec(path)
  if (cliLoginCodeMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const body = await readJsonBody<{ code?: string }>(req)
      const session = submitCliLoginCode(decodeURIComponent(cliLoginCodeMatch[1]), body?.code ?? '')
      json(res, { ok: true, session })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliLoginCancelMatch = /^\/api\/admin\/clis\/([^/]+)\/login\/cancel$/.exec(path)
  if (cliLoginCancelMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const session = cancelCliLogin(decodeURIComponent(cliLoginCancelMatch[1]))
      json(res, { ok: true, session })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliTestMatch = /^\/api\/admin\/clis\/([^/]+)\/test$/.exec(path)
  if (cliTestMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const result = await testCliConnection(decodeURIComponent(cliTestMatch[1]), { env })
      json(res, result, 200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const cliQuotaMatch = /^\/api\/admin\/clis\/([^/]+)\/quota$/.exec(path)
  if (cliQuotaMatch && method === 'GET') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    try {
      const result = await getCliQuota(decodeURIComponent(cliQuotaMatch[1]), { env })
      json(res, result, 200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { ok: false, error: msg }, err instanceof CliManagerValidationError ? 400 : 500)
    }
    return true
  }

  const apiProviderTestMatch = /^\/api\/admin\/providers\/([^/]+)\/test$/.exec(path)
  if (apiProviderTestMatch && method === 'POST') {
    const env = { ...readEnvFile(), ...process.env }
    const authCheck = authorizeAdminCliRequest(ctx, env)
    if (!authCheck.ok) {
      json(res, { ok: false, error: authCheck.error }, authCheck.status)
      return true
    }
    const provider = decodeURIComponent(apiProviderTestMatch[1]).trim().toLowerCase()
    const allowedApiProviders = new Set(['deepseek', 'openai', 'xai', 'gemini', 'vertex-eu'])
    if (!allowedApiProviders.has(provider)) {
      json(res, { ok: false, error: `Unsupported API provider: ${provider}` }, 400)
      return true
    }

    const startedAt = Date.now()
    const pingMessages: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly: OK' }]
    const fetchWithTimeout: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) })

    try {
      let model = ''
      let reply = ''
      if (provider === 'deepseek') {
        model = 'deepseek-chat'
        const r = await callDeepSeekProvider({ model, messages: pingMessages, tools: [], env, fetchImpl: fetchWithTimeout })
        reply = r.content
      } else if (provider === 'openai') {
        model = 'gpt-4.1-mini'
        const r = await callOpenAiCompatibleProvider({
          providerLabel: 'OpenAI',
          defaultBaseUrl: 'https://api.openai.com/v1',
          baseUrlEnvKey: 'OPENAI_BASE_URL',
          apiKeyEnvKey: 'OPENAI_API_KEY',
          model,
          messages: pingMessages,
          tools: [],
          env,
          fetchImpl: fetchWithTimeout,
        })
        reply = r.content
      } else if (provider === 'xai') {
        model = 'grok-3-mini'
        const r = await callOpenAiCompatibleProvider({
          providerLabel: 'xAI',
          defaultBaseUrl: 'https://api.x.ai/v1',
          baseUrlEnvKey: 'XAI_BASE_URL',
          apiKeyEnvKey: 'XAI_API_KEY',
          model,
          messages: pingMessages,
          tools: [],
          env,
          fetchImpl: fetchWithTimeout,
        })
        reply = r.content
      } else if (provider === 'gemini') {
        model = 'gemini-2.5-flash'
        const key = (env['GEMINI_API_KEY'] || '').trim()
        if (!key) throw new Error('GEMINI_API_KEY is missing from environment')
        const gRes = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
              generationConfig: { maxOutputTokens: 16 },
            }),
          },
        )
        const gText = await gRes.text()
        if (!gRes.ok) throw new Error(`Gemini HTTP ${gRes.status}: ${sanitizeOutput(gText).slice(0, 200)}`)
        const parsed = JSON.parse(gText) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        reply = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
      } else {
        model = 'gemini-2.5-flash'
        const r = await callVertexEuProvider({ model, messages: pingMessages, tools: [], env, fetchImpl: fetchWithTimeout })
        reply = r.content
      }

      json(res, {
        ok: true,
        provider,
        model,
        reply: sanitizeOutput(reply).trim().slice(0, 200),
        latencyMs: Date.now() - startedAt,
      })
    } catch (err) {
      json(
        res,
        {
          ok: false,
          provider,
          error: sanitizeOutput(err instanceof Error ? err.message : String(err)).slice(0, 300),
          latencyMs: Date.now() - startedAt,
        },
        200,
      )
    }
    return true
  }

  if (path === '/api/vps/status' && method === 'GET') {
    const specs = resolveVpsEnvSpecs()
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const includeTestTokens = mayActAsOwner(ctx.auth, req) || (ctx.auth?.kind === 'token' && !ctx.auth.tokenAgent)
    const [services, disk, multiTests] = await Promise.all([
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
      listMultiBranchTests(includeTestTokens),
    ])
    const sys = getSystemMetrics()
    sys.diskSummary = disk

    const rawAgentsOverride = new Set<string>()
    const rawAgentVoice = new Map<string, string>()
    try {
      const cfgFile = process.env['ALFRED_AGENTS_CONFIG'] || join(process.cwd(), 'config', 'agents.json')
      if (existsSync(cfgFile)) {
        const rawParsed = JSON.parse(readFileSync(cfgFile, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
        for (const entry of rawParsed.agents ?? []) {
          if (typeof entry.id === 'string' && (entry.provider !== undefined || entry.model !== undefined)) {
            rawAgentsOverride.add(entry.id)
          }
          if (typeof entry.id === 'string' && typeof entry.voice === 'string' && entry.voice.trim()) {
            rawAgentVoice.set(entry.id, entry.voice.trim())
          }
        }
      }
    } catch { /* ignore */ }

    json(res, {
      ok: true,
      system: sys,
      services,
      multiTests,
      global: cfg
        ? {
            dailyBudgetUsd: cfg.global.dailyBudgetUsd,
            defaultProvider: cfg.global.defaultProvider,
            defaultModel: cfg.global.defaultModel,
            workspacesRoot: cfg.global.workspacesRoot,
          }
        : null,
      roles: cfg ? Object.values(cfg.roles) : [],
      agents: (cfg?.agents ?? []).map((a) => ({
        id: a.id,
        displayName: a.displayName,
        role: a.role ?? null,
        hasOverride: rawAgentsOverride.has(a.id),
        channelName: a.channelName,
        provider: a.provider,
        model: a.model,
        dailyBudgetUsd: a.dailyBudgetUsd,
        tools: a.tools,
        skills: a.skills ?? [],
        voice: rawAgentVoice.get(a.id) ?? null,
        systemPrompt: a.systemPrompt ?? '',
        workspace: a.workspace,
        memoryNamespace: a.memoryNamespace,
        maxToolIterations: a.maxToolIterations ?? null,
        bashTimeoutMs: a.bashTimeoutMs ?? null,
        allowedUserIds: a.allowedUserIds,
        protectedPaths: a.protectedPaths ?? [],
        allowedBashCommands: a.allowedBashCommands ?? [],
      })),
    })
    return true
  }

  if (path === '/api/vps/global-config' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Updating global config requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{
      dailyBudgetUsd?: number | null
      defaultProvider?: string | null
      defaultModel?: string | null
      workspacesRoot?: string | null
    }>(req)
    const dailyBudgetUsd =
      typeof body?.dailyBudgetUsd === 'number' && Number.isFinite(body.dailyBudgetUsd)
        ? Math.round(body.dailyBudgetUsd * 100) / 100
        : null
    if (dailyBudgetUsd !== null && (dailyBudgetUsd < 0.5 || dailyBudgetUsd > 500)) {
      json(res, { error: 'dailyBudgetUsd must be between 0.5 and 500' }, 400)
      return true
    }
    const defaultProvider = typeof body?.defaultProvider === 'string' && body.defaultProvider.trim() ? body.defaultProvider.trim() : null
    if (defaultProvider && !ALLOWED_PROVIDERS.has(defaultProvider as AlfredProviderName)) {
      json(res, { error: `Unsupported provider "${defaultProvider}"` }, 400)
      return true
    }
    const defaultModel = typeof body?.defaultModel === 'string' && body.defaultModel.trim() ? body.defaultModel.trim().slice(0, 120) : null
    const workspacesRoot = typeof body?.workspacesRoot === 'string' && body.workspacesRoot.trim() ? body.workspacesRoot.trim().slice(0, 120) : null
    if (workspacesRoot && workspacesRoot.includes('..')) {
      json(res, { error: 'workspacesRoot cannot contain ".."' }, 400)
      return true
    }
    const targets = resolveWritableAgentConfigPaths()
    for (const cfgPath of targets) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { global?: Record<string, unknown> }
      parsed.global = parsed.global && typeof parsed.global === 'object' ? parsed.global : {}
      if (dailyBudgetUsd !== null) parsed.global.dailyBudgetUsd = dailyBudgetUsd
      if (defaultProvider) parsed.global.defaultProvider = defaultProvider
      if (defaultModel) parsed.global.defaultModel = defaultModel
      if (workspacesRoot) parsed.global.workspacesRoot = workspacesRoot
      atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
    }
    const env = { ...readEnvFile(), ...process.env }
    const updatedCfg = loadAlfredAgentsConfig({ env })
    json(res, { ok: true, global: updatedCfg.global })
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

    const targets = resolveWritableAgentConfigPaths()

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

  if (path === '/api/vps/agent-override' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Updating agent overrides requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{
      agentId?: string
      displayName?: string | null
      role?: string | null
      provider?: string | null
      model?: string | null
      dailyBudgetUsd?: number | null
      voice?: string | null
      tools?: string[] | null
      systemPrompt?: string | null
      workspace?: string | null
      memoryNamespace?: string | null
      maxToolIterations?: number | null
      bashTimeoutMs?: number | null
      allowedUserIds?: string[] | null
      protectedPaths?: string[] | null
      allowedBashCommands?: string[] | null
      restartServices?: boolean
    }>(req)
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) {
      json(res, { error: 'agentId is required' }, 400)
      return true
    }
    const displayName = typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim().slice(0, 60) : null
    const voiceVal = typeof body?.voice === 'string' ? body.voice.trim().slice(0, 40) : undefined
    let toolsVal: AllowedToolName[] | undefined
    if (Array.isArray(body?.tools)) {
      const seen = new Set<AllowedToolName>()
      for (const raw of body.tools) {
        const t = String(raw).trim() as AllowedToolName
        if (!CANONICAL_TOOLS.has(t)) {
          json(res, { error: `Unknown tool "${t}". Allowed: ${Array.from(CANONICAL_TOOLS).join(', ')}` }, 400)
          return true
        }
        seen.add(t)
      }
      toolsVal = Array.from(seen)
    }
    const systemPromptVal = typeof body?.systemPrompt === 'string' ? body.systemPrompt.trim().slice(0, 2000) : undefined
    const workspaceVal = typeof body?.workspace === 'string' && body.workspace.trim() ? body.workspace.trim().slice(0, 200) : undefined
    if (workspaceVal && workspaceVal.includes('..')) {
      json(res, { error: 'workspace cannot contain ".."' }, 400)
      return true
    }
    const memoryNsVal = typeof body?.memoryNamespace === 'string' && body.memoryNamespace.trim() ? body.memoryNamespace.trim().slice(0, 80) : undefined
    const hasMaxIter = body && Object.prototype.hasOwnProperty.call(body, 'maxToolIterations')
    const maxIterVal =
      typeof body?.maxToolIterations === 'number' && Number.isFinite(body.maxToolIterations)
        ? Math.floor(body.maxToolIterations)
        : null
    if (hasMaxIter && maxIterVal !== null && (maxIterVal < 1 || maxIterVal > 50)) {
      json(res, { error: 'maxToolIterations must be between 1 and 50' }, 400)
      return true
    }
    const hasBashTimeout = body && Object.prototype.hasOwnProperty.call(body, 'bashTimeoutMs')
    const bashTimeoutVal =
      typeof body?.bashTimeoutMs === 'number' && Number.isFinite(body.bashTimeoutMs)
        ? Math.floor(body.bashTimeoutMs)
        : null
    if (hasBashTimeout && bashTimeoutVal !== null && (bashTimeoutVal < 1000 || bashTimeoutVal > 600000)) {
      json(res, { error: 'bashTimeoutMs must be between 1000 and 600000' }, 400)
      return true
    }
    let allowedUserIdsVal: string[] | undefined
    if (Array.isArray(body?.allowedUserIds)) {
      allowedUserIdsVal = body.allowedUserIds.map((u) => String(u).trim()).filter(Boolean)
      for (const uid of allowedUserIdsVal) {
        if (!/^[0-9]{15,22}$/.test(uid)) {
          json(res, { error: `Invalid Discord User ID "${uid}" (expected 15-22 digits)` }, 400)
          return true
        }
      }
    }
    const protectedPathsVal = Array.isArray(body?.protectedPaths)
      ? body.protectedPaths.map((p) => String(p).trim()).filter(Boolean)
      : undefined
    const allowedBashVal = Array.isArray(body?.allowedBashCommands)
      ? body.allowedBashCommands.map((c) => String(c).trim()).filter(Boolean)
      : undefined
    const roleId = body.role ? normalizeRoleId(body.role) : null
    if (body.role && !roleId) {
      json(res, { error: 'Unknown role. Allowed: tervezo, technikus, szakmunkas, segedmunkas' }, 400)
      return true
    }
    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : null
    if (provider && !ALLOWED_PROVIDERS.has(provider as AlfredProviderName)) {
      json(res, { error: `Unsupported provider "${provider}"` }, 400)
      return true
    }
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null
    const dailyBudgetUsd =
      typeof body.dailyBudgetUsd === 'number' && Number.isFinite(body.dailyBudgetUsd)
        ? Math.round(body.dailyBudgetUsd * 100) / 100
        : null
    if (dailyBudgetUsd !== null && (dailyBudgetUsd < 0.05 || dailyBudgetUsd > 100)) {
      json(res, { error: 'dailyBudgetUsd must be between 0.05 and 100' }, 400)
      return true
    }

    const targets = resolveWritableAgentConfigPaths()

    let found = false
    for (const cfgPath of targets) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
      const list = Array.isArray(parsed.agents) ? parsed.agents : []
      const entry = list.find((a) => a.id === agentId)
      if (!entry) continue
      found = true
      if (displayName) entry.displayName = displayName
      if (roleId) entry.role = roleId
      if (provider) entry.provider = provider
      else delete entry.provider
      if (model) entry.model = model
      else delete entry.model
      if (dailyBudgetUsd !== null) entry.dailyBudgetUsd = dailyBudgetUsd
      if (voiceVal !== undefined) {
        if (voiceVal && voiceVal !== 'browser') entry.voice = voiceVal
        else delete entry.voice
      }
      if (toolsVal !== undefined) {
        entry.tools = toolsVal
      }
      if (systemPromptVal !== undefined) {
        if (systemPromptVal) entry.systemPrompt = systemPromptVal
        else delete entry.systemPrompt
      }
      if (workspaceVal) entry.workspace = workspaceVal
      if (memoryNsVal) entry.memoryNamespace = memoryNsVal
      if (hasMaxIter) {
        if (maxIterVal !== null) entry.maxToolIterations = maxIterVal
        else delete entry.maxToolIterations
      }
      if (hasBashTimeout) {
        if (bashTimeoutVal !== null) entry.bashTimeoutMs = bashTimeoutVal
        else delete entry.bashTimeoutMs
      }
      if (allowedUserIdsVal !== undefined) {
        entry.allowedUserIds = allowedUserIdsVal
      }
      if (protectedPathsVal !== undefined) {
        if (protectedPathsVal.length > 0) entry.protectedPaths = protectedPathsVal
        else delete entry.protectedPaths
      }
      if (allowedBashVal !== undefined) {
        if (allowedBashVal.length > 0) entry.allowedBashCommands = allowedBashVal
        else delete entry.allowedBashCommands
      }
      atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
    }
    if (!found) {
      json(res, { error: `Unknown agent: ${agentId}` }, 404)
      return true
    }

    let restarted: string[] = []
    if (body.restartServices && process.platform === 'linux') {
      for (const unit of ['alfred-prod', 'alfred-ops']) {
        try {
          await execFileAsync('sudo', ['-n', 'systemctl', 'restart', unit], { timeout: 15000 })
          restarted.push(unit)
        } catch { /* ignore if unit not present or sudo unavailable */ }
      }
    }

    const env = { ...readEnvFile(), ...process.env }
    const updatedCfg = loadAlfredAgentsConfig({ env })
    json(res, {
      ok: true,
      restarted,
      agents: updatedCfg.agents.map((a) => ({
        id: a.id,
        role: a.role ?? null,
        provider: a.provider,
        model: a.model,
      })),
    })
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
    const body = await readJsonBody<{ action?: string; branch?: string }>(req)
    const action = (body?.action || '').trim()
    const branch = typeof body?.branch === 'string' ? body.branch.trim() : ''
    if (!ALLOWED_OPS_ACTIONS.has(action)) {
      json(res, { error: `Unsupported ops action: ${action}` }, 400)
      return true
    }
    if (action === 'spinup-test' && !branch) {
      json(res, { error: 'Branch name is required for spinup-test' }, 400)
      return true
    }
    if (branch && !validateOpsBranch(branch)) {
      json(res, { error: 'Invalid branch name (must match feat/self-*, fix/self-*, feat/core-*, or core-*)' }, 400)
      return true
    }
    const opsDir = process.env['ALFRED_OPS_DIR'] || '/opt/alfred-ops'
    const scriptPath = join(opsDir, 'deploy', `${action}.sh`)
    if (!existsSync(scriptPath)) {
      json(res, { error: `Deploy script not found: ${scriptPath}` }, 404)
      return true
    }
    const args = branch && action !== 'check-health' ? [scriptPath, branch] : [scriptPath]
    const opsTimeoutMs = action === 'spinup-test' || action === 'reload-test' ? 300_000 : 120_000
    try {
      const { stdout, stderr } = await execFileAsync('bash', args, {
        cwd: opsDir,
        timeout: opsTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      })
      json(res, {
        ok: true,
        action,
        output: sanitizeOutput([stdout, stderr].filter(Boolean).join('\n')),
      })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string }
      const diag = [e.killed ? '[killed/timeout]' : '', e.signal ? `[signal=${e.signal}]` : ''].filter(Boolean).join(' ')
      json(
        res,
        {
          ok: false,
          action,
          output: sanitizeOutput([diag, e.stdout, e.stderr, e.message].filter(Boolean).join('\n')),
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

  if (path.startsWith('/api/test-sim/')) {
    if (process.env['ALFRED_ENV'] !== 'test') {
      json(res, { error: 'Test simulator is only available in test mode' }, 404)
      return true
    }
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Test simulator access requires an owner session.' }, 403)
      return true
    }
    const simPort = Number(process.env['ALFRED_SIM_PORT'] || '3421') || 3421
    const subPath = path.slice('/api/test-sim'.length) + url.search
    const targetUrl = `http://127.0.0.1:${simPort}${subPath}`
    try {
      const bodyBuf = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined
      const upstream = await fetch(targetUrl, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(bodyBuf && bodyBuf.length > 0 ? { body: new Uint8Array(bodyBuf) } : {}),
        signal: AbortSignal.timeout(120_000),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(text)
    } catch {
      json(
        res,
        {
          ok: false,
          offline: true,
          error: 'A tesztkörnyezet (alfred-test) jelenleg nem fut. Indítsd el a Spinup Test gombbal!',
        },
        503,
      )
    }
    return true
  }

  if (path === '/api/vps/models' && method === 'GET') {
    const env = { ...readEnvFile(), ...process.env }
    const catalogPath = resolveModelCatalogPath()
    const cached = readModelCatalog(catalogPath)
    const providers = buildProviderCatalogView(env, cached)
    json(res, { ok: true, syncedAt: cached?.syncedAt ?? null, providers })
    return true
  }

  if (path === '/api/vps/models/sync' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Syncing model catalog requires an owner session.' }, 403)
      return true
    }
    const env = { ...readEnvFile(), ...process.env }
    const synced = await syncAllProviderModels(env)
    const catalogPath = resolveModelCatalogPath()
    mkdirSync(dirname(catalogPath), { recursive: true })
    atomicWriteFileSync(catalogPath, JSON.stringify(synced, null, 2) + '\n')
    const providers = buildProviderCatalogView(env, synced)
    json(res, { ok: true, syncedAt: synced.syncedAt, providers })
    return true
  }

  if (path === '/api/vps/agent-terminal' && method === 'GET') {
    const agentId = (url.searchParams.get('agentId') || '').trim()
    if (!agentId) {
      json(res, { error: 'agentId is required' }, 400)
      return true
    }
    const rawLimit = Number(url.searchParams.get('limit') || '80')
    const limit = Math.max(10, Math.min(200, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 80))
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const agent = cfg?.agents.find((a) => a.id === agentId)
    const ns = agent?.memoryNamespace || agentId
    const db = getDb()
    const events: Array<{ ts: string; epoch: number; kind: string; title: string; detail: string }> = []

    try {
      const msgs = db
        .prepare(
          `SELECT direction, sender_name, text, ts, created_at, source
           FROM conversation_log
           WHERE agent_id = ? OR agent_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(agentId, ns, limit) as Array<{
        direction: string
        sender_name: string | null
        text: string
        ts: string | null
        created_at: number | null
        source: string | null
      }>
      for (const m of msgs) {
        const epoch = Number(m.created_at || 0)
        const ts = m.ts || (epoch ? new Date(epoch * 1000).toISOString() : '')
        const isIn = m.direction === 'in'
        events.push({
          ts,
          epoch,
          kind: isIn ? 'user' : 'assistant',
          title: isIn ? `USER (${m.sender_name || m.source || 'input'})` : `ASSISTANT (${agentId})`,
          detail: sanitizeOutput(String(m.text || '')).slice(0, 1200),
        })
      }
    } catch { /* table may not exist in minimal test db */ }

    try {
      const tools = db
        .prepare(
          `SELECT tool_name, input_summary, status, duration_ms, created_at
           FROM tool_call_log
           WHERE agent_id = ? OR agent_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(agentId, ns, limit) as Array<{
        tool_name: string
        input_summary: string | null
        status: string | null
        duration_ms: number | null
        created_at: number | null
      }>
      for (const t of tools) {
        const epoch = Number(t.created_at || 0)
        const isErr = t.status && t.status !== 'ok' && t.status !== 'success'
        events.push({
          ts: epoch ? new Date(epoch * 1000).toISOString() : '',
          epoch,
          kind: isErr ? 'error' : 'tool',
          title: `TOOL ${t.tool_name}${t.status ? ` [${t.status}]` : ''}${t.duration_ms ? ` (${t.duration_ms}ms)` : ''}`,
          detail: sanitizeOutput(String(t.input_summary || '')).slice(0, 600),
        })
      }
    } catch { /* optional table */ }

    try {
      const usage = db
        .prepare(
          `SELECT model, input_tokens, output_tokens, cost_usd, recorded_at
           FROM token_usage
           WHERE agent_id = ? OR agent_id = ?
           ORDER BY recorded_at DESC, id DESC LIMIT ?`,
        )
        .all(agentId, ns, Math.min(limit, 40)) as Array<{
        model: string | null
        input_tokens: number | null
        output_tokens: number | null
        cost_usd: number | null
        recorded_at: number | null
      }>
      for (const u of usage) {
        const epoch = Number(u.recorded_at || 0)
        events.push({
          ts: epoch ? new Date(epoch * 1000).toISOString() : '',
          epoch,
          kind: 'llm',
          title: `LLM ${u.model || 'unknown'}`,
          detail: `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cost=$${Number(u.cost_usd ?? 0).toFixed(5)}`,
        })
      }
    } catch { /* optional table */ }

    events.sort((a, b) => a.epoch - b.epoch)
    const trimmed = events.slice(-limit).map(({ ts, kind, title, detail }) => ({ ts, kind, title, detail }))
    json(res, { ok: true, agentId, events: trimmed })
    return true
  }

  if (path === '/api/vps/discord/guilds' && method === 'GET') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Discord guild listing requires an owner session.' }, 403)
      return true
    }
    const env = { ...readEnvFile(), ...process.env }
    const token = (env['DISCORD_BOT_TOKEN'] || '').trim()
    if (!token) {
      json(res, { error: 'DISCORD_BOT_TOKEN nincs beállítva a szerveren.' }, 400)
      return true
    }
    try {
      const gRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!gRes.ok) {
        const errText = await gRes.text()
        json(res, { error: `Discord API hiba (${gRes.status}): ${sanitizeOutput(errText).slice(0, 200)}` }, 502)
        return true
      }
      const guilds = (await gRes.json()) as Array<{ id: string; name: string }>
      const enriched = await Promise.all(
        guilds.slice(0, 10).map(async (g) => {
          try {
            const cRes = await fetch(`https://discord.com/api/v10/guilds/${g.id}/channels`, {
              headers: { Authorization: `Bot ${token}` },
              signal: AbortSignal.timeout(8000),
            })
            if (!cRes.ok) return { id: g.id, name: g.name, categories: [], channels: [] }
            const all = (await cRes.json()) as Array<{ id: string; name: string; type: number; parent_id?: string | null }>
            return {
              id: g.id,
              name: g.name,
              categories: all.filter((c) => c.type === 4).map((c) => ({ id: c.id, name: c.name })),
              channels: all.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id ?? null })),
            }
          } catch {
            return { id: g.id, name: g.name, categories: [], channels: [] }
          }
        }),
      )
      json(res, { ok: true, guilds: enriched })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 502)
    }
    return true
  }

  if (path === '/api/vps/discord/create-channel' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Creating Discord channels requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{
      agentId?: string
      guildId?: string
      channelName?: string
      categoryId?: string | null
      topic?: string | null
    }>(req)
    const agentId = (body?.agentId || '').trim()
    const guildId = (body?.guildId || '').trim()
    const rawName = (body?.channelName || '').trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    if (!agentId || !guildId || !rawName) {
      json(res, { error: 'agentId, guildId és érvényes csatornanév megadása kötelező.' }, 400)
      return true
    }
    const env = { ...readEnvFile(), ...process.env }
    const token = (env['DISCORD_BOT_TOKEN'] || '').trim()
    if (!token) {
      json(res, { error: 'DISCORD_BOT_TOKEN nincs beállítva.' }, 400)
      return true
    }
    try {
      const createRes = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: rawName,
          type: 0,
          ...(body.categoryId ? { parent_id: body.categoryId } : {}),
          topic: (body.topic || `Alfred Core dedikált chat szoba: ${agentId}`).slice(0, 200),
        }),
        signal: AbortSignal.timeout(10000),
      })
      const created = (await createRes.json().catch(() => ({}))) as { id?: string; name?: string; message?: string; code?: number }
      if (!createRes.ok || !created.id) {
        const hint = createRes.status === 403
          ? ' (Ellenőrizd, hogy a Discord Bot szerepkörén engedélyezve van-e a "Manage Channels" jogosultság!)'
          : ''
        const status = createRes.status === 403 ? 403 : 400
        json(res, { error: `Discord csatorna létrehozás sikertelen (${createRes.status}): ${created.message || 'unknown'}${hint}` }, status)
        return true
      }

      const channelNameFormatted = `#${created.name || rawName}`
      const targets = resolveWritableAgentConfigPaths()

      for (const cfgPath of targets) {
        const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
        const entry = (parsed.agents ?? []).find((a) => a.id === agentId)
        if (!entry) continue
        entry.channelName = channelNameFormatted
        entry.channelId = created.id
        atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
      }

      json(res, {
        ok: true,
        agentId,
        channel: { id: created.id, name: channelNameFormatted },
      })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 502)
    }
    return true
  }

  if (path === '/api/vps/skills' && method === 'GET') {
    const agentId = (url.searchParams.get('agentId') || '').trim()
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const ag = agentId ? cfg?.agents.find((a) => a.id === agentId) : undefined
    const assignedSet = new Set<string>(ag?.skills ?? [])
    const skillsDir = resolveSkillsRootDir()
    const usageMap = new Map<string, number>()
    try {
      const db = getDb()
      const rows = db
        .prepare(`SELECT skill_name, COUNT(*) AS cnt FROM skill_usage GROUP BY skill_name`)
        .all() as Array<{ skill_name: string; cnt: number }>
      for (const r of rows) usageMap.set(r.skill_name, Number(r.cnt || 0))
    } catch { /* optional table */ }

    const skills: Array<{ id: string; description: string; content: string; enabled: boolean; usageCount: number }> = []
    if (existsSync(skillsDir)) {
      const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
      for (const d of dirs) {
        if (!SAFE_SKILL_ID_RE.test(d.name)) continue
        const mdPath = join(skillsDir, d.name, 'SKILL.md')
        if (!existsSync(mdPath)) continue
        try {
          const raw = readFileSync(mdPath, 'utf-8')
          skills.push({
            id: d.name,
            description: extractSkillDescription(raw),
            content: raw,
            enabled: assignedSet.has(d.name),
            usageCount: usageMap.get(d.name) ?? 0,
          })
        } catch { /* ignore */ }
      }
    }
    skills.sort((a, b) => a.id.localeCompare(b.id))
    json(res, { ok: true, agentId: agentId || null, skills })
    return true
  }

  if (path === '/api/vps/skills/assign' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Assigning skills requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ agentId?: string; skills?: unknown }>(req)
    const agentId = (body?.agentId || '').trim()
    if (!agentId || !Array.isArray(body?.skills)) {
      json(res, { error: 'agentId and skills[] are required' }, 400)
      return true
    }
    const cleanSkills = Array.from(
      new Set(
        body.skills
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter((s) => SAFE_SKILL_ID_RE.test(s)),
      ),
    )
    const targets = resolveWritableAgentConfigPaths()
    let found = false
    for (const cfgPath of targets) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
      const entry = (parsed.agents ?? []).find((a) => a.id === agentId)
      if (!entry) continue
      found = true
      if (cleanSkills.length > 0) entry.skills = cleanSkills
      else delete entry.skills
      atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
    }
    if (!found) {
      json(res, { error: `Unknown agent: ${agentId}` }, 404)
      return true
    }
    json(res, { ok: true, agentId, skills: cleanSkills })
    return true
  }

  if (path === '/api/vps/skills/save' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Saving skills requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ id?: string; description?: string; content?: string; agentId?: string }>(req)
    const rawId = (body?.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    if (!rawId || !SAFE_SKILL_ID_RE.test(rawId)) {
      json(res, { error: 'Érvényes skill ID megadása kötelező (a-z, 0-9, -, _).' }, 400)
      return true
    }
    const desc = (body?.description || '').trim().replace(/\r?\n/g, ' ').slice(0, 260)
    let content = (body?.content || '').trim()
    if (!content) {
      json(res, { error: 'A SKILL.md tartalma nem lehet üres.' }, 400)
      return true
    }
    if (!content.startsWith('---')) {
      content = `---\nname: ${rawId}\ndescription: ${desc || rawId}\n---\n\n${content}\n`
    } else if (!content.endsWith('\n')) {
      content += '\n'
    }
    const dir = join(resolveSkillsRootDir(), rawId)
    mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(join(dir, 'SKILL.md'), content)

    const agentId = (body?.agentId || '').trim()
    if (agentId) {
      for (const cfgPath of resolveWritableAgentConfigPaths()) {
        const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
        const entry = (parsed.agents ?? []).find((a) => a.id === agentId)
        if (!entry) continue
        const cur = Array.isArray(entry.skills) ? entry.skills.map(String) : []
        if (!cur.includes(rawId)) {
          entry.skills = [...cur, rawId]
          atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
        }
      }
    }
    json(res, { ok: true, id: rawId })
    return true
  }

  if (path === '/api/vps/skills' && method === 'DELETE') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Deleting skills requires an owner session.' }, 403)
      return true
    }
    const id = (url.searchParams.get('id') || '').trim()
    if (!id || !SAFE_SKILL_ID_RE.test(id)) {
      json(res, { error: 'Invalid skill id' }, 400)
      return true
    }
    const dir = join(resolveSkillsRootDir(), id)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
    for (const cfgPath of resolveWritableAgentConfigPaths()) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
      let changed = false
      for (const entry of parsed.agents ?? []) {
        if (Array.isArray(entry.skills) && entry.skills.includes(id)) {
          const next = entry.skills.filter((s) => s !== id)
          if (next.length > 0) entry.skills = next
          else delete entry.skills
          changed = true
        }
      }
      if (changed) atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
    }
    json(res, { ok: true, deleted: id })
    return true
  }

  if (path === '/api/vps/skills/generate' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Generating skills requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ prompt?: string; agentId?: string }>(req)
    const promptText = (body?.prompt || '').trim()
    if (!promptText) {
      json(res, { error: 'Add meg röviden, mit csináljon a skill!' }, 400)
      return true
    }
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const baseAgent =
      (body.agentId ? cfg?.agents.find((a) => a.id === body.agentId) : undefined) ?? cfg?.agents[0]
    if (!baseAgent) {
      json(res, { error: 'Nincs konfigurált Alfred Core ügynök a generáláshoz.' }, 400)
      return true
    }
    const genAgent: AlfredAgentDefinition = {
      ...baseAgent,
      tools: [],
      resolvedSystemPrompt:
        'You are a skill author for Alfred AI agents. Given a user request, output ONLY valid JSON (no markdown fences) with keys: "id" (lowercase kebab-case slug, max 32 chars), "description" (1 concise Hungarian sentence), "content" (clear actionable Markdown instructions in Hungarian starting with "# <Title>").',
    }
    try {
      const outcome = await runHybridAgentTurn({
        db: getDb(),
        agent: genAgent,
        globalDailyBudgetUsd: cfg.global.dailyBudgetUsd,
        userMessage: `Készíts egy új ügynök skillt ehhez a feladathoz:\n${promptText}`,
        conversationHistory: [],
        sessionId: `skill-gen:${Date.now()}`,
        chatId: 'web-skill-gen',
        env,
        nowSec: Math.floor(Date.now() / 1000),
      })
      if (!outcome.ok) {
        json(res, { error: outcome.discordMessage }, 429)
        return true
      }
      const raw = outcome.replyText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      let parsed: { id?: string; description?: string; content?: string }
      try {
        parsed = JSON.parse(raw) as { id?: string; description?: string; content?: string }
      } catch {
        parsed = {
          id: promptText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'uj-skill',
          description: promptText.slice(0, 140),
          content: raw,
        }
      }
      json(res, {
        ok: true,
        draft: {
          id: (parsed.id || 'uj-skill').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40),
          description: parsed.description || promptText.slice(0, 140),
          content: parsed.content || raw,
        },
      })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  if (path === '/api/vps/skills/optimize' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Optimizing skills requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ content?: string; id?: string; agentId?: string }>(req)
    const content = (body?.content || '').trim()
    if (!content) {
      json(res, { error: 'Add meg az optimalizálandó SKILL.md tartalmat!' }, 400)
      return true
    }
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const baseAgent =
      (body.agentId ? cfg?.agents.find((a) => a.id === body.agentId) : undefined) ?? cfg?.agents[0]
    if (!baseAgent) {
      json(res, { error: 'Nincs konfigurált Alfred Core ügynök az optimalizáláshoz.' }, 400)
      return true
    }
    const optAgent: AlfredAgentDefinition = {
      ...baseAgent,
      tools: [],
      resolvedSystemPrompt:
        'You are a strict Skill Optimizer Agent for Alfred AI agents. Your goal is MAXIMUM signal-to-noise ratio and FEWER tokens. HARD RULES: (1) Output MUST be strictly shorter than or equal in character length to the input (never bloat a concise skill — aim for 20-40% fewer tokens while keeping 100% of original rules and YAML frontmatter). (2) Do NOT invent new rules or extra sections that were not requested. (3) Remove filler words, merge duplicates, use ultra-crisp bullet/numbered imperatives. Output ONLY valid JSON (no markdown fences) with keys: "content" (the full optimized SKILL.md including YAML frontmatter) and "summary" (1 concise Hungarian sentence describing the exact tightening).',
    }
    try {
      const outcome = await runHybridAgentTurn({
        db: getDb(),
        agent: optAgent,
        globalDailyBudgetUsd: cfg.global.dailyBudgetUsd,
        userMessage: `Optimalizáld ezt a SKILL.md fájlt${body.id ? ` (${body.id})` : ''}:\n\n${content}`,
        conversationHistory: [],
        sessionId: `skill-opt:${Date.now()}`,
        chatId: 'web-skill-opt',
        env,
        nowSec: Math.floor(Date.now() / 1000),
      })
      if (!outcome.ok) {
        json(res, { error: outcome.discordMessage }, 429)
        return true
      }
      const raw = outcome.replyText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      let parsed: { content?: string; summary?: string }
      try {
        parsed = JSON.parse(raw) as { content?: string; summary?: string }
      } catch {
        parsed = { content: raw, summary: 'Tömörítve és strukturálva.' }
      }
      const optimizedContent = (parsed.content || raw).trim()
      const tokensBeforeEst = Math.max(1, Math.ceil(content.length / 4))
      const tokensAfterEst = Math.max(1, Math.ceil(optimizedContent.length / 4))
      const savedPct = Math.round(((tokensBeforeEst - tokensAfterEst) / tokensBeforeEst) * 100)
      json(res, {
        ok: true,
        optimized: {
          content: optimizedContent,
          summary: parsed.summary || 'Tömörítve és strukturálva.',
          tokensBeforeEst,
          tokensAfterEst,
          savedPct,
        },
      })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  if (path === '/api/vps/agents/suggest-persona' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Suggesting personas requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ agentId?: string; role?: string; hint?: string }>(req)
    const env = { ...readEnvFile(), ...process.env }
    const cfg = loadAlfredAgentsConfig({ env })
    const baseAgent =
      (body.agentId ? cfg?.agents.find((a) => a.id === body.agentId) : undefined) ?? cfg?.agents[0]
    if (!baseAgent) {
      json(res, { error: 'Nincs konfigurált Alfred Core ügynök a javaslathoz.' }, 400)
      return true
    }
    const roleLabel = (body.role && cfg?.roles?.[normalizeRoleId(body.role) ?? 'tervezo']?.label) || body.role || baseAgent.role || 'AI asszisztens'
    const personaAgent: AlfredAgentDefinition = {
      ...baseAgent,
      tools: [],
      resolvedSystemPrompt:
        'You are a creative persona designer for Alfred AI team members. Suggest 4 warm, realistic, friendly HUMAN Hungarian or international first names (like Albert, Alfréd, Eszter, Bence, Nóra, Márton, Dóra, Gábor, Zsófia, Tamás — NEVER robotic or compound AI names like "CodeBot", "ArchitektAI", or "DevMaster"). Output ONLY valid JSON (no markdown fences) with keys: "suggestions" (array of 4 objects: { "displayName": string (human first name, e.g. "Márton"), "tagline": string (short Hungarian role subtitle max 40 chars), "emoji": single emoji, "color": hex color like "#2563eb" }) and "soulDraft" (concise Hungarian SOUL.md Markdown starting with "# <Name>", max 12 lines).',
    }
    try {
      const outcome = await runHybridAgentTurn({
        db: getDb(),
        agent: personaAgent,
        globalDailyBudgetUsd: cfg.global.dailyBudgetUsd,
        userMessage: `Adj 4 kreatív név- és személyiség-javaslatot egy "${roleLabel}" munkakörű ügynöknek (${body.agentId || 'új ügynök'}).${body.hint ? ` Megjegyzés: ${body.hint}` : ''}`,
        conversationHistory: [],
        sessionId: `persona-gen:${Date.now()}`,
        chatId: 'web-persona-gen',
        env,
        nowSec: Math.floor(Date.now() / 1000),
      })
      if (!outcome.ok) {
        json(res, { error: outcome.discordMessage }, 429)
        return true
      }
      const raw = outcome.replyText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = JSON.parse(raw) as {
        suggestions?: Array<{ displayName?: string; tagline?: string; emoji?: string; color?: string }>
        soulDraft?: string
      }
      json(res, {
        ok: true,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 5) : [],
        soulDraft: typeof parsed.soulDraft === 'string' ? parsed.soulDraft : '',
      })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  if (path === '/api/vps/agents/personalize' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Personalizing agents requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ agentId?: string; displayName?: string; avatarDataUrl?: string }>(req, 5 * 1024 * 1024)
    const agentId = (body?.agentId || '').trim()
    if (!agentId || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      json(res, { error: 'Valid agentId is required' }, 400)
      return true
    }
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 60) : ''
    if (displayName) {
      for (const cfgPath of resolveWritableAgentConfigPaths()) {
        const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
        const entry = (parsed.agents ?? []).find((a) => a.id === agentId)
        if (!entry) continue
        entry.displayName = displayName
        atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
      }
    }
    let avatarSaved = false
    if (typeof body?.avatarDataUrl === 'string' && body.avatarDataUrl.startsWith('data:image/png;base64,')) {
      const b64 = body.avatarDataUrl.slice('data:image/png;base64,'.length)
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0 || buf.length > 4_000_000) {
        json(res, { error: 'Avatar PNG size must be between 1 byte and 4 MB' }, 400)
        return true
      }
      const dir = join(process.cwd(), 'agents', agentId)
      mkdirSync(dir, { recursive: true })
      for (const ext of ['.jpg', '.jpeg', '.webp']) {
        const old = join(dir, `avatar${ext}`)
        if (existsSync(old)) rmSync(old, { force: true })
      }
      atomicWriteFileSync(join(dir, 'avatar.png'), buf)
      avatarSaved = true
    }
    json(res, {
      ok: true,
      agentId,
      ...(displayName ? { displayName } : {}),
      avatarSaved,
      avatarUrl: avatarSaved ? `/api/agents/${encodeURIComponent(agentId)}/avatar?t=${Date.now()}` : undefined,
    })
    return true
  }

  if (path === '/api/vps/agents/generate-avatar' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Generating AI avatars requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ agentId?: string; displayName?: string; role?: string; count?: number; prompt?: string }>(req)
    const agentId = (body?.agentId || '').trim()
    if (!agentId || !/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      json(res, { error: 'Valid agentId is required' }, 400)
      return true
    }
    const count = Math.max(1, Math.min(3, Number(body?.count || 3) || 3))
    const env = { ...readEnvFile(), ...process.env }
    const openaiKey = (env['OPENAI_API_KEY'] || '').trim()
    const geminiKey = (env['GEMINI_API_KEY'] || '').trim()
    const cfg = loadAlfredAgentsConfig({ env })
    const ag = cfg?.agents.find((a) => a.id === agentId)
    const roleThemeMap: Record<string, string> = {
      tervezo: 'wearing smart glasses and a neat blazer, holding a tiny glowing blueprint scroll',
      szakmunkas: 'wearing a cozy tech hoodie and headphones, holding a tiny glowing laptop',
      technikus: 'wearing a sleek tech visor and utility vest, holding a tiny diagnostic wrench and checklist',
      segedmunkas: 'wearing a friendly casual sweater, smiling warmly with a tiny notebook',
    }
    const roleKey = body?.role ? (normalizeRoleId(body.role) ?? '') : (ag?.role ?? '')
    const roleTheme = roleThemeMap[roleKey] || 'wearing a neat modern smart-casual tech outfit'
    const charName = (body?.displayName || ag?.displayName || agentId).trim().slice(0, 40)

    let soulSnippet = ''
    try {
      const soulPath = ag?.soulFile ? join(process.cwd(), ag.soulFile) : join(process.cwd(), 'agents', agentId, 'SOUL.md')
      if (existsSync(soulPath)) {
        soulSnippet = readFileSync(soulPath, 'utf-8').replace(/\s+/g, ' ').trim().slice(0, 220)
      }
    } catch { /* ignore */ }
    const skillsHint = ag?.skills && ag.skills.length > 0 ? ` Specialties/skills: ${ag.skills.join(', ')}.` : ''
    const soulHint = soulSnippet ? ` Personality context: ${soulSnippet}.` : ''

    const variations = [
      'warm pastel sky-blue and lavender gradient background, cheerful confident smile',
      'soft sunset peach and coral studio gradient background, playful curious expression',
      'mint-teal and soft indigo gradient background, calm focused friendly expression',
    ]

    async function generateOneImage(promptStr: string): Promise<{ dataUrl?: string; err?: string }> {
      let lastErr = ''
      if (geminiKey) {
        for (const imgModel of ['gemini-2.5-flash-image', 'gemini-3.1-flash-image']) {
          try {
            const resImg = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/images/generations', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${geminiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ model: imgModel, prompt: promptStr, response_format: 'b64_json', n: 1 }),
              signal: AbortSignal.timeout(40_000),
            })
            if (resImg.ok) {
              const data = (await resImg.json()) as { data?: Array<{ b64_json?: string }> }
              const b64 = data.data?.[0]?.b64_json
              if (b64) return { dataUrl: `data:image/png;base64,${b64}` }
            } else {
              lastErr = `Gemini (${imgModel}) HTTP ${resImg.status}`
            }
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e)
          }
        }
      }
      if (openaiKey) {
        try {
          const resImg = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-image-1', prompt: promptStr, size: '1024x1024', response_format: 'b64_json' }),
            signal: AbortSignal.timeout(40_000),
          })
          if (resImg.ok) {
            const data = (await resImg.json()) as { data?: Array<{ b64_json?: string }> }
            const b64 = data.data?.[0]?.b64_json
            if (b64) return { dataUrl: `data:image/png;base64,${b64}` }
          } else {
            lastErr = `OpenAI Image HTTP ${resImg.status}`
          }
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e)
        }
      }
      return { err: lastErr || 'nincs GEMINI_API_KEY vagy OPENAI_API_KEY' }
    }

    const prompts = Array.from({ length: count }, (_, idx) =>
      (
        body?.prompt ||
        `Adorable Chibi (Super Deformed) anime/manga character portrait avatar for a friendly team member named ${charName}, ${roleTheme}.${skillsHint}${soulHint} Classic 2-to-3-head-tall chibi proportions with an oversized head, huge sparkling expressive eyes, tiny cute hands, clean crisp cel-shaded anime lineart, ${variations[idx % variations.length]}, centered head-and-shoulders framing for a circular profile avatar, NO text, NO letters, NO watermark.`
      ).slice(0, 850),
    )

    const results = await Promise.all(prompts.map((p) => generateOneImage(p)))
    const candidates = results.map((r) => r.dataUrl).filter((u): u is string => Boolean(u))
    if (candidates.length === 0) {
      const errMsg = results.find((r) => r.err)?.err || 'ismeretlen hiba'
      json(res, { error: `AI avatar generálás nem elérhető (${errMsg}). Használd az azonnali Piktogram Stúdiót!` }, 400)
      return true
    }
    json(res, { ok: true, agentId, candidates })
    return true
  }

  if (path === '/api/vps/tts' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'TTS requires an owner session.' }, 403)
      return true
    }
    const body = await readJsonBody<{ text?: string; voice?: string; agentId?: string }>(req)
    const cleanText = String(body?.text || '')
      .replace(/```[\s\S]*?```/g, ' kódblokk ')
      .replace(/[`*_#>~[\]]+/g, ' ')
      .replace(/https?:\/\/\S+/g, ' link ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200)
    if (!cleanText) {
      json(res, { error: 'text is required' }, 400)
      return true
    }
    let chosenVoice = (body?.voice || '').trim()
    if (!chosenVoice && body?.agentId) {
      try {
        const cfgFile = process.env['ALFRED_AGENTS_CONFIG'] || join(process.cwd(), 'config', 'agents.json')
        if (existsSync(cfgFile)) {
          const parsed = JSON.parse(readFileSync(cfgFile, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
          const entry = (parsed.agents ?? []).find((a) => a.id === body.agentId)
          if (entry && typeof entry.voice === 'string') chosenVoice = entry.voice.trim()
        }
      } catch { /* ignore */ }
    }
    if (chosenVoice === 'browser') {
      json(res, { ok: true, fallback: 'browser' })
      return true
    }

    const env = { ...readEnvFile(), ...process.env }
    const geminiKey = (env['GEMINI_API_KEY'] || '').trim()
    const openaiKey = (env['OPENAI_API_KEY'] || '').trim()
    const isOpenAiVoice = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).has(chosenVoice.toLowerCase())

    if (geminiKey && !isOpenAiVoice) {
      const voiceName = chosenVoice || 'Kore'
      try {
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: cleanText }] }],
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
              },
            }),
            signal: AbortSignal.timeout(25_000),
          },
        )
        if (gRes.ok) {
          const data = (await gRes.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>
          }
          const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData
          if (inline?.data) {
            const rawBuf = Buffer.from(inline.data, 'base64')
            const mime = (inline.mimeType || '').toLowerCase()
            const wavBuf = mime.includes('wav') ? rawBuf : wrapPcm16AsWav(rawBuf, 24000, 1)
            json(res, {
              ok: true,
              provider: 'gemini',
              voice: voiceName,
              audioDataUrl: `data:audio/wav;base64,${wavBuf.toString('base64')}`,
            })
            return true
          }
        }
      } catch { /* fall through to openai/browser */ }
    }

    if (openaiKey) {
      const oVoice = isOpenAiVoice ? chosenVoice.toLowerCase() : 'nova'
      try {
        const oRes = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'tts-1', voice: oVoice, input: cleanText, response_format: 'mp3' }),
          signal: AbortSignal.timeout(25_000),
        })
        if (oRes.ok) {
          const buf = Buffer.from(await oRes.arrayBuffer())
          json(res, {
            ok: true,
            provider: 'openai',
            voice: oVoice,
            audioDataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}`,
          })
          return true
        }
      } catch { /* fall through to browser */ }
    }

    json(res, { ok: true, fallback: 'browser' })
    return true
  }

  return false
}

function wrapPcm16AsWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const SAFE_SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

function resolveSkillsRootDir(): string {
  return process.env['ALFRED_SKILLS_DIR'] || join(process.cwd(), 'skills')
}

function extractSkillDescription(md: string): string {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const block = fm ? fm[1] : md.slice(0, 500)
  const m = block.match(/^description:\s*(.+)$/m)
  return m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 260) : ''
}

interface StoredModelCatalog {
  syncedAt: string
  providers: Record<string, { models: string[]; error?: string }>
}

const DEFAULT_PROVIDER_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  'vertex-eu': ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  xai: ['grok-3', 'grok-3-mini', 'grok-4'],
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'],
}

function resolveModelCatalogPath(): string {
  return process.env['ALFRED_MODEL_CATALOG_PATH'] || join(process.cwd(), 'store', 'model-catalog.json')
}

function readModelCatalog(filePath: string): StoredModelCatalog | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8')) as StoredModelCatalog
  } catch {
    return null
  }
}

function isProviderConfigured(provider: string, env: Record<string, string | undefined>): boolean {
  if (provider === 'deepseek') return Boolean(env['DEEPSEEK_API_KEY']?.trim())
  if (provider === 'openai') return Boolean(env['OPENAI_API_KEY']?.trim())
  if (provider === 'xai') return Boolean(env['XAI_API_KEY']?.trim())
  if (provider === 'gemini') return Boolean(env['GEMINI_API_KEY']?.trim())
  if (provider === 'vertex-eu') return Boolean(env['VERTEX_PROJECT_ID']?.trim() || env['GOOGLE_CLOUD_PROJECT']?.trim() || env['GOOGLE_APPLICATION_CREDENTIALS']?.trim())
  return false
}

function buildProviderCatalogView(env: Record<string, string | undefined>, cached: StoredModelCatalog | null) {
  const out: Record<string, { configured: boolean; models: string[]; error?: string }> = {}
  for (const p of ALLOWED_PROVIDERS) {
    const entry = cached?.providers?.[p]
    out[p] = {
      configured: isProviderConfigured(p, env),
      models: entry?.models?.length ? entry.models : (DEFAULT_PROVIDER_MODELS[p] ?? []),
      ...(entry?.error ? { error: entry.error } : {}),
    }
  }
  return out
}

async function fetchOpenAiCompatModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { data?: Array<{ id?: string }> }
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort()
}

async function syncAllProviderModels(env: Record<string, string | undefined>): Promise<StoredModelCatalog> {
  const providers: Record<string, { models: string[]; error?: string }> = {}
  await Promise.all(
    [...ALLOWED_PROVIDERS].map(async (p) => {
      if (!isProviderConfigured(p, env)) {
        providers[p] = { models: DEFAULT_PROVIDER_MODELS[p] ?? [] }
        return
      }
      try {
        if (p === 'deepseek') {
          providers[p] = { models: await fetchOpenAiCompatModels('https://api.deepseek.com', env['DEEPSEEK_API_KEY']!.trim()) }
        } else if (p === 'openai') {
          const all = await fetchOpenAiCompatModels('https://api.openai.com/v1', env['OPENAI_API_KEY']!.trim())
          const filtered = all.filter((id) => /^(gpt-|o1|o3|o4|chatgpt-)/.test(id))
          providers[p] = { models: filtered.length ? filtered : all }
        } else if (p === 'xai') {
          providers[p] = { models: await fetchOpenAiCompatModels('https://api.x.ai/v1', env['XAI_API_KEY']!.trim()) }
        } else if (p === 'gemini') {
          const key = env['GEMINI_API_KEY']!.trim()
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
            signal: AbortSignal.timeout(8000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }
          const list = (data.models ?? [])
            .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
            .map((m) => (m.name || '').replace(/^models\//, ''))
            .filter((id) => id.startsWith('gemini-'))
            .sort()
          providers[p] = { models: list.length ? list : DEFAULT_PROVIDER_MODELS['gemini'] }
        } else if (p === 'vertex-eu') {
          providers[p] = { models: DEFAULT_PROVIDER_MODELS['vertex-eu'] }
        }
      } catch (err) {
        providers[p] = {
          models: DEFAULT_PROVIDER_MODELS[p] ?? [],
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )
  return { syncedAt: new Date().toISOString(), providers }
}
