import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import {
  getDb,
  getInstalledModuleRow,
  listInstalledModuleRows,
  upsertInstalledModuleRow,
  type InstalledModuleRow,
  type ModuleLifecycleState,
} from '../db.js'
import { readEnvFile } from '../env.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { listSecrets } from '../web/vault.js'
import {
  CANONICAL_TOOLS,
  loadAlfredAgentsConfig,
  resolveInsideBase,
  type AlfredAgentDefinition,
  type AlfredProviderName,
  type AlfredRoleId,
  type AllowedToolName,
} from './agents-config.js'
import {
  resolveSharedSkillsRoot,
  scanSkillMarkdownContent,
  syncAllCliProfilesAndDirectories,
} from './cli-profile-manager.js'

export type ModuleCategory = 'core' | 'storage' | 'compute' | 'automation' | 'security'

export type ModuleErrorCode =
  | 'INVALID_ID'
  | 'MODULE_NOT_FOUND'
  | 'BUILTIN_MODULE_LOCKED'
  | 'DEPENDENT_MODULES_ACTIVE'
  | 'MISSING_MODULE_DEPENDENCIES'
  | 'CYCLIC_MODULE_DEPENDENCY'
  | 'AGENT_PACKAGE_NOT_FOUND'
  | 'MISSING_REQUIRED_MODULES'
  | 'SKILL_SECURITY_SCAN_BLOCKED'
  | 'PROTECTED_CORE_AGENT'

export class ModuleManagerError extends Error {
  public readonly code: ModuleErrorCode
  public readonly statusHttp: 400 | 404 | 409
  public readonly details?: Record<string, unknown>

  constructor(
    code: ModuleErrorCode,
    statusHttp: 400 | 404 | 409,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ModuleManagerError'
    this.code = code
    this.statusHttp = statusHttp
    this.details = details
  }
}

export interface ModuleManifest {
  id: string
  name: string
  category: ModuleCategory
  version: string
  description: string
  depends: string[]
  requiredSecrets: string[]
  tools: AllowedToolName[]
  uiCardIds: string[]
  ramImpactMb: number
  builtIn: boolean
  defaultEnabled: boolean
}

export interface DependentAgentRef {
  id: string
  displayName: string
}

export interface ModuleStatusView extends ModuleManifest {
  state: ModuleLifecycleState
  installedAt: string | null
  updatedAt: string | null
  missingSecrets: string[]
  missingDependencies: string[]
  /** Other active system modules whose `depends` includes this module */
  activeDependentModules: string[]
  /** Currently enabled installed agents whose catalog `requiredModules` includes this module */
  activeDependentAgents: DependentAgentRef[]
}

export interface AgentPackageManifest {
  id: string
  displayName: string
  role: AlfredRoleId
  category: string
  description: string
  requiredModules: string[]
  recommendedProvider: AlfredProviderName
  recommendedModel: string
  dailyBudgetUsd: number
  tools: AllowedToolName[]
  skills: string[]
  optionalEnvVars: string[]
  workspace?: string
  protectedPaths?: string[]
}

export interface AgentPackageStatusView extends AgentPackageManifest {
  installed: boolean
  enabled: boolean
  /** Modules required by this package that do not exist yet on disk */
  missingModules: string[]
  /** Modules required by this package that exist on disk but are not currently active */
  inactiveModules: string[]
  /** Missing optional env/Vault keys */
  missingOptionalEnv: string[]
  /** Preview of SOUL.md for the UI detail drawer (max 2500 chars) */
  soulPreview: string
}

export interface ModuleManagerOptions {
  db?: Database.Database
  projectRoot?: string
  env?: Record<string, string | undefined>
  configPaths?: string[]
  homeOverride?: string
  /** Optional pre-resolved secret IDs (for isolated unit tests) */
  secretIds?: ReadonlySet<string>
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const ALLOWED_CATEGORIES: ReadonlySet<ModuleCategory> = new Set([
  'core',
  'storage',
  'compute',
  'automation',
  'security',
])
const PROTECTED_CORE_AGENTS: ReadonlySet<string> = new Set([
  'alfred',
  'alfred-core',
  'alfred-ops',
])
const SOUL_PREVIEW_MAX_CHARS = 2500

// Lightweight in-memory manifest cache keyed by resolved projectRoot (<10 KB RSS, 0 disk I/O per LLM turn).
const moduleManifestCache = new Map<string, Map<string, ModuleManifest>>()

export function invalidateModuleManifestCache(projectRoot?: string): void {
  if (projectRoot) {
    moduleManifestCache.delete(resolve(projectRoot))
  } else {
    moduleManifestCache.clear()
  }
}

function assertValidId(rawId: string, kind: 'module' | 'agent' | 'skill'): string {
  const id = String(rawId || '').trim()
  if (!SAFE_ID_RE.test(id)) {
    throw new ModuleManagerError(
      'INVALID_ID',
      400,
      `Invalid ${kind} id "${rawId}" (must match ${SAFE_ID_RE})`,
    )
  }
  return id
}

function resolveProjectRoot(opts?: ModuleManagerOptions): string {
  return resolve(opts?.projectRoot ?? PROJECT_ROOT)
}

function resolveEnvMap(opts?: ModuleManagerOptions): Record<string, string | undefined> {
  if (opts?.env) return opts.env
  try {
    return { ...readEnvFile(), ...process.env }
  } catch {
    return { ...process.env }
  }
}

function resolveOptionalDb(opts?: ModuleManagerOptions): Database.Database | null {
  if (opts?.db) return opts.db
  try {
    const d = getDb()
    return d && d.open ? d : null
  } catch {
    return null
  }
}

function requireDb(opts?: ModuleManagerOptions): Database.Database {
  const d = resolveOptionalDb(opts)
  if (!d) {
    throw new Error('SQLite database is not initialized (pass opts.db or call initDatabase() first)')
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS installed_modules (
      module_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
      installed_at TEXT,
      updated_at TEXT,
      config_json TEXT
    )
  `)
  return d
}

function readInstalledRowsMapSafe(d: Database.Database | null): Map<string, InstalledModuleRow> {
  const map = new Map<string, InstalledModuleRow>()
  if (!d) return map
  try {
    for (const row of listInstalledModuleRows(d)) {
      map.set(row.module_id, row)
    }
  } catch {
    // Minimal test DB without installed_modules table: degrade gracefully to manifest defaults
  }
  return map
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function loadModuleManifests(projectRoot: string): Map<string, ModuleManifest> {
  const rootAbs = resolve(projectRoot)
  const cached = moduleManifestCache.get(rootAbs)
  if (cached) return cached

  const result = new Map<string, ModuleManifest>()
  const modulesDir = join(rootAbs, 'modules')
  if (existsSync(modulesDir)) {
    const entries = readdirSync(modulesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_ID_RE.test(d.name))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const dir of entries) {
      const manifestPath = resolveInsideBase(modulesDir, join(dir.name, 'module.json'), 'module.json')
      if (!existsSync(manifestPath)) continue
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
        const id = typeof raw.id === 'string' && SAFE_ID_RE.test(raw.id.trim()) ? raw.id.trim() : dir.name
        const rawCat = typeof raw.category === 'string' ? raw.category.trim() : 'core'
        const category: ModuleCategory = ALLOWED_CATEGORIES.has(rawCat as ModuleCategory)
          ? (rawCat as ModuleCategory)
          : 'core'
        const tools = parseStringArray(raw.tools).filter((t): t is AllowedToolName =>
          CANONICAL_TOOLS.has(t as AllowedToolName),
        )
        const manifest: ModuleManifest = {
          id,
          name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
          category,
          version: typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '1.0.0',
          description: typeof raw.description === 'string' ? raw.description.trim() : '',
          depends: parseStringArray(raw.depends),
          requiredSecrets: parseStringArray(raw.requiredSecrets),
          tools,
          uiCardIds: parseStringArray(raw.uiCardIds),
          ramImpactMb:
            typeof raw.ramImpactMb === 'number' && Number.isFinite(raw.ramImpactMb) && raw.ramImpactMb >= 0
              ? Math.round(raw.ramImpactMb)
              : 0,
          builtIn: raw.builtIn === true,
          defaultEnabled: raw.defaultEnabled === true,
        }
        result.set(manifest.id, manifest)
      } catch {
        // Ignore malformed module.json
      }
    }
  }

  moduleManifestCache.set(rootAbs, result)
  return result
}

function loadCatalogAgentManifests(projectRoot: string): Map<string, { manifest: AgentPackageManifest; dirAbs: string }> {
  const result = new Map<string, { manifest: AgentPackageManifest; dirAbs: string }>()
  const catalogDir = join(resolve(projectRoot), 'catalog', 'agents')
  if (!existsSync(catalogDir)) return result

  const entries = readdirSync(catalogDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SAFE_ID_RE.test(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const dir of entries) {
    const dirAbs = resolveInsideBase(catalogDir, dir.name, 'catalog agent dir')
    const manifestPath = join(dirAbs, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
      const id = typeof raw.id === 'string' && SAFE_ID_RE.test(raw.id.trim()) ? raw.id.trim() : dir.name
      const tools = parseStringArray(raw.tools).filter((t): t is AllowedToolName =>
        CANONICAL_TOOLS.has(t as AllowedToolName),
      )
      const manifest: AgentPackageManifest = {
        id,
        displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : id,
        role: (typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : 'szakmunkas') as AlfredRoleId,
        category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'general',
        description: typeof raw.description === 'string' ? raw.description.trim() : '',
        requiredModules: parseStringArray(raw.requiredModules),
        recommendedProvider: (
          typeof raw.recommendedProvider === 'string' && raw.recommendedProvider.trim()
            ? raw.recommendedProvider.trim()
            : 'deepseek'
        ) as AlfredProviderName,
        recommendedModel:
          typeof raw.recommendedModel === 'string' && raw.recommendedModel.trim()
            ? raw.recommendedModel.trim()
            : 'deepseek-chat',
        dailyBudgetUsd:
          typeof raw.dailyBudgetUsd === 'number' && Number.isFinite(raw.dailyBudgetUsd) && raw.dailyBudgetUsd >= 0
            ? raw.dailyBudgetUsd
            : 3.0,
        tools,
        skills: parseStringArray(raw.skills).filter((s) => SAFE_ID_RE.test(s)),
        optionalEnvVars: parseStringArray(raw.optionalEnvVars),
        ...(typeof raw.workspace === 'string' && raw.workspace.trim() ? { workspace: raw.workspace.trim() } : {}),
        ...(Array.isArray(raw.protectedPaths) ? { protectedPaths: parseStringArray(raw.protectedPaths) } : {}),
      }
      result.set(manifest.id, { manifest, dirAbs })
    } catch {
      // Ignore malformed manifest.json
    }
  }
  return result
}

/**
 * Metadata-only secret presence check: NEVER calls `getSecret()` (avoids scryptSync CPU/RAM spikes
 * and macOS Keychain VaultKeyError on list queries).
 */
function resolvePresentSecretIds(
  env: Record<string, string | undefined>,
  overrideSet?: ReadonlySet<string>,
): Set<string> {
  const present = new Set<string>()
  if (overrideSet) {
    for (const id of overrideSet) present.add(id)
  } else {
    try {
      for (const entry of listSecrets()) {
        if (entry.id) present.add(entry.id)
      }
    } catch {
      // Vault unavailable or empty: fall back to env presence
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v.trim().length > 0) {
      present.add(k)
    }
  }
  return present
}

function resolveEffectiveModuleState(
  manifest: ModuleManifest,
  row: InstalledModuleRow | undefined,
): ModuleLifecycleState {
  if (manifest.builtIn) return 'active'
  if (row) return row.state
  return manifest.defaultEnabled ? 'active' : 'available'
}

function resolveTargetConfigPaths(
  projectRoot: string,
  env: Record<string, string | undefined>,
  explicitPaths?: string[],
): string[] {
  if (explicitPaths && explicitPaths.length > 0) {
    return explicitPaths.filter((p, i, arr) => arr.indexOf(p) === i)
  }
  const configured = env['ALFRED_AGENTS_CONFIG']?.trim()
  const primary = configured
    ? (isAbsolute(configured) ? configured : join(projectRoot, configured))
    : join(projectRoot, 'config', 'agents.json')

  const isProdSync =
    env['ALFRED_ENV'] !== 'test' &&
    projectRoot === resolve(PROJECT_ROOT) &&
    process.platform === 'linux' &&
    existsSync('/opt/alfred-prod/config/agents.json')

  const candidates = isProdSync ? [primary, '/opt/alfred-prod/config/agents.json'] : [primary]
  return candidates.filter((p, i, arr) => arr.indexOf(p) === i)
}

function loadConfiguredAgentsSafe(
  projectRoot: string,
  env: Record<string, string | undefined>,
  configPath?: string,
): AlfredAgentDefinition[] {
  try {
    const cfg = loadAlfredAgentsConfig({
      projectRoot,
      env,
      configPath,
      provisionWorkspaces: false,
      includeDisabled: true,
    })
    return cfg.agents
  } catch {
    return []
  }
}

export function listModules(opts?: ModuleManagerOptions): ModuleStatusView[] {
  const projectRoot = resolveProjectRoot(opts)
  const env = resolveEnvMap(opts)
  const db = resolveOptionalDb(opts)
  const manifests = loadModuleManifests(projectRoot)
  const rowsById = readInstalledRowsMapSafe(db)
  const presentSecrets = resolvePresentSecretIds(env, opts?.secretIds)
  const catalogAgents = loadCatalogAgentManifests(projectRoot)
  const targetConfigPath = resolveTargetConfigPaths(projectRoot, env, opts?.configPaths)[0]
  const configuredAgents = loadConfiguredAgentsSafe(projectRoot, env, targetConfigPath)

  const stateById = new Map<string, ModuleLifecycleState>()
  for (const [id, manifest] of manifests) {
    stateById.set(id, resolveEffectiveModuleState(manifest, rowsById.get(id)))
  }

  const out: ModuleStatusView[] = []
  for (const [id, manifest] of manifests) {
    const row = rowsById.get(id)
    const state = stateById.get(id) ?? 'available'
    const missingSecrets = manifest.requiredSecrets.filter((sec) => !presentSecrets.has(sec))
    const missingDependencies = manifest.depends.filter((dep) => !manifests.has(dep))

    const activeDependentModules: string[] = []
    for (const [otherId, other] of manifests) {
      if (otherId === id) continue
      if (stateById.get(otherId) === 'active' && other.depends.includes(id)) {
        activeDependentModules.push(otherId)
      }
    }

    const activeDependentAgents: DependentAgentRef[] = []
    for (const ag of configuredAgents) {
      if (ag.enabled === false) continue
      const pkg = catalogAgents.get(ag.id)?.manifest
      if (pkg && pkg.requiredModules.includes(id)) {
        activeDependentAgents.push({
          id: ag.id,
          displayName: ag.displayName || pkg.displayName,
        })
      }
    }

    out.push({
      ...manifest,
      state,
      installedAt: row?.installed_at ?? null,
      updatedAt: row?.updated_at ?? null,
      missingSecrets,
      missingDependencies,
      activeDependentModules,
      activeDependentAgents,
    })
  }

  return out
}

export function isModuleActive(moduleId: string, opts?: ModuleManagerOptions): boolean {
  const id = String(moduleId || '').trim()
  if (!SAFE_ID_RE.test(id)) return false
  const projectRoot = resolveProjectRoot(opts)
  const manifests = loadModuleManifests(projectRoot)
  const manifest = manifests.get(id)
  if (!manifest) return false
  if (manifest.builtIn) return true

  const db = resolveOptionalDb(opts)
  if (!db) return manifest.defaultEnabled
  try {
    const row = getInstalledModuleRow(id, db)
    return resolveEffectiveModuleState(manifest, row) === 'active'
  } catch {
    return manifest.defaultEnabled
  }
}

export function resolveToolOwnerModule(
  toolName: string,
  opts?: ModuleManagerOptions,
): { moduleId: string; active: boolean } | null {
  const projectRoot = resolveProjectRoot(opts)
  const manifests = loadModuleManifests(projectRoot)
  for (const manifest of manifests.values()) {
    if (manifest.tools.includes(toolName as AllowedToolName)) {
      return {
        moduleId: manifest.id,
        active: isModuleActive(manifest.id, opts),
      }
    }
  }
  return null
}

export function getActiveToolNames(opts?: ModuleManagerOptions): ReadonlySet<AllowedToolName> {
  const projectRoot = resolveProjectRoot(opts)
  const manifests = loadModuleManifests(projectRoot)
  const db = resolveOptionalDb(opts)
  const rowsById = readInstalledRowsMapSafe(db)
  const active = new Set<AllowedToolName>()

  for (const manifest of manifests.values()) {
    if (resolveEffectiveModuleState(manifest, rowsById.get(manifest.id)) === 'active') {
      for (const tool of manifest.tools) {
        active.add(tool)
      }
    }
  }
  return active
}

export function enableModule(
  moduleId: string,
  opts?: ModuleManagerOptions & { withDependencies?: boolean },
): { module: ModuleStatusView; enabledDependencies: string[] } {
  const id = assertValidId(moduleId, 'module')
  const projectRoot = resolveProjectRoot(opts)
  const db = requireDb(opts)
  const manifests = loadModuleManifests(projectRoot)
  const rootManifest = manifests.get(id)
  if (!rootManifest) {
    throw new ModuleManagerError('MODULE_NOT_FOUND', 404, `Module not found: ${id}`)
  }

  const withDependencies = opts?.withDependencies === true
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const toActivateOrder: string[] = []
  const missingDeps: string[] = []
  const inactiveDeps: string[] = []

  const walk = (curId: string): void => {
    if (visiting.has(curId)) {
      throw new ModuleManagerError(
        'CYCLIC_MODULE_DEPENDENCY',
        400,
        `Cyclic module dependency detected involving "${curId}"`,
        { moduleId: curId },
      )
    }
    if (visited.has(curId)) return
    visiting.add(curId)

    const curManifest = manifests.get(curId)
    if (!curManifest) {
      missingDeps.push(curId)
      visiting.delete(curId)
      return
    }

    for (const depId of curManifest.depends) {
      if (!manifests.has(depId)) {
        if (!missingDeps.includes(depId)) missingDeps.push(depId)
        continue
      }
      walk(depId)
      const depRow = getInstalledModuleRow(depId, db)
      const depState = resolveEffectiveModuleState(manifests.get(depId)!, depRow)
      if (depState !== 'active' && !withDependencies && !inactiveDeps.includes(depId)) {
        inactiveDeps.push(depId)
      }
    }

    visiting.delete(curId)
    visited.add(curId)
    toActivateOrder.push(curId)
  }

  walk(id)

  if (missingDeps.length > 0) {
    throw new ModuleManagerError(
      'MISSING_MODULE_DEPENDENCIES',
      409,
      `Module "${id}" requires missing modules: ${missingDeps.join(', ')}`,
      { missingDependencies: missingDeps },
    )
  }

  if (inactiveDeps.length > 0 && !withDependencies) {
    throw new ModuleManagerError(
      'MISSING_MODULE_DEPENDENCIES',
      409,
      `Module "${id}" requires active dependencies: ${inactiveDeps.join(', ')}`,
      { inactiveDependencies: inactiveDeps },
    )
  }

  const nowIso = new Date().toISOString()
  const enabledDependencies: string[] = []
  db.transaction(() => {
    for (const targetId of toActivateOrder) {
      const m = manifests.get(targetId)!
      const existing = getInstalledModuleRow(targetId, db)
      const prevState = resolveEffectiveModuleState(m, existing)
      upsertInstalledModuleRow(
        {
          module_id: targetId,
          state: 'active',
          installed_at: existing?.installed_at ?? nowIso,
          updated_at: nowIso,
          config_json: existing?.config_json ?? '{}',
        },
        db,
      )
      if (targetId !== id && prevState !== 'active') {
        enabledDependencies.push(targetId)
      }
    }
  }).immediate()

  const updated = listModules({ ...opts, db, projectRoot }).find((m) => m.id === id)!
  return { module: updated, enabledDependencies }
}

export function disableModule(
  moduleId: string,
  opts?: ModuleManagerOptions & { disableDependentAgents?: boolean },
): { module: ModuleStatusView; disabledAgents: string[] } {
  const id = assertValidId(moduleId, 'module')
  const projectRoot = resolveProjectRoot(opts)
  const db = requireDb(opts)
  const all = listModules({ ...opts, db, projectRoot })
  const target = all.find((m) => m.id === id)
  if (!target) {
    throw new ModuleManagerError('MODULE_NOT_FOUND', 404, `Module not found: ${id}`)
  }

  if (target.builtIn) {
    throw new ModuleManagerError(
      'BUILTIN_MODULE_LOCKED',
      409,
      `Built-in module "${id}" cannot be disabled.`,
      { moduleId: id },
    )
  }

  if (target.activeDependentModules.length > 0) {
    throw new ModuleManagerError(
      'DEPENDENT_MODULES_ACTIVE',
      409,
      `Module "${id}" is required by active modules: ${target.activeDependentModules.join(', ')}`,
      {
        activeDependentModules: target.activeDependentModules,
        activeDependentAgents: target.activeDependentAgents,
      },
    )
  }

  const disabledAgents: string[] = []
  if (target.activeDependentAgents.length > 0) {
    if (opts?.disableDependentAgents !== true) {
      throw new ModuleManagerError(
        'DEPENDENT_MODULES_ACTIVE',
        409,
        `Module "${id}" is required by active agents: ${target.activeDependentAgents.map((a) => a.displayName).join(', ')}`,
        {
          activeDependentModules: [],
          activeDependentAgents: target.activeDependentAgents,
        },
      )
    }
    for (const depAgent of target.activeDependentAgents) {
      toggleAgentPackage(depAgent.id, false, { ...opts, db, projectRoot })
      disabledAgents.push(depAgent.id)
    }
  }

  const nowIso = new Date().toISOString()
  const existing = getInstalledModuleRow(id, db)
  upsertInstalledModuleRow(
    {
      module_id: id,
      state: 'installed_disabled',
      installed_at: existing?.installed_at ?? nowIso,
      updated_at: nowIso,
      config_json: existing?.config_json ?? '{}',
    },
    db,
  )

  const updated = listModules({ ...opts, db, projectRoot }).find((m) => m.id === id)!
  return { module: updated, disabledAgents }
}

function readSoulPreview(dirAbs: string): string {
  const soulPath = join(dirAbs, 'SOUL.md')
  if (!existsSync(soulPath)) return ''
  try {
    return readFileSync(soulPath, 'utf-8').trim().slice(0, SOUL_PREVIEW_MAX_CHARS)
  } catch {
    return ''
  }
}

export function listAgentPackages(opts?: ModuleManagerOptions): AgentPackageStatusView[] {
  const projectRoot = resolveProjectRoot(opts)
  const env = resolveEnvMap(opts)
  const db = resolveOptionalDb(opts)
  const modules = listModules({ ...opts, db: db ?? undefined, projectRoot, env })
  const moduleById = new Map(modules.map((m) => [m.id, m]))
  const catalog = loadCatalogAgentManifests(projectRoot)
  const presentSecrets = resolvePresentSecretIds(env, opts?.secretIds)
  const targetConfigPath = resolveTargetConfigPaths(projectRoot, env, opts?.configPaths)[0]
  const configuredAgents = loadConfiguredAgentsSafe(projectRoot, env, targetConfigPath)
  const configuredById = new Map(configuredAgents.map((a) => [a.id, a]))

  const out: AgentPackageStatusView[] = []
  for (const [id, { manifest, dirAbs }] of catalog) {
    const installedAgent = configuredById.get(id)
    const missingModules = manifest.requiredModules.filter((modId) => !moduleById.has(modId))
    const inactiveModules = manifest.requiredModules.filter(
      (modId) => moduleById.has(modId) && moduleById.get(modId)!.state !== 'active',
    )
    const missingOptionalEnv = manifest.optionalEnvVars.filter((k) => !presentSecrets.has(k))

    out.push({
      ...manifest,
      installed: Boolean(installedAgent),
      enabled: installedAgent ? installedAgent.enabled !== false : false,
      missingModules,
      inactiveModules,
      missingOptionalEnv,
      soulPreview: readSoulPreview(dirAbs),
    })
  }

  return out
}

function bestEffortSyncCliProfiles(
  projectRoot: string,
  env: Record<string, string | undefined>,
  configPath: string | undefined,
  homeOverride?: string,
): void {
  try {
    const agents = loadConfiguredAgentsSafe(projectRoot, env, configPath)
    syncAllCliProfilesAndDirectories({
      agents,
      projectRoot,
      env: env as NodeJS.ProcessEnv,
      homeOverride,
    })
  } catch {
    // Best-effort sync; do not fail core lifecycle on restricted sandboxes
  }
}

export function installAgentPackage(
  agentId: string,
  opts?: ModuleManagerOptions & { enableRequiredModules?: boolean },
): {
  agent: AgentPackageStatusView
  enabledModules: string[]
  copiedSoulFile: boolean
  installedSkills: string[]
  missingSecretsOrEnv: string[]
  checklist: string[]
} {
  const id = assertValidId(agentId, 'agent')
  const projectRoot = resolveProjectRoot(opts)
  const env = resolveEnvMap(opts)
  const db = requireDb(opts)
  const catalog = loadCatalogAgentManifests(projectRoot)
  const pkgEntry = catalog.get(id)
  if (!pkgEntry) {
    throw new ModuleManagerError('AGENT_PACKAGE_NOT_FOUND', 404, `Agent package not found in catalog: ${id}`)
  }

  const { manifest, dirAbs } = pkgEntry
  const manifests = loadModuleManifests(projectRoot)
  const missingModules = manifest.requiredModules.filter((modId) => !manifests.has(modId))
  if (missingModules.length > 0) {
    throw new ModuleManagerError(
      'MISSING_REQUIRED_MODULES',
      409,
      `Agent package "${id}" requires unavailable modules: ${missingModules.join(', ')}`,
      { missingModules },
    )
  }

  const enableRequiredModules = opts?.enableRequiredModules !== false
  const inactiveModules = manifest.requiredModules.filter(
    (modId) => !isModuleActive(modId, { ...opts, db, projectRoot }),
  )
  if (inactiveModules.length > 0 && !enableRequiredModules) {
    throw new ModuleManagerError(
      'MISSING_REQUIRED_MODULES',
      409,
      `Agent package "${id}" requires active modules: ${inactiveModules.join(', ')}`,
      { inactiveModules },
    )
  }

  // Pre-flight security scan of all package skills BEFORE mutating modules or config files
  const skillsToInstall: Array<{ slug: string; content: string }> = []
  const pkgSkillsDir = join(dirAbs, 'skills')
  if (existsSync(pkgSkillsDir)) {
    const skillDirs = readdirSync(pkgSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const sDir of skillDirs) {
      const slug = assertValidId(sDir.name, 'skill')
      const mdPath = resolveInsideBase(pkgSkillsDir, join(slug, 'SKILL.md'), 'package SKILL.md')
      if (!existsSync(mdPath)) continue
      const content = readFileSync(mdPath, 'utf-8')
      const scan = scanSkillMarkdownContent(content)
      if (scan.blocked) {
        throw new ModuleManagerError(
          'SKILL_SECURITY_SCAN_BLOCKED',
          400,
          `Security scanner blocked skill "${slug}" in package "${id}": ${scan.findings.map((f) => f.pattern).join(', ')}`,
          { skill: slug, findings: scan.findings },
        )
      }
      skillsToInstall.push({ slug, content })
    }
  }

  // Activate required modules (with transitive dependencies)
  const enabledModules: string[] = []
  for (const modId of manifest.requiredModules) {
    if (!isModuleActive(modId, { ...opts, db, projectRoot })) {
      const res = enableModule(modId, { ...opts, db, projectRoot, withDependencies: true })
      for (const dep of res.enabledDependencies) {
        if (!enabledModules.includes(dep)) enabledModules.push(dep)
      }
      if (!enabledModules.includes(modId)) enabledModules.push(modId)
    }
  }

  // Copy SOUL.md without overwriting existing custom SOUL.md
  let copiedSoulFile = false
  const srcSoul = join(dirAbs, 'SOUL.md')
  const destSoulDir = resolveInsideBase(projectRoot, join('agents', id), 'agent dir')
  const destSoul = join(destSoulDir, 'SOUL.md')
  if (existsSync(srcSoul) && !existsSync(destSoul)) {
    mkdirSync(destSoulDir, { recursive: true })
    atomicWriteFileSync(destSoul, readFileSync(srcSoul, 'utf-8'))
    copiedSoulFile = true
  }

  // Write scanned skills to shared skills root
  const skillsRoot = resolveSharedSkillsRoot(projectRoot, env as NodeJS.ProcessEnv)
  const installedSkills: string[] = []
  for (const sk of skillsToInstall) {
    const targetSkillDir = resolveInsideBase(skillsRoot, sk.slug, 'shared skill dir')
    mkdirSync(targetSkillDir, { recursive: true })
    atomicWriteFileSync(join(targetSkillDir, 'SKILL.md'), sk.content)
    installedSkills.push(sk.slug)
  }

  // Idempotently register agent in config/agents.json (enabled: false for newly installed packages)
  const targetPaths = resolveTargetConfigPaths(projectRoot, env, opts?.configPaths)
  const allSkillSlugs = Array.from(new Set([...manifest.skills, ...installedSkills]))
  for (const cfgPath of targetPaths) {
    if (!existsSync(cfgPath)) continue
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      version?: number
      global?: Record<string, unknown>
      roles?: Record<string, unknown>
      agents?: Array<Record<string, unknown>>
    }
    const list = Array.isArray(parsed.agents) ? parsed.agents : []
    const existing = list.find((a) => a.id === id)
    if (existing) {
      if (allSkillSlugs.length > 0) {
        const curSkills = Array.isArray(existing.skills) ? existing.skills.map(String) : []
        existing.skills = Array.from(new Set([...curSkills, ...allSkillSlugs]))
      }
    } else {
      const channelEnvVar = manifest.optionalEnvVars.find((v) => v.startsWith('DISCORD_CHANNEL_'))
      const workspace = manifest.workspace ?? `workspaces/${id}`
      const newEntry: Record<string, unknown> = {
        id,
        displayName: manifest.displayName,
        enabled: false,
        channelName: `#${id}`,
        discordChannelId: channelEnvVar ? `\${${channelEnvVar}}` : '',
        role: manifest.role,
        provider: manifest.recommendedProvider,
        model: manifest.recommendedModel,
        workspace,
        memoryNamespace: id,
        dailyBudgetUsd: manifest.dailyBudgetUsd,
        allowedUserIds: [],
        tools: manifest.tools,
        ...(manifest.protectedPaths && manifest.protectedPaths.length > 0
          ? { protectedPaths: manifest.protectedPaths }
          : {}),
        soulFile: `agents/${id}/SOUL.md`,
        ...(allSkillSlugs.length > 0 ? { skills: allSkillSlugs } : {}),
        systemPrompt: manifest.description,
      }
      list.push(newEntry)
      parsed.agents = list
    }
    atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
  }

  bestEffortSyncCliProfiles(projectRoot, env, targetPaths[0], opts?.homeOverride)

  const updatedModules = listModules({ ...opts, db, projectRoot, env })
  const missingModuleSecrets = manifest.requiredModules.flatMap(
    (modId) => updatedModules.find((m) => m.id === modId)?.missingSecrets ?? [],
  )
  const agentView = listAgentPackages({ ...opts, db, projectRoot, env }).find((p) => p.id === id)!
  const missingSecretsOrEnv = Array.from(new Set([...missingModuleSecrets, ...agentView.missingOptionalEnv]))

  const checklist: string[] = []
  if (missingSecretsOrEnv.length > 0) {
    checklist.push(`Állítsd be a hiányzó kulcsokat / csatorna változókat a Vaultban vagy .env-ben: ${missingSecretsOrEnv.join(', ')}`)
  }
  checklist.push(`Ellenőrizd a szerepkört, modellt és költségkeretet az #agents nézeten (${agentView.displayName}).`)
  if (!agentView.enabled) {
    checklist.push(`Kapcsold be az ügynököt (enabled: true) a #modules vagy #agents felületen az indításhoz.`)
  }

  return {
    agent: agentView,
    enabledModules,
    copiedSoulFile,
    installedSkills,
    missingSecretsOrEnv,
    checklist,
  }
}

export function toggleAgentPackage(
  agentId: string,
  enabled: boolean,
  opts?: ModuleManagerOptions,
): { agent: AgentPackageStatusView } {
  const id = assertValidId(agentId, 'agent')
  const projectRoot = resolveProjectRoot(opts)
  const env = resolveEnvMap(opts)
  const db = resolveOptionalDb(opts)
  const catalog = loadCatalogAgentManifests(projectRoot)
  const pkg = catalog.get(id)?.manifest

  if (enabled && pkg) {
    const manifests = loadModuleManifests(projectRoot)
    const missing = pkg.requiredModules.filter((modId) => !manifests.has(modId))
    const inactive = pkg.requiredModules.filter(
      (modId) => manifests.has(modId) && !isModuleActive(modId, { ...opts, db: db ?? undefined, projectRoot }),
    )
    if (missing.length > 0 || inactive.length > 0) {
      throw new ModuleManagerError(
        'MISSING_REQUIRED_MODULES',
        409,
        `Cannot enable agent "${id}": required modules are missing or inactive (${[...missing, ...inactive].join(', ')})`,
        { missingModules: missing, inactiveModules: inactive },
      )
    }
  }

  const targetPaths = resolveTargetConfigPaths(projectRoot, env, opts?.configPaths)
  let found = false
  for (const cfgPath of targetPaths) {
    if (!existsSync(cfgPath)) continue
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
    const entry = (parsed.agents ?? []).find((a) => a.id === id)
    if (!entry) continue
    found = true
    entry.enabled = enabled
    atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
  }

  if (!found) {
    throw new ModuleManagerError('AGENT_PACKAGE_NOT_FOUND', 404, `Installed agent not found in config/agents.json: ${id}`)
  }

  bestEffortSyncCliProfiles(projectRoot, env, targetPaths[0], opts?.homeOverride)

  const updated = listAgentPackages({ ...opts, db: db ?? undefined, projectRoot, env }).find((p) => p.id === id)
  if (!updated) {
    throw new ModuleManagerError('AGENT_PACKAGE_NOT_FOUND', 404, `Agent package not found in catalog: ${id}`)
  }
  return { agent: updated }
}

export function uninstallAgentPackage(
  agentId: string,
  opts?: ModuleManagerOptions,
): { removedAgentId: string; preservedSoulFile: boolean; preservedWorkspace: boolean } {
  const id = assertValidId(agentId, 'agent')
  if (PROTECTED_CORE_AGENTS.has(id)) {
    throw new ModuleManagerError(
      'PROTECTED_CORE_AGENT',
      409,
      `Core operational agent "${id}" cannot be uninstalled.`,
      { agentId: id },
    )
  }

  const projectRoot = resolveProjectRoot(opts)
  const env = resolveEnvMap(opts)
  const targetPaths = resolveTargetConfigPaths(projectRoot, env, opts?.configPaths)
  let found = false
  let workspaceRel = `workspaces/${id}`
  let soulRel = `agents/${id}/SOUL.md`

  for (const cfgPath of targetPaths) {
    if (!existsSync(cfgPath)) continue
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { agents?: Array<Record<string, unknown>> }
    const list = Array.isArray(parsed.agents) ? parsed.agents : []
    const entry = list.find((a) => a.id === id)
    if (!entry) continue
    found = true
    if (typeof entry.workspace === 'string' && entry.workspace.trim()) workspaceRel = entry.workspace.trim()
    if (typeof entry.soulFile === 'string' && entry.soulFile.trim()) soulRel = entry.soulFile.trim()
    parsed.agents = list.filter((a) => a.id !== id)
    atomicWriteFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n')
  }

  if (!found) {
    throw new ModuleManagerError('AGENT_PACKAGE_NOT_FOUND', 404, `Installed agent not found in config/agents.json: ${id}`)
  }

  bestEffortSyncCliProfiles(projectRoot, env, targetPaths[0], opts?.homeOverride)

  const preservedSoulFile = existsSync(resolveInsideBase(projectRoot, soulRel, 'soulFile'))
  const preservedWorkspace =
    workspaceRel === '.' || existsSync(resolveInsideBase(projectRoot, workspaceRel, 'workspace'))

  return {
    removedAgentId: id,
    preservedSoulFile,
    preservedWorkspace,
  }
}
