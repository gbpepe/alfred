import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { resolveAlfredRuntimeEnv, type AlfredRuntimeMode } from './runtime-env.js'

export type AlfredProviderName = 'deepseek' | 'vertex-eu' | 'xai' | 'openai' | 'gemini'

export const ALLOWED_PROVIDERS: ReadonlySet<AlfredProviderName> = new Set<AlfredProviderName>([
  'deepseek',
  'vertex-eu',
  'xai',
  'openai',
  'gemini',
])

export type AlfredRoleId = 'tervezo' | 'technikus' | 'szakmunkas' | 'segedmunkas'

export interface AlfredRoleDefinition {
  id: AlfredRoleId
  label: string
  description: string
  provider: AlfredProviderName
  model: string
}

const ROLE_ALIASES: Record<string, AlfredRoleId> = {
  tervezo: 'tervezo',
  'tervező': 'tervezo',
  technikus: 'technikus',
  szakmunkas: 'szakmunkas',
  'szakmunkás': 'szakmunkas',
  segedmunkas: 'segedmunkas',
  'segédmunkás': 'segedmunkas',
}

export function normalizeRoleId(raw: string): AlfredRoleId | null {
  return ROLE_ALIASES[raw.trim().toLowerCase()] ?? null
}

const DEFAULT_ROLES: Record<AlfredRoleId, AlfredRoleDefinition> = {
  tervezo: {
    id: 'tervezo',
    label: 'Tervező',
    description: 'Architektúra, tervezés, komplex döntések',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  },
  technikus: {
    id: 'technikus',
    label: 'Technikus',
    description: 'QA, elemzés, üzemeltetés, felülvizsgálat',
    provider: 'vertex-eu',
    model: 'gemini-3.8-flash',
  },
  szakmunkas: {
    id: 'szakmunkas',
    label: 'Szakmunkás',
    description: 'Kódolás, implementáció, tool-használat',
    provider: 'deepseek',
    model: 'deepseek-chat',
  },
  segedmunkas: {
    id: 'segedmunkas',
    label: 'Segédmunkás',
    description: 'Gyors, olcsó rutin feladatok és összefoglalás',
    provider: 'vertex-eu',
    model: 'gemini-3.5-flash-lite',
  },
}

export type AllowedToolName = 'bash' | 'fs_read' | 'fs_write' | 'git' | 'memory'

export const CANONICAL_TOOLS: ReadonlySet<AllowedToolName> = new Set<AllowedToolName>([
  'bash',
  'fs_read',
  'fs_write',
  'git',
  'memory',
])

const MUTATING_TOOLS: ReadonlySet<AllowedToolName> = new Set<AllowedToolName>([
  'bash',
  'fs_write',
  'git',
])

export interface AlfredAgentDefinition {
  id: string
  displayName: string
  channelName: string
  discordChannelId: string
  role?: AlfredRoleId
  provider: AlfredProviderName
  model: string
  /** Relative path in config/agents.json, resolved to absolute path inside PROJECT_ROOT/workspaces (or "." for self-dev/ops) */
  workspace: string
  /** Absolute resolved workspace directory on disk */
  workspaceAbsPath: string
  memoryNamespace: string
  dailyBudgetUsd: number
  allowedUserIds: string[]
  tools: AllowedToolName[]
  /** Optional relative paths protected against modification (and `.env`/`store/` against reading) */
  protectedPaths?: string[]
  /** Optional strict whitelist of allowed bash command templates (disables general shell) */
  allowedBashCommands?: string[]
  /** Optional bash execution timeout in milliseconds (default 30s, or 180s for whitelisted scripts) */
  bashTimeoutMs?: number
  /** Optional per-agent override for max tool-loop iterations in model-router.ts */
  maxToolIterations?: number
  /** Optional relative path to the agent's SOUL.md file (loaded as stable system prompt prefix for caching) */
  soulFile?: string
  /** Optional list of global skill IDs (loaded from skills/<id>/SKILL.md) */
  skills?: string[]
  /** Fallback or supplementary system prompt */
  systemPrompt?: string
  /** Resolved stable system prompt (SOUL.md content + systemPrompt + attached skills, if any) */
  resolvedSystemPrompt: string
}

export type AgentConfig = AlfredAgentDefinition

export interface AlfredGlobalConfig {
  defaultProvider: AlfredProviderName
  defaultModel: string
  dailyBudgetUsd: number
  budgetMultiplier: number
  runtimeMode: AlfredRuntimeMode
  workspacesRoot: string
}

export interface AlfredAgentsConfig {
  version: number
  global: AlfredGlobalConfig
  roles: Record<AlfredRoleId, AlfredRoleDefinition>
  agents: AlfredAgentDefinition[]
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SNOWFLAKE_RE = /^[0-9]{15,22}$/

/**
 * Resolves `${VAR_NAME}` placeholders in config strings using the provided env dictionary
 * (falling back to `.env` and `process.env`).
 */
export function interpolateEnvPlaceholders(
  raw: string,
  envMap: Record<string, string | undefined>,
): string {
  return raw.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, varName: string) => {
    const val = envMap[varName] ?? process.env[varName]
    return val !== undefined ? val.trim() : ''
  })
}

/**
 * Parse a comma- or whitespace-separated list of Discord user IDs (e.g. ALLOWED_USER_IDS).
 */
export function parseAllowedUserIds(raw: string | readonly string[] | undefined | null): string[] {
  if (!raw) return []
  const items = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)
  const out: string[] = []
  for (const item of items) {
    const trimmed = String(item).trim()
    if (trimmed && SNOWFLAKE_RE.test(trimmed) && !out.includes(trimmed)) {
      out.push(trimmed)
    }
  }
  return out
}

/**
 * Resolve global allowed Discord user IDs from environment (`ALLOWED_USER_IDS`,
 * with backward-compatible fallback to `DISCORD_OWNER_USER_ID` and `OPERATOR_DISCORD_USER_ID`).
 */
export function resolveGlobalAllowedUserIds(envOverride?: Record<string, string | undefined>): string[] {
  const fileEnv = envOverride ?? { ...readEnvFile(), ...process.env }
  const combined = [
    fileEnv['ALLOWED_USER_IDS'] ?? '',
    fileEnv['DISCORD_OWNER_USER_ID'] ?? '',
    fileEnv['OPERATOR_DISCORD_USER_ID'] ?? '',
  ].join(',')
  return parseAllowedUserIds(combined)
}

/**
 * Ensures a path stays strictly inside `baseDir` (prevents `..` traversal).
 */
export function resolveInsideBase(baseDir: string, targetPath: string, label: string): string {
  const baseAbs = resolve(baseDir)
  const targetAbs = isAbsolute(targetPath) ? resolve(targetPath) : resolve(baseAbs, targetPath)
  const rel = relative(baseAbs, targetAbs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Security violation: ${label} "${targetPath}" escapes base directory "${baseAbs}"`)
  }
  return targetAbs
}

/**
 * Loads the agent's SOUL.md file (if configured and present) and combines it with `systemPrompt`
 * into a single deterministic, cache-friendly system prompt prefix.
 */
export function loadAgentSystemPrompt(
  projectRoot: string,
  soulFile: string | undefined,
  systemPrompt: string | undefined,
  skills?: string[],
): string {
  const parts: string[] = []
  if (soulFile && soulFile.trim()) {
    const soulAbs = resolveInsideBase(projectRoot, soulFile.trim(), 'soulFile')
    if (!existsSync(soulAbs)) {
      throw new Error(`Configured soulFile not found on disk: ${soulFile} (resolved: ${soulAbs})`)
    }
    const content = readFileSync(soulAbs, 'utf-8').trim()
    if (content) {
      parts.push(content)
    }
  }
  if (systemPrompt && systemPrompt.trim()) {
    // If soulFile is absent or doesn't already include the systemPrompt line, append it
    if (parts.length === 0 || !parts[0].includes(systemPrompt.trim())) {
      parts.push(systemPrompt.trim())
    }
  }
  if (Array.isArray(skills) && skills.length > 0) {
    const skillBlocks: string[] = []
    for (const rawId of skills) {
      const skillId = String(rawId || '').trim()
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(skillId)) continue
      const skillFile = join(projectRoot, 'skills', skillId, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      try {
        const md = readFileSync(skillFile, 'utf-8').trim()
        if (md) skillBlocks.push(`### Skill: ${skillId}\n${md}`)
      } catch { /* ignore unreadable skill */ }
    }
    if (skillBlocks.length > 0) {
      parts.push(`## ACTIVE SKILLS\n\n${skillBlocks.join('\n\n')}`)
    }
  }
  return parts.join('\n\n')
}

export interface LoadAgentsConfigOptions {
  configPath?: string
  projectRoot?: string
  env?: Record<string, string | undefined>
  provisionWorkspaces?: boolean
}

function roundUsd(amount: number): number {
  return Math.round(amount * 10_000) / 10_000
}

function normalizeProtectedPathRule(raw: string, agentId: string, idx: number): string {
  const trimmed = raw.trim().replace(/\\/g, '/')
  const hasTrailingSlash = trimmed.endsWith('/')
  const cleaned = trimmed.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleaned) {
    throw new Error(`agents[${idx}] (${agentId}): invalid empty protectedPaths entry "${raw}"`)
  }
  return hasTrailingSlash ? `${cleaned}/` : cleaned
}

/**
 * Loads, validates, and provisions `config/agents.json`.
 */
export function loadAlfredAgentsConfig(opts: LoadAgentsConfigOptions = {}): AlfredAgentsConfig {
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT
  const envMap: Record<string, string | undefined> = opts.env ?? { ...readEnvFile(), ...process.env }
  const runtimeEnv = resolveAlfredRuntimeEnv(envMap, projectRoot)
  const relOrAbsPath = opts.configPath ?? envMap['ALFRED_AGENTS_CONFIG'] ?? 'config/agents.json'
  const fullConfigPath = isAbsolute(relOrAbsPath) ? relOrAbsPath : join(projectRoot, relOrAbsPath)

  if (!existsSync(fullConfigPath)) {
    throw new Error(`Alfred agents configuration file not found at ${fullConfigPath}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(fullConfigPath, 'utf-8'))
  } catch (err) {
    throw new Error(`Failed to parse ${fullConfigPath} as JSON: ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid agents.json root: expected object`)
  }

  const root = parsed as Record<string, unknown>
  const rawGlobal = (root.global && typeof root.global === 'object' && !Array.isArray(root.global))
    ? (root.global as Record<string, unknown>)
    : {}

  const rawDefaultProvider = typeof rawGlobal.defaultProvider === 'string' ? rawGlobal.defaultProvider.trim() : 'deepseek'
  const defaultProvider = (
    ALLOWED_PROVIDERS.has(rawDefaultProvider as AlfredProviderName) ? rawDefaultProvider : 'deepseek'
  ) as AlfredProviderName
  const defaultModel = typeof rawGlobal.defaultModel === 'string' && rawGlobal.defaultModel.trim()
    ? rawGlobal.defaultModel.trim()
    : 'deepseek-chat'

  const roles: Record<AlfredRoleId, AlfredRoleDefinition> = {
    tervezo: { ...DEFAULT_ROLES.tervezo },
    technikus: { ...DEFAULT_ROLES.technikus },
    szakmunkas: { ...DEFAULT_ROLES.szakmunkas },
    segedmunkas: { ...DEFAULT_ROLES.segedmunkas },
  }
  if (root.roles && typeof root.roles === 'object' && !Array.isArray(root.roles)) {
    for (const [rawRoleKey, rawRoleVal] of Object.entries(root.roles as Record<string, unknown>)) {
      const roleId = normalizeRoleId(rawRoleKey)
      if (!roleId) {
        throw new Error(`Invalid role "${rawRoleKey}" in agents.json`)
      }
      if (!rawRoleVal || typeof rawRoleVal !== 'object' || Array.isArray(rawRoleVal)) {
        throw new Error(`roles.${rawRoleKey} must be an object`)
      }
      const r = rawRoleVal as Record<string, unknown>
      const rProvider = typeof r.provider === 'string' ? r.provider.trim() : roles[roleId].provider
      if (!ALLOWED_PROVIDERS.has(rProvider as AlfredProviderName)) {
        throw new Error(`roles.${rawRoleKey}: unsupported provider "${rProvider}". Allowed: ${[...ALLOWED_PROVIDERS].join(', ')}`)
      }
      const rModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : roles[roleId].model
      const rLabel = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : roles[roleId].label
      const rDesc = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : roles[roleId].description
      roles[roleId] = {
        id: roleId,
        label: rLabel,
        description: rDesc,
        provider: rProvider as AlfredProviderName,
        model: rModel,
      }
    }
  }
  const jsonGlobalBudget = typeof rawGlobal.dailyBudgetUsd === 'number' && rawGlobal.dailyBudgetUsd > 0
    ? rawGlobal.dailyBudgetUsd
    : 15.0
  const rawEnvGlobalBudget = envMap['ALFRED_GLOBAL_DAILY_BUDGET_USD']
  const envGlobalBudget = rawEnvGlobalBudget !== undefined && rawEnvGlobalBudget.trim() !== ''
    ? Number(rawEnvGlobalBudget)
    : NaN
  // Explicit ALFRED_GLOBAL_DAILY_BUDGET_USD acts as the final global ceiling;
  // ALFRED_BUDGET_MULTIPLIER scales JSON-configured per-agent and default global budgets.
  const dailyBudgetUsd = Number.isFinite(envGlobalBudget) && envGlobalBudget > 0
    ? envGlobalBudget
    : roundUsd(jsonGlobalBudget * runtimeEnv.budgetMultiplier)

  const jsonWorkspacesRoot = typeof rawGlobal.workspacesRoot === 'string' && rawGlobal.workspacesRoot.trim()
    ? rawGlobal.workspacesRoot.trim()
    : 'workspaces'
  const workspacesRoot = runtimeEnv.workspacesDir ?? jsonWorkspacesRoot
  const workspacesBaseAbs = isAbsolute(workspacesRoot)
    ? resolve(workspacesRoot)
    : resolveInsideBase(projectRoot, workspacesRoot, 'workspacesRoot')
  const projectRootAbs = resolve(projectRoot)
  const normJsonWsRoot = jsonWorkspacesRoot.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')

  if (!Array.isArray(root.agents)) {
    throw new Error(`Invalid agents.json: "agents" must be an array`)
  }

  const seenIds = new Set<string>()
  const seenChannels = new Set<string>()
  const seenMemoryNamespaces = new Set<string>()
  let agents: AlfredAgentDefinition[] = []

  for (const [idx, rawEntry] of root.agents.entries()) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`agents[${idx}] must be an object`)
    }
    const a = rawEntry as Record<string, unknown>
    const id = typeof a.id === 'string' ? a.id.trim() : ''
    if (!AGENT_ID_RE.test(id)) {
      throw new Error(`agents[${idx}].id "${id}" is invalid (must match ${AGENT_ID_RE})`)
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate agent id "${id}" in agents.json`)
    }
    seenIds.add(id)

    let role: AlfredRoleId | undefined
    if (a.role !== undefined) {
      if (typeof a.role !== 'string' || !normalizeRoleId(a.role)) {
        throw new Error(`agents[${idx}] (${id}): unknown role "${String(a.role)}". Allowed: tervezo, technikus, szakmunkas, segedmunkas`)
      }
      role = normalizeRoleId(a.role)!
    }
    const roleDef = role ? roles[role] : undefined

    const provider = (a.provider ?? roleDef?.provider ?? defaultProvider) as string
    if (!ALLOWED_PROVIDERS.has(provider as AlfredProviderName)) {
      throw new Error(`agents[${idx}] (${id}): unsupported provider "${String(provider)}". Allowed: ${[...ALLOWED_PROVIDERS].join(', ')}`)
    }

    const model = typeof a.model === 'string' && a.model.trim()
      ? a.model.trim()
      : (roleDef?.model ?? defaultModel)
    const displayName = typeof a.displayName === 'string' && a.displayName.trim() ? a.displayName.trim() : id
    const channelName = typeof a.channelName === 'string' && a.channelName.trim() ? a.channelName.trim() : `#${id}`
    const rawChannelId = typeof a.discordChannelId === 'string' ? a.discordChannelId.trim() : ''
    const discordChannelId = interpolateEnvPlaceholders(rawChannelId, envMap)

    if (discordChannelId && !discordChannelId.startsWith('${')) {
      if (seenChannels.has(discordChannelId)) {
        throw new Error(`Duplicate discordChannelId "${discordChannelId}" assigned to multiple agents`)
      }
      seenChannels.add(discordChannelId)
    }

    if (!Array.isArray(a.tools)) {
      throw new Error(`agents[${idx}] (${id}): "tools" whitelist array is required`)
    }
    const tools: AllowedToolName[] = []
    for (const t of a.tools) {
      const toolName = String(t).trim() as AllowedToolName
      if (!CANONICAL_TOOLS.has(toolName)) {
        throw new Error(
          `agents[${idx}] (${id}): unknown tool "${String(t)}" in whitelist. Allowed: ${[...CANONICAL_TOOLS].join(', ')}`,
        )
      }
      if (!tools.includes(toolName)) {
        tools.push(toolName)
      }
    }

      let protectedPaths: string[] | undefined
      if (a.protectedPaths !== undefined) {
        if (!Array.isArray(a.protectedPaths)) {
          throw new Error(`agents[${idx}] (${id}): "protectedPaths" must be an array of strings`)
        }
        protectedPaths = []
        for (const rawRule of a.protectedPaths) {
          if (typeof rawRule !== 'string' || !rawRule.trim()) {
            throw new Error(`agents[${idx}] (${id}): "protectedPaths" entries must be non-empty strings`)
          }
          const normalizedRule = normalizeProtectedPathRule(rawRule, id, idx)
          if (!protectedPaths.includes(normalizedRule)) {
            protectedPaths.push(normalizedRule)
          }
        }
      }

      let allowedBashCommands: string[] | undefined
      if (a.allowedBashCommands !== undefined) {
        if (!Array.isArray(a.allowedBashCommands)) {
          throw new Error(`agents[${idx}] (${id}): "allowedBashCommands" must be an array of strings`)
        }
        allowedBashCommands = []
        for (const rawCmd of a.allowedBashCommands) {
          if (typeof rawCmd !== 'string' || !rawCmd.trim()) {
            throw new Error(`agents[${idx}] (${id}): "allowedBashCommands" entries must be non-empty strings`)
          }
          const normalizedCmd = rawCmd.trim().replace(/\s+/g, ' ')
          if (!allowedBashCommands.includes(normalizedCmd)) {
            allowedBashCommands.push(normalizedCmd)
          }
        }
      }

      let bashTimeoutMs: number | undefined
      if (a.bashTimeoutMs !== undefined) {
        if (typeof a.bashTimeoutMs !== 'number' || !Number.isInteger(a.bashTimeoutMs) || a.bashTimeoutMs < 1000 || a.bashTimeoutMs > 600_000) {
          throw new Error(`agents[${idx}] (${id}): "bashTimeoutMs" must be an integer between 1000 and 600000`)
        }
        bashTimeoutMs = a.bashTimeoutMs
      }

      let maxToolIterations: number | undefined
      if (a.maxToolIterations !== undefined) {
        if (typeof a.maxToolIterations !== 'number' || !Number.isInteger(a.maxToolIterations) || a.maxToolIterations < 1 || a.maxToolIterations > 50) {
          throw new Error(`agents[${idx}] (${id}): "maxToolIterations" must be an integer between 1 and 50`)
        }
        maxToolIterations = a.maxToolIterations
      }

      const rawWs = typeof a.workspace === 'string' && a.workspace.trim() ? a.workspace.trim() : undefined
      const normRawWs = rawWs
        ? rawWs.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.'
        : undefined
      const isProjectRootWs = normRawWs === '.'

      let workspaceRel: string
      let workspaceAbsPath: string

      if (isProjectRootWs) {
        workspaceRel = '.'
        workspaceAbsPath = projectRootAbs
        if (tools.some((t) => MUTATING_TOOLS.has(t)) && (!protectedPaths || protectedPaths.length === 0)) {
          throw new Error(
            `Security violation: agent(${id}) with workspace "." and mutating tools must configure non-empty "protectedPaths"`,
          )
        }
      } else if (!rawWs) {
        workspaceRel = `${workspacesRoot.replace(/\/+$/, '')}/${id}`
        workspaceAbsPath = resolveInsideBase(workspacesBaseAbs, id, `agent(${id}).workspace`)
      } else if (
        runtimeEnv.workspacesDir &&
        (normRawWs === normJsonWsRoot || normRawWs!.startsWith(`${normJsonWsRoot}/`))
      ) {
        const suffix = normRawWs === normJsonWsRoot ? '.' : normRawWs!.slice(normJsonWsRoot.length + 1)
        workspaceAbsPath = resolveInsideBase(workspacesBaseAbs, suffix, `agent(${id}).workspace`)
        workspaceRel = isAbsolute(workspacesRoot)
          ? workspaceAbsPath
          : (suffix === '.' ? workspacesRoot : `${workspacesRoot.replace(/\/+$/, '')}/${suffix}`)
      } else {
        workspaceRel = rawWs
        workspaceAbsPath = isAbsolute(workspacesRoot)
          ? resolveInsideBase(workspacesBaseAbs, rawWs, `agent(${id}).workspace`)
          : resolveInsideBase(projectRoot, rawWs, `agent(${id}).workspace`)
        resolveInsideBase(workspacesBaseAbs, workspaceAbsPath, `agent(${id}).workspace`)
      }

      if (protectedPaths) {
        for (const rule of protectedPaths) {
          resolveInsideBase(workspaceAbsPath, rule.replace(/\/+$/, '') || '.', `agent(${id}).protectedPaths`)
        }
      }

      const memoryNamespace = typeof a.memoryNamespace === 'string' && a.memoryNamespace.trim()
        ? a.memoryNamespace.trim()
        : id
      if (!AGENT_ID_RE.test(memoryNamespace)) {
        throw new Error(`agents[${idx}] (${id}): invalid memoryNamespace "${memoryNamespace}"`)
      }
      if (seenMemoryNamespaces.has(memoryNamespace)) {
        throw new Error(`Duplicate memoryNamespace "${memoryNamespace}" across agents; each agent must have an isolated memory namespace`)
      }
      seenMemoryNamespaces.add(memoryNamespace)

      const rawAgentBudget = typeof a.dailyBudgetUsd === 'number' && Number.isFinite(a.dailyBudgetUsd) && a.dailyBudgetUsd >= 0
        ? a.dailyBudgetUsd
      : jsonGlobalBudget
      const agentBudget = roundUsd(rawAgentBudget * runtimeEnv.budgetMultiplier)

      const allowedUserIds = parseAllowedUserIds(
        Array.isArray(a.allowedUserIds)
          ? a.allowedUserIds.map((u) => interpolateEnvPlaceholders(String(u), envMap))
          : undefined,
      )

      const soulFile = typeof a.soulFile === 'string' && a.soulFile.trim() ? a.soulFile.trim() : undefined
      const systemPrompt = typeof a.systemPrompt === 'string' && a.systemPrompt.trim() ? a.systemPrompt.trim() : undefined
      const skills = Array.isArray(a.skills)
        ? a.skills.filter((s): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s.trim())).map((s) => s.trim())
        : undefined
      const resolvedSystemPrompt = loadAgentSystemPrompt(projectRoot, soulFile, systemPrompt, skills)

      agents.push({
        id,
        displayName,
        channelName,
        discordChannelId,
        ...(role ? { role } : {}),
        provider: provider as AlfredProviderName,
        model,
        workspace: workspaceRel,
        workspaceAbsPath,
        memoryNamespace,
        dailyBudgetUsd: agentBudget,
        allowedUserIds,
        tools,
        ...(protectedPaths !== undefined ? { protectedPaths } : {}),
        ...(allowedBashCommands !== undefined ? { allowedBashCommands } : {}),
        ...(bashTimeoutMs !== undefined ? { bashTimeoutMs } : {}),
        ...(maxToolIterations !== undefined ? { maxToolIterations } : {}),
        soulFile,
        ...(skills && skills.length > 0 ? { skills } : {}),
        systemPrompt,
        resolvedSystemPrompt,
      })
    }

    if (runtimeEnv.enabledAgentIds && runtimeEnv.enabledAgentIds.length > 0) {
      for (const requestedId of runtimeEnv.enabledAgentIds) {
        if (!seenIds.has(requestedId)) {
          throw new Error(`Invalid ALFRED_ENABLED_AGENTS: unknown agent id "${requestedId}"`)
        }
      }
      const enabledSet = new Set(runtimeEnv.enabledAgentIds)
      agents = agents.filter((ag) => enabledSet.has(ag.id))
    }

    if (opts.provisionWorkspaces !== false) {
      for (const ag of agents) {
        mkdirSync(ag.workspaceAbsPath, { recursive: true })
      }
    }

    logger.debug(
      {
        agentCount: agents.length,
        configPath: fullConfigPath,
        runtimeMode: runtimeEnv.mode,
        budgetMultiplier: runtimeEnv.budgetMultiplier,
      },
      'Alfred agents configuration loaded',
    )

    return {
      version: typeof root.version === 'number' ? root.version : 1,
      global: {
        defaultProvider,
        defaultModel,
        dailyBudgetUsd,
        budgetMultiplier: runtimeEnv.budgetMultiplier,
        runtimeMode: runtimeEnv.mode,
        workspacesRoot,
      },
      roles,
      agents,
    }
  }

  /**
   * Look up the agent assigned to a given Discord channel ID.
   */
  export function getAgentByChannelId(
    config: AlfredAgentsConfig,
    channelId: string,
  ): AlfredAgentDefinition | null {
    const clean = channelId.trim()
    if (!clean) return null
    return config.agents.find((a) => a.discordChannelId === clean) ?? null
  }

  /**
   * Look up an agent by its ID.
   */
  export function getAgentById(
    config: AlfredAgentsConfig,
    agentId: string,
  ): AlfredAgentDefinition | null {
    const clean = agentId.trim()
    if (!clean) return null
    return config.agents.find((a) => a.id === clean) ?? null
  }

  /**
   * Multi-user authorization check:
   * - Global `ALLOWED_USER_IDS` defines the authorized operator pool.
   * - If an agent also defines a non-empty `allowedUserIds` array, the user must be in the agent's list
   *   (and if global `ALLOWED_USER_IDS` is non-empty, in the global list or explicitly granted on the agent).
   * - Fail-closed: if neither global nor agent-level allowed user IDs are configured, no user is allowed.
   */
  export function isUserAllowedForAgent(
    userId: string,
    agent: AlfredAgentDefinition,
    globalAllowedUserIds: readonly string[],
  ): boolean {
    const cleanUser = userId.trim()
    if (!SNOWFLAKE_RE.test(cleanUser)) return false

    if (agent.allowedUserIds.length > 0) {
      return agent.allowedUserIds.includes(cleanUser)
    }
    if (globalAllowedUserIds.length > 0) {
      return globalAllowedUserIds.includes(cleanUser)
    }
    return false
  }
