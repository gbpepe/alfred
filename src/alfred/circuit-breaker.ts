import type Database from 'better-sqlite3'
import type { TokenPrice } from '../costops/config.js'
import { loadCostopsConfig } from '../costops/config.js'
import { agentSpend } from '../costops/agent-budgets.js'

/**
 * Default per-1M-token USD pricing table for Alfred's Hybrid Model Router.
 * DeepSeek supports automatic prompt caching on prefix matches:
 * - `input` is the cache-miss price per 1M tokens
 * - `cache_read` is the cache-hit price per 1M tokens
 * - `output` is the completion (including reasoning) price per 1M tokens
 */
const CLI_ZERO_COST_MODEL_RE = /^(?:claude|codex|gemini|agy)-cli(?::|$)/i

/**
 * Returns true when `model` belongs to a subscription-backed CLI provider (`claude-cli`, `codex-cli`, `gemini-cli`, `agy-cli`),
 * which is billed at $0 API USD cost while still tracking token counts.
 */
export function isZeroCostCliModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && CLI_ZERO_COST_MODEL_RE.test(model.trim())
}

export const DEFAULT_TOKEN_PRICES_USD: Record<string, TokenPrice> = {
  'claude-cli': {
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
  },
  'codex-cli': {
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
  },
  'gemini-cli': {
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
  },
  'agy-cli': {
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
  },
  'deepseek-chat': {
    input: 0.27,
    cache_read: 0.07,
    cache_write: 0.27,
    output: 1.10,
  },
  'deepseek-reasoner': {
    input: 0.55,
    cache_read: 0.14,
    cache_write: 0.55,
    output: 2.19,
  },
  'gemini-2.5-pro': {
    input: 1.25,
    cache_read: 0.3125,
    cache_write: 1.25,
    output: 10.00,
  },
  'gemini-2.5-flash': {
    input: 0.15,
    cache_read: 0.0375,
    cache_write: 0.15,
    output: 0.60,
  },
  'gemini-2.0-flash': {
    input: 0.10,
    cache_read: 0.025,
    cache_write: 0.10,
    output: 0.40,
  },
  'gemini-3.8-flash': {
    // Standard tier through Dec 31, 2026 ($1.50 / $0.15 / $7.50 starting Jan 1, 2027)
    input: 0.75,
    cache_read: 0.075,
    cache_write: 0.75,
    output: 3.75,
  },
  'gemini-3.5-flash-lite': {
    input: 0.30,
    cache_read: 0.03,
    cache_write: 0.30,
    output: 2.50,
  },
  'gemini-3.1-pro-preview': {
    input: 2.00,
    cache_read: 0.20,
    cache_write: 2.00,
    output: 12.00,
  },
  'grok-3': {
    input: 3.00,
    cache_read: 0.75,
    cache_write: 3.00,
    output: 15.00,
  },
  'grok-3-mini': {
    input: 0.30,
    cache_read: 0.075,
    cache_write: 0.30,
    output: 0.50,
  },
  'gpt-4o': {
    input: 2.50,
    cache_read: 1.25,
    cache_write: 2.50,
    output: 10.00,
  },
  'gpt-4o-mini': {
    input: 0.15,
    cache_read: 0.075,
    cache_write: 0.15,
    output: 0.60,
  },
  'claude-sonnet-4-6': {
    input: 3.00,
    cache_read: 0.30,
    cache_write: 3.75,
    output: 15.00,
  },
  'claude-opus-4-6': {
    input: 15.00,
    cache_read: 1.50,
    cache_write: 18.75,
    output: 75.00,
  },
  'claude-haiku-4-5': {
    input: 0.80,
    cache_read: 0.08,
    cache_write: 1.00,
    output: 4.00,
  },
  'claude-3-5-sonnet-20241022': {
    input: 3.00,
    cache_read: 0.30,
    cache_write: 3.75,
    output: 15.00,
  },
}

export function currentUtcDayWindow(nowSec: number): { dateKey: string; start: number; end: number } {
  const d = new Date(nowSec * 1000)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const day = d.getUTCDate()
  const start = Math.floor(Date.UTC(year, month, day) / 1000)
  const end = Math.floor(Date.UTC(year, month, day + 1) / 1000)
  const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return { dateKey, start, end }
}

export function resolveEffectiveTokenPrices(
  customPrices?: Record<string, TokenPrice>,
): Record<string, TokenPrice> {
  let fromStore: Record<string, TokenPrice> = {}
  try {
    const loaded = loadCostopsConfig()
    if (loaded.config.token_prices) {
      fromStore = loaded.config.token_prices
    }
  } catch {
    // fallback to defaults
  }
  return {
    ...DEFAULT_TOKEN_PRICES_USD,
    ...fromStore,
    ...(customPrices ?? {}),
  }
}

/**
 * Computes total spend across ALL agents in [start, end) using the token_usage table.
 */
export function globalTokenSpend(
  db: Database.Database,
  start: number,
  end: number,
  prices: Record<string, TokenPrice>,
): { cost: number; unpriced_tokens: number } {
  const rows = db.prepare(`
    SELECT model, tool_name, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
      SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
    FROM token_usage WHERE timestamp >= ? AND timestamp < ? GROUP BY model, tool_name
  `).all(start, end) as Array<{
    model: string | null
    tool_name: string | null
    i: number | null
    o: number | null
    cw: number | null
    cr: number | null
  }>

  let cost = 0
  let unpriced = 0
  for (const r of rows) {
    const i = r.i ?? 0
    const o = r.o ?? 0
    const cw = r.cw ?? 0
    const cr = r.cr ?? 0
    if (isZeroCostCliModel(r.model)) {
      continue
    }
    const rawModel = (r.model ?? '').trim()
    const isBatchMode =
      rawModel.toLowerCase().startsWith('batch:') ||
      (r.tool_name ?? '').trim().toLowerCase() === 'batch'
    const baseModel = rawModel.toLowerCase().startsWith('batch:') ? rawModel.slice(6).trim() : rawModel
    const multiplier = isBatchMode ? 0.5 : 1.0

    const p = baseModel && Object.prototype.hasOwnProperty.call(prices, baseModel)
      ? prices[baseModel]
      : undefined
    if (!p) {
      unpriced += i + o + cw + cr
      continue
    }
    let rowCost = (i * p.input) / 1e6 + (o * p.output) / 1e6
    if (typeof p.cache_write === 'number') rowCost += (cw * p.cache_write) / 1e6
    else unpriced += cw
    if (typeof p.cache_read === 'number') rowCost += (cr * p.cache_read) / 1e6
    else unpriced += cr
    cost += rowCost * multiplier
  }
  return { cost, unpriced_tokens: unpriced }
}

export interface CircuitBreakerEvaluation {
  allowed: boolean
  code: 'OK' | 'BUDGET_EXCEEDED'
  reason?: 'agent_daily_limit' | 'global_daily_limit'
  dateKey: string
  agentId: string
  agentSpendUsd: number
  agentLimitUsd: number
  agentUsedPct: number
  globalSpendUsd: number
  globalLimitUsd: number
  globalUsedPct: number
  discordMessage?: string
}

export class BudgetExceededError extends Error {
  public readonly code = 'BUDGET_EXCEEDED' as const
  public readonly evaluation: CircuitBreakerEvaluation

  constructor(evaluation: CircuitBreakerEvaluation) {
    super(evaluation.discordMessage ?? `BUDGET_EXCEEDED for agent ${evaluation.agentId}`)
    this.name = 'BudgetExceededError'
    this.evaluation = evaluation
  }
}

export interface EvaluateCircuitBreakerInput {
  db: Database.Database
  agentId: string
  agentDailyLimitUsd: number
  globalDailyLimitUsd: number
  nowSec?: number
  tokenPrices?: Record<string, TokenPrice>
}

/**
 * Deterministic CostOps Circuit Breaker check.
 * Blocks immediately when either the agent's daily spend or the global daily spend
 * reaches 100% (>= limit).
 */
export function evaluateCircuitBreaker(input: EvaluateCircuitBreakerInput): CircuitBreakerEvaluation {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)
  const dayWin = currentUtcDayWindow(nowSec)
  const prices = resolveEffectiveTokenPrices(input.tokenPrices)

  const agentStat = agentSpend(input.db, input.agentId, dayWin.start, dayWin.end, prices)
  const globalStat = globalTokenSpend(input.db, dayWin.start, dayWin.end, prices)

  const agentLimit = input.agentDailyLimitUsd
  const globalLimit = input.globalDailyLimitUsd

  const agentUsedPct = agentLimit > 0 ? (agentStat.cost / agentLimit) * 100 : 100
  const globalUsedPct = globalLimit > 0 ? (globalStat.cost / globalLimit) * 100 : 100

  if (agentLimit <= 0 || agentStat.cost >= agentLimit) {
    const pctStr = Math.min(999, Math.round(agentUsedPct))
    const discordMessage =
      `⛔ **BUDGET_EXCEEDED**: Az ágens (\`${input.agentId}\`) elérte a napi költséglimitet ` +
      `($${agentStat.cost.toFixed(4)} / $${agentLimit.toFixed(2)} USD — ${pctStr}%). ` +
      `Az LLM API-hívás a CostOps Circuit Breaker által blokkolva.`
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      reason: 'agent_daily_limit',
      dateKey: dayWin.dateKey,
      agentId: input.agentId,
      agentSpendUsd: agentStat.cost,
      agentLimitUsd: agentLimit,
      agentUsedPct,
      globalSpendUsd: globalStat.cost,
      globalLimitUsd: globalLimit,
      globalUsedPct,
      discordMessage,
    }
  }

  if (globalLimit <= 0 || globalStat.cost >= globalLimit) {
    const pctStr = Math.min(999, Math.round(globalUsedPct))
    const discordMessage =
      `⛔ **BUDGET_EXCEEDED**: A rendszer elérte a globális napi költséglimitet ` +
      `($${globalStat.cost.toFixed(4)} / $${globalLimit.toFixed(2)} USD — ${pctStr}%). ` +
      `Az LLM API-hívás (\`${input.agentId}\`) a CostOps Circuit Breaker által blokkolva.`
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      reason: 'global_daily_limit',
      dateKey: dayWin.dateKey,
      agentId: input.agentId,
      agentSpendUsd: agentStat.cost,
      agentLimitUsd: agentLimit,
      agentUsedPct,
      globalSpendUsd: globalStat.cost,
      globalLimitUsd: globalLimit,
      globalUsedPct,
      discordMessage,
    }
  }

  return {
    allowed: true,
    code: 'OK',
    dateKey: dayWin.dateKey,
    agentId: input.agentId,
    agentSpendUsd: agentStat.cost,
    agentLimitUsd: agentLimit,
    agentUsedPct,
    globalSpendUsd: globalStat.cost,
    globalLimitUsd: globalLimit,
    globalUsedPct,
  }
}

/**
 * Throws `BudgetExceededError` if the agent or global daily budget has reached 100%.
 */
export function assertBudgetAvailable(input: EvaluateCircuitBreakerInput): CircuitBreakerEvaluation {
  const result = evaluateCircuitBreaker(input)
  if (!result.allowed) {
    throw new BudgetExceededError(result)
  }
  return result
}

export interface RecordModelUsageInput {
  db: Database.Database
  agentId: string
  sessionId: string
  model: string
  provider: string
  /** Uncached (cache-miss) input tokens */
  inputTokens: number
  /** Output / completion tokens (including reasoning tokens) */
  outputTokens: number
  /** Cache-hit input tokens (e.g. DeepSeek prompt_cache_hit_tokens or Vertex cachedContentTokenCount) */
  cacheReadTokens?: number
  /** Cache-write tokens */
  cacheCreationTokens?: number
  thinkingTokens?: number
  contentPreview?: string
  toolName?: string | null
  timestampSec?: number
}

/**
 * Records an LLM call's token usage directly into `token_usage` so subsequent Circuit Breaker
 * checks (including the very next iteration of a multi-step tool loop) see the updated spend immediately.
 */
export function recordModelTokenUsage(input: RecordModelUsageInput): void {
  const ts = input.timestampSec ?? Math.floor(Date.now() / 1000)
  const cacheRead = input.cacheReadTokens ?? 0
  const cacheWrite = input.cacheCreationTokens ?? 0
  const thinking = input.thinkingTokens ?? 0

  input.db.prepare(`
    INSERT INTO token_usage (
      agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO UPDATE SET
      input_tokens = token_usage.input_tokens + excluded.input_tokens,
      output_tokens = token_usage.output_tokens + excluded.output_tokens,
      cache_read_tokens = token_usage.cache_read_tokens + excluded.cache_read_tokens,
      cache_creation_tokens = token_usage.cache_creation_tokens + excluded.cache_creation_tokens
  `).run(
    input.agentId,
    input.sessionId,
    ts,
    input.inputTokens,
    input.outputTokens,
    cacheRead,
    cacheWrite,
    thinking,
    input.model,
    input.contentPreview ? input.contentPreview.slice(0, 200) : null,
    input.toolName ?? null,
  )
}
