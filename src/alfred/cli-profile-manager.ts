/**
 * Per-Agent Multi-CLI Profile Isolation, Shared SKILL.md Scanner/Sync & MCP/Vault Translator.
 *
 * Built directly on top of inherited Marveen modules:
 * - `src/skill-scan.ts` (`scanResult`) & `src/web/skill-quarantine.ts` (`SKILL_SCAN_PATTERNS`, `SKILL_HOLD_PATTERNS`)
 * - `src/web/vault.ts` (`getSecret`, `setSecret`, `listSecrets`) & `src/web/mcp-inheritance.ts` (`AGENT_INHERITED_MCP_SERVERS`)
 * - `src/alfred/cli-manager.ts` (`MANAGED_CLI_REGISTRY`, `resolveCliAuthDir`, `normalizeManagedCliId`, `type ManagedCliId`)
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { scanResult, type Finding } from '../skill-scan.js'
import { readInheritableMcpServerNames } from '../web/mcp-inheritance.js'
import { SKILL_HOLD_PATTERNS, SKILL_SCAN_PATTERNS } from '../web/skill-quarantine.js'
import { getSecret, setSecret } from '../web/vault.js'
import type { AlfredAgentDefinition, AlfredCliProviderName } from './agents-config.js'
import {
  MANAGED_CLI_REGISTRY,
  normalizeManagedCliId,
  resolveCliAuthDir,
  type ManagedCliId,
} from './cli-manager.js'

const ALL_CLI_IDS: readonly ManagedCliId[] = ['claude', 'codex', 'gemini', 'agy'] as const

const CLI_OAUTH_CANDIDATE_FILES: Record<ManagedCliId, readonly string[]> = {
  claude: ['.credentials.json', 'credentials.json', '.oauth-token'],
  codex: ['auth.json', 'credentials.json'],
  gemini: ['oauth_creds.json', 'google_accounts.json'],
  agy: ['antigravity-oauth-token', 'credentials.json', 'oauth_creds.json', 'auth.json', 'tokens.json', 'token.json'],
}

export interface SkillSecurityScanReport {
  status: 'clean' | 'warning' | 'flagged'
  blocked: boolean
  findings: Array<{ category: string; pattern: string; match?: string }>
}

export interface McpServerRecord {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'stdio' | 'http' | 'sse'
  url?: string
  headers?: Record<string, string>
}

export interface AgentCliProfileSyncResult {
  cliId: ManagedCliId
  agentId: string
  profileDir: string
  copiedOAuthFiles: string[]
  syncedSkills: string[]
  syncedMcpServers: string[]
  configFilesWritten: string[]
}

export function resolveUserHome(env: NodeJS.ProcessEnv = process.env, homeOverride?: string): string {
  const candidate = (homeOverride ?? env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()).trim()
  return resolve(candidate || os.homedir())
}

export function resolveCliProfilesRoot(env: NodeJS.ProcessEnv = process.env, homeOverride?: string): string {
  const explicit = env['ALFRED_CLI_PROFILES_DIR']?.trim()
  if (explicit) return resolve(explicit)
  const home = resolveUserHome(env, homeOverride)
  return join(home, '.cli-profiles')
}

export function resolveAgentCliProfileDir(
  cliOrProvider: ManagedCliId | AlfredCliProviderName | string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeOverride?: string,
): string {
  const cliId = normalizeManagedCliId(cliOrProvider)
  const safeAgentId = agentId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(resolveCliProfilesRoot(env, homeOverride), cliId, safeAgentId)
}

/**
 * Deterministic security scanner combining `src/skill-scan.ts` and `src/web/skill-quarantine.ts`.
 */
export function scanSkillMarkdownContent(content: string): SkillSecurityScanReport {
  const baseResult = scanResult(content)
  const baseFindings: Finding[] = baseResult.findings
  const findings: Array<{ category: string; pattern: string; match?: string }> = baseFindings.map((f) => ({
    category: f.category,
    pattern: f.rule,
    match: f.match,
  }))

  let blocked = baseFindings.some((f) => f.category === 'injection')
  for (const [label, re] of SKILL_SCAN_PATTERNS) {
    if (re.test(content)) {
      if (!findings.some((f) => f.pattern === label)) {
        findings.push({ category: 'quarantine_pattern', pattern: label })
      }
      if (SKILL_HOLD_PATTERNS.has(label)) {
        blocked = true
      }
    }
  }

  const status: 'clean' | 'warning' | 'flagged' = blocked
    ? 'flagged'
    : findings.length > 0
      ? 'warning'
      : 'clean'

  return { status, blocked, findings }
}

/**
 * Copies host OAuth credential files (`~/.claude/.credentials.json`, `~/.gemini/antigravity-cli/antigravity-oauth-token`,
 * `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`) into the agent's isolated profile directory with 0600 permissions.
 */
export function syncOAuthToAgentProfile(
  cliId: ManagedCliId,
  profileDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homeOverride?: string,
): string[] {
  const def = MANAGED_CLI_REGISTRY[cliId]
  // Always read from the host global auth dir (ignoring profile override)
  const cleanEnv: Record<string, string | undefined> = { ...env }
  delete cleanEnv[def.configEnvVar]
  if (homeOverride) {
    cleanEnv['HOME'] = homeOverride
  }
  const hostAuthDir = resolveCliAuthDir(def, cleanEnv)
  const copied: string[] = []

  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(profileDir, 0o700)
  } catch {
    // Windows chmod no-op
  }

  for (const fileName of CLI_OAUTH_CANDIDATE_FILES[cliId]) {
    const srcPath = join(hostAuthDir, fileName)
    if (!existsSync(srcPath)) continue
    try {
      const srcStat = statSync(srcPath)
      if (!srcStat.isFile() || srcStat.size === 0) continue
      const destPath = join(profileDir, fileName)
      let shouldCopy = !existsSync(destPath)
      if (!shouldCopy) {
        try {
          const destStat = statSync(destPath)
          if (srcStat.mtimeMs >= destStat.mtimeMs || srcStat.size !== destStat.size) {
            shouldCopy = true
          }
        } catch {
          shouldCopy = true
        }
      }
      if (shouldCopy) {
        mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 })
        copyFileSync(srcPath, destPath)
        try {
          chmodSync(destPath, 0o600)
        } catch {
          // Windows chmod no-op
        }
      }
      copied.push(fileName)
    } catch {
      // ignore individual file errors
    }
  }

  return copied
}

export function resolveSharedSkillsRoot(projectRoot: string = PROJECT_ROOT, env: NodeJS.ProcessEnv = process.env): string {
  const custom = env['ALFRED_SKILLS_DIR']?.trim()
  return custom ? resolve(custom) : join(projectRoot, 'skills')
}

export function readSharedSkillsMap(
  projectRoot: string = PROJECT_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, { id: string; content: string; scan: SkillSecurityScanReport }> {
  const root = resolveSharedSkillsRoot(projectRoot, env)
  const map = new Map<string, { id: string; content: string; scan: SkillSecurityScanReport }>()
  if (!existsSync(root)) return map
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(root, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      const content = readFileSync(skillFile, 'utf-8')
      map.set(entry.name, {
        id: entry.name,
        content,
        scan: scanSkillMarkdownContent(content),
      })
    } catch {
      // skip unreadable
    }
  }
  return map
}

function syncSkillFolderSet(
  targetSkillsRoot: string,
  allowedSkillIds: readonly string[],
  skillsMap: Map<string, { id: string; content: string; scan: SkillSecurityScanReport }>,
): string[] {
  mkdirSync(targetSkillsRoot, { recursive: true })
  const allowedSet = new Set(allowedSkillIds)
  const synced: string[] = []

  // Remove skills no longer assigned to this target
  try {
    for (const entry of readdirSync(targetSkillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!allowedSet.has(entry.name)) {
        rmSync(join(targetSkillsRoot, entry.name), { recursive: true, force: true })
      }
    }
  } catch {
    // ignore cleanup error
  }

  for (const id of allowedSkillIds) {
    const skill = skillsMap.get(id)
    if (!skill || skill.scan.blocked) continue
    const dir = join(targetSkillsRoot, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skill.content, 'utf-8')
    synced.push(id)
  }

  return synced
}

export function resolveMcpJsonPath(projectRoot: string = PROJECT_ROOT, env: NodeJS.ProcessEnv = process.env): string {
  const custom = env['ALFRED_MCP_CONFIG_PATH']?.trim()
  return custom ? resolve(custom) : join(projectRoot, '.mcp.json')
}

export function readSharedMcpServers(
  projectRoot: string = PROJECT_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, McpServerRecord> {
  const mcpPath = resolveMcpJsonPath(projectRoot, env)
  if (!existsSync(mcpPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers?: Record<string, McpServerRecord> }
    if (!raw || typeof raw !== 'object' || !raw.mcpServers || typeof raw.mcpServers !== 'object') return {}
    return raw.mcpServers
  } catch {
    return {}
  }
}

export function writeSharedMcpServers(
  servers: Record<string, McpServerRecord>,
  projectRoot: string = PROJECT_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const mcpPath = resolveMcpJsonPath(projectRoot, env)
  mkdirSync(dirname(mcpPath), { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }
  existing['mcpServers'] = servers
  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  return mcpPath
}

const SECRET_ENV_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|BEARER|AUTH)/i

/**
 * Stores sensitive MCP environment variables in `src/web/vault.ts` and replaces their `.mcp.json` value with `vault:<secretId>`.
 */
export function vaultMcpServerSecrets(
  serverName: string,
  envVars: Record<string, string> | undefined,
): { storedEnv: Record<string, string>; vaultedKeys: string[] } {
  if (!envVars) return { storedEnv: {}, vaultedKeys: [] }
  const storedEnv: Record<string, string> = {}
  const vaultedKeys: string[] = []

  for (const [k, v] of Object.entries(envVars)) {
    const key = k.trim()
    const val = String(v ?? '').trim()
    if (!key || !val) continue
    if (val.startsWith('vault:')) {
      storedEnv[key] = val
      vaultedKeys.push(key)
      continue
    }
    if (SECRET_ENV_KEY_RE.test(key)) {
      try {
        const secretId = `mcp_${serverName}_${key}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_')
        setSecret(secretId, `MCP: ${serverName} (${key})`, val)
        storedEnv[key] = `vault:${secretId}`
        vaultedKeys.push(key)
        continue
      } catch {
        // Fallback if vault fails in read-only test
      }
    }
    storedEnv[key] = val
  }

  return { storedEnv, vaultedKeys }
}

/**
 * Resolves `vault:<secretId>` placeholders via `src/web/vault.ts` `getSecret()` for isolated 0600 CLI profile configs.
 */
export function resolveVaultEnvMap(envVars: Record<string, string> | undefined): Record<string, string> {
  if (!envVars) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(envVars)) {
    if (typeof v === 'string' && v.startsWith('vault:')) {
      const secretId = v.slice('vault:'.length).trim()
      try {
        const resolved = getSecret(secretId)
        if (typeof resolved === 'string' && resolved.length > 0) {
          out[k] = resolved
          continue
        }
      } catch {
        // leave unresolved if vault unavailable
      }
    }
    out[k] = v
  }
  return out
}

export function resolveAgentMcpServers(
  agent: Pick<AlfredAgentDefinition, 'id' | 'mcpServers'>,
  allServers: Record<string, McpServerRecord>,
): Record<string, McpServerRecord> {
  const selected: Record<string, McpServerRecord> = {}
  const explicitList = agent.mcpServers
  const inheritable = readInheritableMcpServerNames()
  const allowedNames = explicitList
    ? new Set(explicitList)
    : new Set(
        Object.keys(allServers).filter(
          (name) => inheritable.size === 0 || inheritable.has(name) || !name.startsWith('internal-'),
        ),
      )

  for (const [name, cfg] of Object.entries(allServers)) {
    if (!allowedNames.has(name)) continue
    selected[name] = {
      ...cfg,
      ...(cfg.env ? { env: resolveVaultEnvMap(cfg.env) } : {}),
    }
  }
  return selected
}

const CODEX_MCP_BEGIN = '# BEGIN ALFRED MANAGED MCP'
const CODEX_MCP_END = '# END ALFRED MANAGED MCP'

function escapeTomlString(val: string): string {
  return JSON.stringify(val)
}

export function formatCodexMcpTomlBlock(servers: Record<string, McpServerRecord>): string {
  const lines: string[] = [CODEX_MCP_BEGIN]
  for (const [name, srv] of Object.entries(servers)) {
    const safeKey = /^[A-Za-z0-9_-]+$/.test(name) ? name : escapeTomlString(name)
    lines.push(`[mcp_servers.${safeKey}]`)
    if (srv.command) {
      lines.push(`command = ${escapeTomlString(srv.command)}`)
    }
    if (Array.isArray(srv.args) && srv.args.length > 0) {
      lines.push(`args = [${srv.args.map((a) => escapeTomlString(String(a))).join(', ')}]`)
    }
    if (srv.url) {
      lines.push(`url = ${escapeTomlString(srv.url)}`)
    }
    if (srv.env && Object.keys(srv.env).length > 0) {
      lines.push(`[mcp_servers.${safeKey}.env]`)
      for (const [ek, ev] of Object.entries(srv.env)) {
        const safeEnvKey = /^[A-Za-z0-9_]+$/.test(ek) ? ek : escapeTomlString(ek)
        lines.push(`${safeEnvKey} = ${escapeTomlString(String(ev))}`)
      }
    }
    lines.push('')
  }
  lines.push(CODEX_MCP_END)
  return lines.join('\n')
}

export function upsertCodexConfigToml(configTomlPath: string, servers: Record<string, McpServerRecord>): void {
  mkdirSync(dirname(configTomlPath), { recursive: true, mode: 0o700 })
  let existing = ''
  if (existsSync(configTomlPath)) {
    try {
      existing = readFileSync(configTomlPath, 'utf-8')
    } catch {
      existing = ''
    }
  }
  const block = formatCodexMcpTomlBlock(servers)
  const beginIdx = existing.indexOf(CODEX_MCP_BEGIN)
  const endIdx = existing.indexOf(CODEX_MCP_END)
  let nextContent: string
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).trimEnd()
    const after = existing.slice(endIdx + CODEX_MCP_END.length).trimStart()
    nextContent = [before, block, after].filter(Boolean).join('\n\n') + '\n'
  } else {
    const trimmed = existing.trimEnd()
    nextContent = (trimmed ? `${trimmed}\n\n${block}` : block) + '\n'
  }
  writeFileSync(configTomlPath, nextContent, { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(configTomlPath, 0o600)
  } catch {
    // Windows chmod no-op
  }
}

function mergeJsonMcpFile(
  filePath: string,
  servers: Record<string, McpServerRecord>,
  extraDefaults: Record<string, unknown> = {},
): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  let obj: Record<string, unknown> = { ...extraDefaults }
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = { ...extraDefaults, ...parsed }
      }
    } catch {
      obj = { ...extraDefaults }
    }
  }
  obj['mcpServers'] = servers
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows chmod no-op
  }
}

export function writeCliMcpConfigs(
  cliId: ManagedCliId,
  targetDir: string,
  servers: Record<string, McpServerRecord>,
): string[] {
  const written: string[] = []
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  if (cliId === 'claude') {
    const claudeJson = join(targetDir, '.claude.json')
    const mcpJson = join(targetDir, '.mcp.json')
    mergeJsonMcpFile(claudeJson, servers)
    mergeJsonMcpFile(mcpJson, servers)
    written.push(claudeJson, mcpJson)
  } else if (cliId === 'gemini') {
    const settingsJson = join(targetDir, 'settings.json')
    mergeJsonMcpFile(settingsJson, servers, { trustedFolder: true })
    written.push(settingsJson)
  } else if (cliId === 'agy') {
    const mcpConfigJson = join(targetDir, 'mcp_config.json')
    const settingsJson = join(targetDir, 'settings.json')
    mergeJsonMcpFile(mcpConfigJson, servers)
    mergeJsonMcpFile(settingsJson, servers)
    written.push(mcpConfigJson, settingsJson)
  } else if (cliId === 'codex') {
    const configToml = join(targetDir, 'config.toml')
    upsertCodexConfigToml(configToml, servers)
    written.push(configToml)
  }
  return written
}

/**
 * Ensures an isolated per-agent CLI profile exists at `<HOME>/.cli-profiles/<cliId>/<agentId>`
 * with inherited OAuth credentials, agent-scoped SKILL.md files, and translated MCP configuration.
 */
export function ensureAgentCliProfile(opts: {
  agent: Pick<AlfredAgentDefinition, 'id' | 'skills' | 'mcpServers'>
  cliOrProvider: ManagedCliId | AlfredCliProviderName | string
  projectRoot?: string
  env?: NodeJS.ProcessEnv
  homeOverride?: string
}): AgentCliProfileSyncResult {
  const env = opts.env ?? process.env
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT
  const cliId = normalizeManagedCliId(opts.cliOrProvider)
  const profileDir = resolveAgentCliProfileDir(cliId, opts.agent.id, env, opts.homeOverride)

  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  const copiedOAuthFiles = syncOAuthToAgentProfile(cliId, profileDir, env, opts.homeOverride)

  const skillsMap = readSharedSkillsMap(projectRoot, env)
  const agentSkillIds = opts.agent.skills ?? []
  const syncedSkills = syncSkillFolderSet(join(profileDir, 'skills'), agentSkillIds, skillsMap)

  const allMcp = readSharedMcpServers(projectRoot, env)
  const agentMcp = resolveAgentMcpServers(opts.agent, allMcp)
  const configFilesWritten = writeCliMcpConfigs(cliId, profileDir, agentMcp)

  return {
    cliId,
    agentId: opts.agent.id,
    profileDir,
    copiedOAuthFiles,
    syncedSkills,
    syncedMcpServers: Object.keys(agentMcp),
    configFilesWritten,
  }
}

/**
 * Synchronizes shared skills and MCP configurations across all 4 global CLI folders AND all per-agent isolated profiles.
 */
export function syncAllCliProfilesAndDirectories(opts: {
  agents: Array<Pick<AlfredAgentDefinition, 'id' | 'skills' | 'mcpServers'>>
  projectRoot?: string
  env?: NodeJS.ProcessEnv
  homeOverride?: string
}): {
  profilesRoot: string
  globalSkillDirs: string[]
  globalMcpFiles: string[]
  agentProfiles: AgentCliProfileSyncResult[]
} {
  const env = opts.env ?? process.env
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT
  const home = resolveUserHome(env, opts.homeOverride)
  const profilesRoot = resolveCliProfilesRoot(env, opts.homeOverride)
  mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })

  const skillsMap = readSharedSkillsMap(projectRoot, env)
  const allCleanSkillIds = Array.from(skillsMap.values())
    .filter((s) => !s.scan.blocked)
    .map((s) => s.id)

  // 1. Sync active skills into the 4 CLI workspace & user skill directories
  const globalSkillTargets = [
    join(projectRoot, '.claude', 'skills'),
    join(projectRoot, '.gemini', 'skills'),
    join(projectRoot, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.gemini', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.codex', 'skills'),
  ]
  const globalSkillDirs: string[] = []
  for (const targetDir of globalSkillTargets) {
    try {
      syncSkillFolderSet(targetDir, allCleanSkillIds, skillsMap)
      globalSkillDirs.push(targetDir)
    } catch {
      // ignore if read-only in restricted sandbox
    }
  }

  // 2. Sync shared MCP servers into the 4 host CLI config directories
  const allMcp = readSharedMcpServers(projectRoot, env)
  const resolvedGlobalMcp: Record<string, McpServerRecord> = {}
  for (const [name, cfg] of Object.entries(allMcp)) {
    resolvedGlobalMcp[name] = {
      ...cfg,
      ...(cfg.env ? { env: resolveVaultEnvMap(cfg.env) } : {}),
    }
  }
  const globalMcpFiles: string[] = []
  for (const cliId of ALL_CLI_IDS) {
    try {
      const def = MANAGED_CLI_REGISTRY[cliId]
      const hostEnv: Record<string, string | undefined> = { ...env }
      if (opts.homeOverride) hostEnv['HOME'] = opts.homeOverride
      const hostDir = resolveCliAuthDir(def, hostEnv)
      globalMcpFiles.push(...writeCliMcpConfigs(cliId, hostDir, resolvedGlobalMcp))
    } catch {
      // ignore if read-only
    }
  }

  // 3. Sync per-agent isolated profiles across all 4 CLIs
  const agentProfiles: AgentCliProfileSyncResult[] = []
  for (const agent of opts.agents) {
    for (const cliId of ALL_CLI_IDS) {
      try {
        agentProfiles.push(
          ensureAgentCliProfile({
            agent,
            cliOrProvider: cliId,
            projectRoot,
            env,
            homeOverride: opts.homeOverride,
          }),
        )
      } catch {
        // ignore individual profile sync errors
      }
    }
  }

  return {
    profilesRoot,
    globalSkillDirs,
    globalMcpFiles,
    agentProfiles,
  }
}
