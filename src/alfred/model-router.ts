import type Database from 'better-sqlite3'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import type { AlfredAgentDefinition, AlfredCliProviderName, AlfredProviderName } from './agents-config.js'
import { isCliProvider } from './agents-config.js'
import {
  assertBudgetAvailable,
  BudgetExceededError,
  recordModelTokenUsage,
  type CircuitBreakerEvaluation,
} from './circuit-breaker.js'
import {
  classifyCliError,
  CliExecutionError,
  formatCliDiscordError,
  runCliAgent,
  sanitizeCliText,
  type CliErrorKind,
  type CliProcessRunner,
  type RunCliAgentFn,
} from './cli-runner.js'
import {
  executeWhitelistedToolAsync,
  getWhitelistedToolSchemas,
  ProtectedPathError,
  type OpenAiToolSchema,
} from './tool-executor.js'
import { resolveVertexEuAuth } from './vertex-auth.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCallRequest[]
}

export interface ToolCallRequest {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ProviderUsageMetrics {
  /** Cache-miss input tokens */
  inputTokens: number
  /** Output / completion tokens */
  outputTokens: number
  /** Cache-hit input tokens (DeepSeek prompt_cache_hit_tokens or Vertex cachedContentTokenCount) */
  cacheReadTokens: number
  cacheCreationTokens: number
  thinkingTokens: number
}

export interface ProviderCallResult {
  content: string
  toolCalls: ToolCallRequest[]
  usage: ProviderUsageMetrics
  model: string
}

export interface HybridRouterOptions {
  db: Database.Database
  agent: AlfredAgentDefinition
  globalDailyBudgetUsd: number
  userMessage: string
  conversationHistory?: ChatMessage[]
  sessionId?: string
  chatId?: string
  maxToolIterations?: number
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  cliRunner?: RunCliAgentFn
  cliProcessRunner?: CliProcessRunner
  onCliQueued?: (position: number) => void
  nowSec?: number
}

export type HybridRouterOutcome =
  | {
    ok: true
    replyText: string
    provider: AlfredProviderName
    model: string
    iterations: number
    totalUsage: ProviderUsageMetrics
    toolCallsExecuted: Array<{ name: string; args: Record<string, unknown>; output: string }>
  }
  | {
    ok: false
    code: 'BUDGET_EXCEEDED'
    discordMessage: string
    evaluation: CircuitBreakerEvaluation
  }
  | {
    ok: false
    code: 'CLI_EXECUTION_FAILED'
    provider: AlfredCliProviderName
    errorKind: CliErrorKind
    error: string
    discordMessage: string
  }

const EU_VERTEX_REGION_RE = /^(eu|europe-[a-z0-9-]+)$/

/**
 * Validates that a Vertex AI location is strictly inside the European Union
 * (e.g. "eu" multi-region REP or single EU regions like "europe-west1", "europe-west3", "europe-central2").
 */
export function assertVertexEuRegion(location: string): string {
  const clean = location.trim().toLowerCase()
  if (!EU_VERTEX_REGION_RE.test(clean)) {
    throw new Error(
      `GDPR_VIOLATION: vertex-eu provider requires an EU location ("eu" or "europe-*", got "${location}").`,
    )
  }
  return clean
}

/**
 * Resolves the Google Vertex AI EU API hostname for a validated EU location.
 * The `"eu"` multi-region uses Google's official EU Regional Endpoint (`aiplatform.eu.rep.googleapis.com`).
 */
export function resolveVertexEuApiHost(location: string): string {
  if (location === 'eu') {
    return 'https://aiplatform.eu.rep.googleapis.com'
  }
  return `https://${location}-aiplatform.googleapis.com`
}

/**
 * Builds the message array for an LLM turn.
 * Places the agent's `resolvedSystemPrompt` (loaded from `soulFile` + `systemPrompt`)
 * as the very first, immutable `system` message so DeepSeek's automatic prefix prompt-caching
 * gets maximum cache hits across turns.
 */
export function buildPromptCachedMessages(
  agent: Pick<AlfredAgentDefinition, 'resolvedSystemPrompt'>,
  history: readonly ChatMessage[],
  userMessage: string,
): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (agent.resolvedSystemPrompt) {
    messages.push({
      role: 'system',
      content: agent.resolvedSystemPrompt,
    })
  }
  for (const m of history) {
    if (m.role === 'system') continue // keep the first system message stable for prefix caching
    messages.push(m)
  }
  messages.push({
    role: 'user',
    content: userMessage,
  })
  return messages
}

/**
 * Calls any OpenAI-compatible `/chat/completions` API (DeepSeek, Grok/xAI, OpenAI, Gemini OpenAI endpoint).
 */
export async function callOpenAiCompatibleProvider(params: {
  providerLabel: string
  defaultBaseUrl: string
  baseUrlEnvKey: string
  apiKeyEnvKey: string
  model: string
  messages: ChatMessage[]
  tools: OpenAiToolSchema[]
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
}): Promise<ProviderCallResult> {
  const apiKey = (params.env[params.apiKeyEnvKey] ?? process.env[params.apiKeyEnvKey] ?? '').trim()
  if (!apiKey) {
    throw new Error(`${params.apiKeyEnvKey} is missing from environment`)
  }
  const baseUrl = (
    params.env[params.baseUrlEnvKey] ??
    process.env[params.baseUrlEnvKey] ??
    params.defaultBaseUrl
  ).replace(/\/+$/, '')

  const payload: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
  }
  if (params.tools.length > 0) {
    payload.tools = params.tools
    payload.tool_choice = 'auto'
  }

  const resp = await params.fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`${params.providerLabel} API error ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const data = (await resp.json()) as {
    model?: string
    choices?: Array<{
      message?: {
        content?: string | null
        reasoning_content?: string | null
        tool_calls?: ToolCallRequest[]
      }
    }>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
      completion_tokens_details?: { reasoning_tokens?: number }
    }
  }

  const choice = data.choices?.[0]?.message
  const content = choice?.content ?? ''
  const toolCalls = Array.isArray(choice?.tool_calls) ? choice!.tool_calls : []

  const u = data.usage ?? {}
  const cacheHit =
    typeof u.prompt_cache_hit_tokens === 'number'
      ? u.prompt_cache_hit_tokens
      : (u.prompt_tokens_details?.cached_tokens ?? 0)
  const totalPrompt = u.prompt_tokens ?? 0
  const cacheMiss =
    typeof u.prompt_cache_miss_tokens === 'number'
      ? u.prompt_cache_miss_tokens
      : Math.max(0, totalPrompt - cacheHit)
  const outputTokens = u.completion_tokens ?? 0
  const thinkingTokens = u.completion_tokens_details?.reasoning_tokens ?? 0

  return {
    content,
    toolCalls,
    model: data.model || params.model,
    usage: {
      inputTokens: cacheMiss,
      outputTokens,
      cacheReadTokens: cacheHit,
      cacheCreationTokens: 0,
      thinkingTokens,
    },
  }
}

/**
 * Calls DeepSeek's OpenAI-compatible `/v1/chat/completions` API and extracts
 * `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` for CostOps tracking.
 */
export async function callDeepSeekProvider(params: {
  model: string
  messages: ChatMessage[]
  tools: OpenAiToolSchema[]
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
}): Promise<ProviderCallResult> {
  return callOpenAiCompatibleProvider({
    ...params,
    providerLabel: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrlEnvKey: 'DEEPSEEK_BASE_URL',
    apiKeyEnvKey: 'DEEPSEEK_API_KEY',
  })
}

/**
 * Calls Google Vertex AI EU (`europe-*`) Gemini `generateContent` endpoint.
 */
export async function callVertexEuProvider(params: {
  model: string
  messages: ChatMessage[]
  tools: OpenAiToolSchema[]
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
}): Promise<ProviderCallResult> {
  const rawLocation = params.env['VERTEX_EU_LOCATION'] ?? process.env['VERTEX_EU_LOCATION'] ?? 'eu'
  const location = assertVertexEuRegion(rawLocation)

  const { accessToken, projectId } = await resolveVertexEuAuth({
    env: params.env,
    fetchImpl: params.fetchImpl,
  })

  const systemMessages = params.messages.filter((m) => m.role === 'system')
  const nonSystemMessages = params.messages.filter((m) => m.role !== 'system')

  const contents = nonSystemMessages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'tool',
              response: { result: m.content },
            },
          },
        ],
      }
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'model',
        parts: m.tool_calls.map((tc) => ({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || '{}'),
          },
        })),
      }
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }
  })

  const payload: Record<string, unknown> = { contents }
  if (systemMessages.length > 0) {
    payload.systemInstruction = {
      parts: [{ text: systemMessages.map((s) => s.content).join('\n\n') }],
    }
  }
  if (params.tools.length > 0) {
    payload.tools = [
      {
        functionDeclarations: params.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ]
  }

  const host = resolveVertexEuApiHost(location)
  const endpoint =
    `${host}/v1/projects/${encodeURIComponent(projectId)}` +
    `/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(params.model)}:generateContent`

  const resp = await params.fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Vertex AI EU (${location}) API error ${resp.status}: ${errText.slice(0, 300)}`)
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          thought?: boolean
          functionCall?: { name: string; args?: Record<string, unknown> }
        }>
      }
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      cachedContentTokenCount?: number
      thoughtsTokenCount?: number
    }
  }

  const parts = data.candidates?.[0]?.content?.parts ?? []
  const textParts: string[] = []
  const toolCalls: ToolCallRequest[] = []

  parts.forEach((p, idx) => {
    if (typeof p.text === 'string' && !p.thought) textParts.push(p.text)
    if (p.functionCall && p.functionCall.name) {
      toolCalls.push({
        id: `vertex_call_${idx + 1}`,
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      })
    }
  })

  const u = data.usageMetadata ?? {}
  const cached = u.cachedContentTokenCount ?? 0
  const promptTotal = u.promptTokenCount ?? 0
  const uncachedInput = Math.max(0, promptTotal - cached)
  const outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)

  return {
    content: textParts.join('\n').trim(),
    toolCalls,
    model: params.model,
    usage: {
      inputTokens: uncachedInput,
      outputTokens,
      cacheReadTokens: cached,
      cacheCreationTokens: 0,
      thinkingTokens: u.thoughtsTokenCount ?? 0,
    },
  }
}

/**
 * Executes an agent turn through the Hybrid Model Router:
 * 1. Builds prompt-cached message array with the agent's `SOUL.md` (`resolvedSystemPrompt`) first.
 * 2. Exposes ONLY the agent's whitelisted tool schemas (`[]` for zero-tool agents).
 * 3. Runs the CostOps Circuit Breaker before EVERY LLM call (including multi-step tool loop iterations).
 * 4. Records token usage (including cache hits/misses) into SQLite `token_usage` after every call.
 * 5. Enforces runtime tool whitelist and workspace confinement on any tool call.
 */
export async function runHybridAgentTurn(opts: HybridRouterOptions): Promise<HybridRouterOutcome> {
  const envMap = opts.env ?? { ...readEnvFile(), ...process.env }
  const fetchImpl = opts.fetchImpl ?? fetch
  const maxIterations = opts.maxToolIterations ?? opts.agent.maxToolIterations ?? 6
  const sessionId = opts.sessionId ?? `alfred-${opts.agent.id}-${Date.now()}`

  if (isCliProvider(opts.agent.provider)) {
    try {
      assertBudgetAvailable({
        db: opts.db,
        agentId: opts.agent.id,
        agentDailyLimitUsd: opts.agent.dailyBudgetUsd,
        globalDailyLimitUsd: opts.globalDailyBudgetUsd,
        nowSec: opts.nowSec,
      })
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        logger.warn(
          {
            agentId: opts.agent.id,
            reason: err.evaluation.reason,
            agentSpendUsd: err.evaluation.agentSpendUsd,
            globalSpendUsd: err.evaluation.globalSpendUsd,
          },
          'CostOps Circuit Breaker blocked CLI call (BUDGET_EXCEEDED)',
        )
        return {
          ok: false,
          code: 'BUDGET_EXCEEDED',
          discordMessage: err.evaluation.discordMessage!,
          evaluation: err.evaluation,
        }
      }
      throw err
    }

    const cliRunner = opts.cliRunner ?? runCliAgent
    try {
      const cliRes = await cliRunner({
        agent: opts.agent,
        userMessage: opts.userMessage,
        conversationHistory: opts.conversationHistory,
        env: envMap,
        processRunner: opts.cliProcessRunner,
        onQueued: opts.onCliQueued,
      })

      recordModelTokenUsage({
        db: opts.db,
        agentId: opts.agent.id,
        sessionId,
        model: cliRes.model,
        provider: opts.agent.provider,
        inputTokens: cliRes.usage.inputTokens,
        outputTokens: cliRes.usage.outputTokens,
        cacheReadTokens: cliRes.usage.cacheReadTokens,
        cacheCreationTokens: cliRes.usage.cacheCreationTokens,
        thinkingTokens: cliRes.usage.thinkingTokens,
        contentPreview: cliRes.content || opts.userMessage,
        toolName: null,
        timestampSec: opts.nowSec,
      })

      return {
        ok: true,
        replyText: cliRes.content,
        provider: opts.agent.provider,
        model: cliRes.model,
        iterations: 1,
        totalUsage: cliRes.usage,
        toolCallsExecuted: [],
      }
    } catch (err) {
      if (err instanceof ProtectedPathError) {
        throw err
      }

      const errKind: CliErrorKind =
        err instanceof CliExecutionError
          ? err.kind
          : classifyCliError(opts.agent.provider, 1, err instanceof Error ? err.message : String(err), false)
      const rawErrMsg = err instanceof Error ? err.message : String(err)
      const sanitizedErr = sanitizeCliText(rawErrMsg)
      const discordMsg =
        err instanceof CliExecutionError
          ? err.discordMessage
          : formatCliDiscordError(opts.agent.provider, errKind, sanitizedErr)

      const fb = opts.agent.fallback
      if (fb) {
        logger.warn(
          {
            agentId: opts.agent.id,
            failedProvider: opts.agent.provider,
            errorKind: errKind,
            fallbackProvider: fb.provider,
            fallbackModel: fb.model,
          },
          'CLI provider failed; invoking explicit fallback provider',
        )
        const fbOutcome = await runHybridAgentTurn({
          ...opts,
          agent: {
            ...opts.agent,
            provider: fb.provider,
            model: fb.model,
            fallback: undefined,
          },
        })
        if (fbOutcome.ok) {
          const tag = `[Fallback: ${fb.provider}/${fb.model}]`
          return {
            ...fbOutcome,
            replyText: fbOutcome.replyText ? `${fbOutcome.replyText}\n\n${tag}` : tag,
          }
        }
        return fbOutcome
      }

      return {
        ok: false,
        code: 'CLI_EXECUTION_FAILED',
        provider: opts.agent.provider,
        errorKind: errKind,
        error: sanitizedErr,
        discordMessage: discordMsg,
      }
    }
  }

  const messages = buildPromptCachedMessages(
    opts.agent,
    opts.conversationHistory ?? [],
    opts.userMessage,
  )
  const toolSchemas = getWhitelistedToolSchemas(opts.agent)

  const totalUsage: ProviderUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
  }
  const toolCallsExecuted: Array<{ name: string; args: Record<string, unknown>; output: string }> = []

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Pre-call CostOps Circuit Breaker gate (re-checked before every LLM call in the loop!)
    try {
      assertBudgetAvailable({
        db: opts.db,
        agentId: opts.agent.id,
        agentDailyLimitUsd: opts.agent.dailyBudgetUsd,
        globalDailyLimitUsd: opts.globalDailyBudgetUsd,
        nowSec: opts.nowSec,
      })
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        logger.warn(
          {
            agentId: opts.agent.id,
            reason: err.evaluation.reason,
            agentSpendUsd: err.evaluation.agentSpendUsd,
            globalSpendUsd: err.evaluation.globalSpendUsd,
          },
          'CostOps Circuit Breaker blocked LLM call (BUDGET_EXCEEDED)',
        )
        return {
          ok: false,
          code: 'BUDGET_EXCEEDED',
          discordMessage: err.evaluation.discordMessage!,
          evaluation: err.evaluation,
        }
      }
      throw err
    }

    const openAiPresets: Record<string, { label: string; baseUrl: string; baseEnv: string; keyEnv: string }> = {
      xai: { label: 'Grok (xAI)', baseUrl: 'https://api.x.ai/v1', baseEnv: 'XAI_BASE_URL', keyEnv: 'XAI_API_KEY' },
      openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', baseEnv: 'OPENAI_BASE_URL', keyEnv: 'OPENAI_API_KEY' },
      gemini: {
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        baseEnv: 'GEMINI_BASE_URL',
        keyEnv: 'GEMINI_API_KEY',
      },
    }
    const preset = openAiPresets[opts.agent.provider]
    const callResult =
      opts.agent.provider === 'vertex-eu'
        ? await callVertexEuProvider({
          model: opts.agent.model,
          messages,
          tools: toolSchemas,
          env: envMap,
          fetchImpl,
        })
        : preset
          ? await callOpenAiCompatibleProvider({
            providerLabel: preset.label,
            defaultBaseUrl: preset.baseUrl,
            baseUrlEnvKey: preset.baseEnv,
            apiKeyEnvKey: preset.keyEnv,
            model: opts.agent.model,
            messages,
            tools: toolSchemas,
            env: envMap,
            fetchImpl,
          })
          : await callDeepSeekProvider({
            model: opts.agent.model,
            messages,
            tools: toolSchemas,
            env: envMap,
            fetchImpl,
          })

    totalUsage.inputTokens += callResult.usage.inputTokens
    totalUsage.outputTokens += callResult.usage.outputTokens
    totalUsage.cacheReadTokens += callResult.usage.cacheReadTokens
    totalUsage.cacheCreationTokens += callResult.usage.cacheCreationTokens
    totalUsage.thinkingTokens += callResult.usage.thinkingTokens

    recordModelTokenUsage({
      db: opts.db,
      agentId: opts.agent.id,
      sessionId,
      model: callResult.model,
      provider: opts.agent.provider,
      inputTokens: callResult.usage.inputTokens,
      outputTokens: callResult.usage.outputTokens,
      cacheReadTokens: callResult.usage.cacheReadTokens,
      cacheCreationTokens: callResult.usage.cacheCreationTokens,
      thinkingTokens: callResult.usage.thinkingTokens,
      contentPreview: callResult.content || opts.userMessage,
      toolName: callResult.toolCalls[0]?.function?.name ?? null,
      timestampSec: opts.nowSec ? opts.nowSec + iteration - 1 : undefined,
    })

    if (callResult.toolCalls.length === 0) {
      return {
        ok: true,
        replyText: callResult.content,
        provider: opts.agent.provider,
        model: callResult.model,
        iterations: iteration,
        totalUsage,
        toolCallsExecuted,
      }
    }

    messages.push({
      role: 'assistant',
      content: callResult.content || '',
      tool_calls: callResult.toolCalls,
    })

    for (const tc of callResult.toolCalls) {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
      } catch {
        parsedArgs = {}
      }

      const output = await executeWhitelistedToolAsync(
        { agent: opts.agent, db: opts.db, chatId: opts.chatId },
        tc.function.name,
        parsedArgs,
        { env: envMap, processRunner: opts.cliProcessRunner },
      )

      toolCallsExecuted.push({
        name: tc.function.name,
        args: parsedArgs,
        output,
      })

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: output,
      })
    }
  }

  return {
    ok: true,
    replyText: 'A maximális eszközhívási lépésszám elérve.',
    provider: opts.agent.provider,
    model: opts.agent.model,
    iterations: maxIterations,
    totalUsage,
    toolCallsExecuted,
  }
}
