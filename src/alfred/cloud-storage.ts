import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import { getDb, getInstalledModuleRow, upsertInstalledModuleRow } from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { scanFile } from '../security/secret-gate.js'
import {
  holdStorePath,
  jobKey,
  readHoldStore,
  writeHoldStore,
  type Episode,
  type HoldStore,
} from '../web/heavy-job-hold.js'
import { deleteSecret, getSecret, listSecrets, setSecret } from '../web/vault.js'
import type { AlfredAgentDefinition } from './agents-config.js'
import { dropboxProvider, normalizeDropboxConfinedPath } from './cloud-providers/dropbox.js'
import { googleDriveProvider } from './cloud-providers/google-drive.js'
import { oneDriveProvider } from './cloud-providers/onedrive.js'
import {
  CLOUD_PROVIDERS,
  CloudReauthRequiredError,
  CloudStorageError,
  guessMimeTypeFromFilename,
  isCloudProviderId,
  type CloudAccessMode,
  type CloudAdapterCallContext,
  type CloudConnectionHealth,
  type CloudDownloadResult,
  type CloudItem,
  type CloudItemKindFilter,
  type CloudProviderId,
  type CloudQuotaInfo,
  type CloudShareResult,
  type CloudShareRole,
  type CloudStorageProvider,
  type CloudUploadConflictMode,
} from './cloud-providers/types.js'
import { parseModuleConfigJson } from './module-manager.js'
import {
  assertWriteAllowed,
  matchProtectedPath,
  ProtectedPathError,
  resolvePathInWorkspace,
} from './tool-executor.js'

export * from './cloud-providers/types.js'

export const CLOUD_STORAGE_MODULE_ID = 'cloud-storage'
export const DEFAULT_CLOUD_ACCOUNT = 'default'
export const SAFE_CLOUD_ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const DEFAULT_MAX_DOWNLOAD_MB = 250
export const DEFAULT_MAX_UPLOAD_MB = 500
const HEAVY_TRANSFER_HOLD_MIN_BYTES = 16 * 1024 * 1024 // 16 MiB
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const PATH_CACHE_TTL_MS = 60 * 1000 // 60 seconds
const PATH_CACHE_MAX_ENTRIES = 500

export interface CloudVaultOps {
  listSecrets: () => Array<{ id: string; label?: string }>
  setSecret: (id: string, label: string, value: string) => void
  getSecret: (id: string) => string | null
  deleteSecret: (id: string) => boolean
}

const DEFAULT_VAULT_OPS: CloudVaultOps = {
  listSecrets,
  setSecret,
  getSecret,
  deleteSecret,
}

export interface CloudStorageOptions {
  db?: Database.Database
  env?: Record<string, string | undefined>
  projectRoot?: string
  vaultOps?: CloudVaultOps
  fetchImpl?: typeof fetch
  retryDelaysMs?: readonly number[]
  skipDiskSpaceCheck?: boolean
  agentId?: string
}

export interface CloudAccountProfileMeta {
  label?: string
  accountEmail?: string | null
  accessMode: CloudAccessMode
  rootRef?: string | null
  readOnlyPrefixes?: string[]
  defaultShareEmail?: string | null
  allowPublicLinks?: boolean
  needsReauth?: boolean
  lastError?: string | null
  cachedQuota?: CloudQuotaInfo | null
  quotaFetchedAt?: string | null
  updatedAt: string
}

export interface CloudModuleConfigJson {
  cloud_default_provider?: CloudProviderId
  cloud_default_share_email?: string | null
  cloud_allow_public_links?: boolean
  cloud_gdrive_root_ref?: string | null
  cloud_onedrive_root_ref?: string | null
  cloud_dropbox_root_ref?: string | null
  providerDefaults?: Partial<Record<CloudProviderId, string>>
  accounts?: Partial<Record<CloudProviderId, Record<string, CloudAccountProfileMeta>>>
  [key: string]: unknown
}

export interface CloudActivityRecord {
  id: number
  ts_sec: number
  agent_id: string
  provider: string
  account: string
  action: string
  target_name: string
  bytes: number
  status: 'ok' | 'error'
  detail: string | null
}

const ADAPTERS: Record<CloudProviderId, CloudStorageProvider> = {
  gdrive: googleDriveProvider,
  onedrive: oneDriveProvider,
  dropbox: dropboxProvider,
}

export function getCloudAdapter(provider: CloudProviderId): CloudStorageProvider {
  const adapter = ADAPTERS[provider]
  if (!adapter) {
    throw new CloudStorageError('CLOUD_INVALID_PROVIDER', `Ismeretlen felhőtárhely szolgáltató: "${provider}"`, {
      statusHttp: 400,
    })
  }
  return adapter
}

export function assertValidCloudProvider(raw: string): CloudProviderId {
  const clean = String(raw || '').trim().toLowerCase()
  if (!isCloudProviderId(clean)) {
    throw new CloudStorageError(
      'CLOUD_INVALID_PROVIDER',
      `Érvénytelen felhőtárhely szolgáltató: "${raw}". Engedélyezett: gdrive, onedrive, dropbox.`,
      { statusHttp: 400 },
    )
  }
  return clean
}

export function normalizeCloudAccountKey(raw: string | undefined | null): string {
  const clean = String(raw ?? '').trim().toLowerCase()
  if (!clean) return DEFAULT_CLOUD_ACCOUNT
  if (!SAFE_CLOUD_ACCOUNT_RE.test(clean)) {
    throw new CloudStorageError(
      'CLOUD_INVALID_ACCOUNT',
      `Érvénytelen fiók-alias: "${raw}" (engedélyezett: kisbetű, szám, kötőjel, aláhúzás, max. 32 karakter).`,
      { statusHttp: 400 },
    )
  }
  return clean
}

export function deriveAccountAliasFromEmail(email: string | null | undefined, existingKeys: ReadonlySet<string>): string {
  const local = String(email ?? '')
    .trim()
    .toLowerCase()
    .split('@')[0]
    ?.replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const base = local && SAFE_CLOUD_ACCOUNT_RE.test(local) ? local : 'account'
  if (!existingKeys.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const cand = `${base.slice(0, 28)}-${i}`
    if (!existingKeys.has(cand)) return cand
  }
  return `acc-${randomBytes(3).toString('hex')}`
}

/**
 * Vault key naming convention:
 * - `default` account: `cloud_<provider>_<field>` (100% backwards-compatible with 01b setupWizard)
 * - named accounts: `cloud_<provider>__<account>_<field>`
 */
export function cloudVaultKey(
  provider: CloudProviderId,
  field: 'client_id' | 'client_secret' | 'refresh_token' | 'account_email' | 'root_ref',
  account: string = DEFAULT_CLOUD_ACCOUNT,
): string {
  if (!account || account === DEFAULT_CLOUD_ACCOUNT) {
    return `cloud_${provider}_${field}`
  }
  return `cloud_${provider}__${account}_${field}`
}

// --- In-memory caches (strictly keyed by provider::account, never written to disk) ---
interface CachedAccessToken {
  accessToken: string
  expiresAtMs: number
}

interface PendingOAuthSession {
  provider: CloudProviderId
  account: string | null // null when createNew && auto-alias from email
  label?: string
  accessMode: CloudAccessMode
  redirectUri: string
  codeVerifier: string
  expiresAtMs: number
}

interface CachedPathEntry {
  itemId: string
  expiresAtMs: number
}

const accessTokenCache = new Map<string, CachedAccessToken>()
const pendingOAuthSessions = new Map<string, PendingOAuthSession>()
const pathIdCache = new Map<string, CachedPathEntry>()

export function clearCloudStorageInMemoryCaches(): void {
  accessTokenCache.clear()
  pendingOAuthSessions.clear()
  pathIdCache.clear()
}

function tokenCacheKey(provider: CloudProviderId, account: string): string {
  return `${provider}::${account}`
}

function resolveEnv(opts?: CloudStorageOptions): Record<string, string | undefined> {
  if (opts?.env) return opts.env
  try {
    return { ...readEnvFile(), ...process.env }
  } catch {
    return { ...process.env }
  }
}

function resolveVaultOps(opts?: CloudStorageOptions): CloudVaultOps {
  return opts?.vaultOps ?? DEFAULT_VAULT_OPS
}

function resolveOptionalDb(opts?: CloudStorageOptions): Database.Database | null {
  if (opts?.db) return opts.db
  try {
    const d = getDb()
    return d && d.open ? d : null
  } catch {
    return null
  }
}

export function ensureCloudActivityTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_sec INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      action TEXT NOT NULL,
      target_name TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
      detail TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cloud_activity_ts ON cloud_activity_log(ts_sec DESC)`)
}

export function recordCloudActivity(
  db: Database.Database | null,
  entry: {
    agentId: string
    provider: CloudProviderId
    account: string
    action: string
    targetName: string
    bytes?: number
    status: 'ok' | 'error'
    detail?: string | null
  },
): void {
  if (!db) return
  try {
    ensureCloudActivityTable(db)
    const safeDetail = entry.detail ? String(entry.detail).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 240) : null
    db.prepare(`
      INSERT INTO cloud_activity_log (ts_sec, agent_id, provider, account, action, target_name, bytes, status, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Math.floor(Date.now() / 1000),
      entry.agentId || 'system',
      entry.provider,
      entry.account || DEFAULT_CLOUD_ACCOUNT,
      entry.action,
      String(entry.targetName || '').slice(0, 240),
      Math.max(0, Math.floor(entry.bytes ?? 0)),
      entry.status,
      safeDetail,
    )
  } catch (err) {
    logger.debug({ err }, 'Failed to record cloud_activity_log row (non-fatal)')
  }
}

export function listRecentCloudActivity(db: Database.Database | null, limit = 15): CloudActivityRecord[] {
  if (!db) return []
  try {
    ensureCloudActivityTable(db)
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    return db
      .prepare(
        `SELECT id, ts_sec, agent_id, provider, account, action, target_name, bytes, status, detail
         FROM cloud_activity_log
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(safeLimit) as CloudActivityRecord[]
  } catch {
    return []
  }
}

export function pruneCloudActivityLog(db: Database.Database | null, retentionDays = 30, maxRows = 1000): number {
  if (!db) return 0
  try {
    const hasTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_activity_log' LIMIT 1`)
      .get()
    if (!hasTable) return 0
    const cutoffSec = Math.floor(Date.now() / 1000) - Math.max(1, retentionDays) * 86_400
    const r1 = db.prepare(`DELETE FROM cloud_activity_log WHERE ts_sec < ?`).run(cutoffSec).changes
    const r2 = db
      .prepare(
        `DELETE FROM cloud_activity_log WHERE id NOT IN (SELECT id FROM cloud_activity_log ORDER BY id DESC LIMIT ?)`,
      )
      .run(Math.max(50, maxRows)).changes
    return r1 + r2
  } catch {
    return 0
  }
}

function readCloudConfigJson(opts?: CloudStorageOptions): CloudModuleConfigJson {
  const db = resolveOptionalDb(opts)
  if (!db) return {}
  try {
    const row = getInstalledModuleRow(CLOUD_STORAGE_MODULE_ID, db)
    return parseModuleConfigJson(row?.config_json) as CloudModuleConfigJson
  } catch {
    return {}
  }
}

function writeCloudConfigJson(
  mutator: (cfg: CloudModuleConfigJson) => void,
  opts?: CloudStorageOptions,
): CloudModuleConfigJson {
  const db = resolveOptionalDb(opts)
  const current = readCloudConfigJson(opts)
  mutator(current)
  if (!db) return current

  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_modules (
      module_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
      installed_at TEXT,
      updated_at TEXT,
      config_json TEXT
    )
  `)
  const existingRow = getInstalledModuleRow(CLOUD_STORAGE_MODULE_ID, db)
  const nowIso = new Date().toISOString()
  upsertInstalledModuleRow(
    {
      module_id: CLOUD_STORAGE_MODULE_ID,
      state: existingRow?.state ?? 'available',
      installed_at: existingRow?.installed_at ?? nowIso,
      updated_at: nowIso,
      config_json: JSON.stringify(current),
    },
    db,
  )
  return current
}

function getPresentVaultSecretIds(vaultOps: CloudVaultOps): Set<string> {
  const ids = new Set<string>()
  try {
    for (const item of vaultOps.listSecrets()) {
      if (item?.id) ids.add(item.id)
    }
  } catch {
    // Vault unavailable or empty
  }
  return ids
}

function discoverAccountKeysForProvider(
  provider: CloudProviderId,
  cfg: CloudModuleConfigJson,
  vaultIds: ReadonlySet<string>,
): string[] {
  const keys = new Set<string>([DEFAULT_CLOUD_ACCOUNT])
  const cfgAccounts = cfg.accounts?.[provider]
  if (cfgAccounts && typeof cfgAccounts === 'object') {
    for (const k of Object.keys(cfgAccounts)) {
      if (SAFE_CLOUD_ACCOUNT_RE.test(k)) keys.add(k)
    }
  }
  const namedPrefix = `cloud_${provider}__`
  for (const vid of vaultIds) {
    if (!vid.startsWith(namedPrefix)) continue
    const rest = vid.slice(namedPrefix.length)
    const m = /^([a-z0-9][a-z0-9_-]{0,31})_(?:client_id|client_secret|refresh_token|account_email|root_ref)$/.exec(rest)
    if (m?.[1]) keys.add(m[1])
  }
  const defaultAcc = cfg.providerDefaults?.[provider]
  if (defaultAcc && SAFE_CLOUD_ACCOUNT_RE.test(defaultAcc)) {
    keys.add(defaultAcc)
  }
  return [...keys].sort((a, b) => (a === DEFAULT_CLOUD_ACCOUNT ? -1 : b === DEFAULT_CLOUD_ACCOUNT ? 1 : a.localeCompare(b)))
}

function resolveDefaultAccountForProvider(
  provider: CloudProviderId,
  cfg: CloudModuleConfigJson,
  vaultIds: ReadonlySet<string>,
): string {
  const explicit = cfg.providerDefaults?.[provider]
  if (explicit && SAFE_CLOUD_ACCOUNT_RE.test(explicit)) {
    return explicit
  }
  const keys = discoverAccountKeysForProvider(provider, cfg, vaultIds)
  if (vaultIds.has(cloudVaultKey(provider, 'refresh_token', DEFAULT_CLOUD_ACCOUNT))) {
    return DEFAULT_CLOUD_ACCOUNT
  }
  for (const k of keys) {
    if (vaultIds.has(cloudVaultKey(provider, 'refresh_token', k))) {
      return k
    }
  }
  return DEFAULT_CLOUD_ACCOUNT
}

function getAccountMeta(
  cfg: CloudModuleConfigJson,
  provider: CloudProviderId,
  account: string,
): CloudAccountProfileMeta {
  const existing = cfg.accounts?.[provider]?.[account]
  const legacyRootKey = `cloud_${provider}_root_ref` as keyof CloudModuleConfigJson
  const legacyRoot = account === DEFAULT_CLOUD_ACCOUNT ? (cfg[legacyRootKey] as string | null | undefined) : undefined
  return {
    label: existing?.label ?? (account === DEFAULT_CLOUD_ACCOUNT ? 'Alapértelmezett' : account),
    accountEmail: existing?.accountEmail ?? null,
    accessMode: existing?.accessMode === 'read_only' ? 'read_only' : 'read_write',
    rootRef: existing?.rootRef ?? legacyRoot ?? null,
    readOnlyPrefixes: Array.isArray(existing?.readOnlyPrefixes) ? existing.readOnlyPrefixes : [],
    defaultShareEmail: existing?.defaultShareEmail ?? null,
    allowPublicLinks: existing?.allowPublicLinks,
    needsReauth: existing?.needsReauth === true,
    lastError: existing?.lastError ?? null,
    cachedQuota: existing?.cachedQuota ?? null,
    quotaFetchedAt: existing?.quotaFetchedAt ?? null,
    updatedAt: existing?.updatedAt ?? '',
  }
}

export function resolveMaxDownloadBytes(env: Record<string, string | undefined>): number {
  const raw = env['ALFRED_CLOUD_MAX_DOWNLOAD_MB']?.trim()
  const parsed = raw ? Number(raw) : NaN
  const mb = Number.isFinite(parsed) && parsed >= 1 && parsed <= 4096 ? parsed : DEFAULT_MAX_DOWNLOAD_MB
  return Math.floor(mb * 1024 * 1024)
}

export function resolveMaxUploadBytes(env: Record<string, string | undefined>): number {
  const raw = env['ALFRED_CLOUD_MAX_UPLOAD_MB']?.trim()
  const parsed = raw ? Number(raw) : NaN
  const mb = Number.isFinite(parsed) && parsed >= 1 && parsed <= 8192 ? parsed : DEFAULT_MAX_UPLOAD_MB
  return Math.floor(mb * 1024 * 1024)
}

function resolveDefaultProvider(cfg: CloudModuleConfigJson, vaultOps: CloudVaultOps): CloudProviderId {
  if (cfg.cloud_default_provider && isCloudProviderId(cfg.cloud_default_provider)) {
    return cfg.cloud_default_provider
  }
  const vaultIds = getPresentVaultSecretIds(vaultOps)
  if (vaultIds.has('cloud_default_provider')) {
    try {
      const v = vaultOps.getSecret('cloud_default_provider')?.trim().toLowerCase()
      if (v && isCloudProviderId(v)) return v
    } catch {
      // ignore
    }
  }
  for (const p of CLOUD_PROVIDERS) {
    const keys = discoverAccountKeysForProvider(p, cfg, vaultIds)
    if (keys.some((k) => vaultIds.has(cloudVaultKey(p, 'refresh_token', k)))) {
      return p
    }
  }
  return 'gdrive'
}

export interface ResolvedCloudTarget {
  provider: CloudProviderId
  account: string
  explicitAccountRequested: boolean
  meta: CloudAccountProfileMeta
  clientId: string
  clientSecret: string
  refreshToken: string
}

/**
 * Resolves `(provider?, account?)` with strict fail-closed semantics:
 * - Explicit `account` matches either `alias` or connected `accountEmail` (case-insensitive),
 *   throwing `CLOUD_ACCOUNT_NOT_FOUND` if unmatched (never silently falls back to another account!).
 * - Omitted `account` uses the provider's configured `defaultAccount`; if that default account is
 *   in `needs_reauth`, throws `CloudReauthRequiredError` (never silently switches to another account!).
 */
export function resolveCloudTarget(
  req: { provider?: string; account?: string } | undefined,
  opts?: CloudStorageOptions,
): ResolvedCloudTarget {
  const vaultOps = resolveVaultOps(opts)
  const cfg = readCloudConfigJson(opts)
  const vaultIds = getPresentVaultSecretIds(vaultOps)
  const provider = req?.provider ? assertValidCloudProvider(req.provider) : resolveDefaultProvider(cfg, vaultOps)
  const knownKeys = discoverAccountKeysForProvider(provider, cfg, vaultIds)

  let account: string
  const rawAcc = typeof req?.account === 'string' ? req.account.trim() : ''
  const explicitAccountRequested = rawAcc.length > 0

  if (explicitAccountRequested) {
    const lowerReq = rawAcc.toLowerCase()
    const directAlias = knownKeys.find((k) => k.toLowerCase() === lowerReq)
    if (directAlias) {
      account = directAlias
    } else {
      // Match by connected accountEmail
      const byEmail = knownKeys.find((k) => {
        const metaEmail = getAccountMeta(cfg, provider, k).accountEmail?.trim().toLowerCase()
        if (metaEmail && metaEmail === lowerReq) return true
        if (vaultIds.has(cloudVaultKey(provider, 'account_email', k))) {
          try {
            const vEmail = vaultOps.getSecret(cloudVaultKey(provider, 'account_email', k))?.trim().toLowerCase()
            if (vEmail === lowerReq) return true
          } catch {
            // ignore
          }
        }
        return false
      })
      if (!byEmail) {
        throw new CloudStorageError(
          'CLOUD_ACCOUNT_NOT_FOUND',
          `A(z) "${rawAcc}" felhőfiók nem található a(z) ${provider} szolgáltató alatt. Elérhető fiókok: [${knownKeys.join(', ')}].`,
          { statusHttp: 404, provider, details: { requestedAccount: rawAcc, availableAccounts: knownKeys } },
        )
      }
      account = byEmail
    }
  } else {
    account = resolveDefaultAccountForProvider(provider, cfg, vaultIds)
  }

  const meta = getAccountMeta(cfg, provider, account)

  // Fail-closed: if the targeted (including default) account is marked needs_reauth, never silently switch!
  if (meta.needsReauth) {
    const healthyAlternates = knownKeys.filter((k) => {
      if (k === account) return false
      const m = getAccountMeta(cfg, provider, k)
      return !m.needsReauth && vaultIds.has(cloudVaultKey(provider, 'refresh_token', k))
    })
    throw new CloudReauthRequiredError(provider, account, meta.lastError ?? undefined, healthyAlternates)
  }

  // Per-account client override falls back to shared provider client_id / client_secret
  const clientId =
    (account !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_id', account)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_id', DEFAULT_CLOUD_ACCOUNT)) ??
    ''
  const clientSecret =
    (account !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', account)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', DEFAULT_CLOUD_ACCOUNT)) ??
    ''
  // Refresh token is NEVER shared across accounts!
  const refreshToken = vaultOps.getSecret(cloudVaultKey(provider, 'refresh_token', account)) ?? ''

  if (!clientId.trim() || !clientSecret.trim() || !refreshToken.trim()) {
    throw new CloudStorageError(
      'CLOUD_NOT_CONFIGURED',
      `A(z) ${provider}::${account} felhőfiók nincs még összekötve (hiányzó OAuth2 hitelesítés). Használd a Dashboard #vps kártyáját!`,
      { statusHttp: 400, provider, account },
    )
  }

  return {
    provider,
    account,
    explicitAccountRequested,
    meta,
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    refreshToken: refreshToken.trim(),
  }
}

function markAccountReauthState(
  provider: CloudProviderId,
  account: string,
  needsReauth: boolean,
  lastError: string | null,
  opts?: CloudStorageOptions,
): void {
  if (needsReauth) {
    accessTokenCache.delete(tokenCacheKey(provider, account))
  }
  writeCloudConfigJson((cfg) => {
    cfg.accounts = cfg.accounts ?? {}
    cfg.accounts[provider] = cfg.accounts[provider] ?? {}
    const prev = getAccountMeta(cfg, provider, account)
    cfg.accounts[provider]![account] = {
      ...prev,
      needsReauth,
      lastError,
      updatedAt: new Date().toISOString(),
    }
  }, opts)
}

async function getValidAccessToken(
  target: ResolvedCloudTarget,
  opts?: CloudStorageOptions,
): Promise<{ accessToken: string; expiresAtMs: number }> {
  const key = tokenCacheKey(target.provider, target.account)
  const cached = accessTokenCache.get(key)
  if (cached && cached.expiresAtMs - 60_000 > Date.now()) {
    return cached
  }

  const adapter = getCloudAdapter(target.provider)
  const fetchImpl = opts?.fetchImpl ?? fetch
  const vaultOps = resolveVaultOps(opts)
  try {
    const refreshed = await adapter.refreshAccessToken({
      clientId: target.clientId,
      clientSecret: target.clientSecret,
      refreshToken: target.refreshToken,
      account: target.account,
      fetchImpl,
    })
    if (refreshed.rotatedRefreshToken) {
      vaultOps.setSecret(
        cloudVaultKey(target.provider, 'refresh_token', target.account),
        `Cloud ${target.provider} (${target.account}) Refresh Token`,
        refreshed.rotatedRefreshToken,
      )
    }
    const entry: CachedAccessToken = {
      accessToken: refreshed.accessToken,
      expiresAtMs: Date.now() + Math.max(60, refreshed.expiresInSec) * 1000,
    }
    accessTokenCache.set(key, entry)
    return entry
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
      // Attach healthy alternates to error
      const cfg = readCloudConfigJson(opts)
      const vaultIds = getPresentVaultSecretIds(vaultOps)
      const alternates = discoverAccountKeysForProvider(target.provider, cfg, vaultIds).filter(
        (k) =>
          k !== target.account &&
          !getAccountMeta(cfg, target.provider, k).needsReauth &&
          vaultIds.has(cloudVaultKey(target.provider, 'refresh_token', k)),
      )
      throw new CloudReauthRequiredError(target.provider, target.account, 'invalid_grant', alternates)
    }
    throw err
  }
}

// --- Security guards: Upload path protection, write protection, read_only & share policy ---

const SENSITIVE_UPLOAD_BASENAME_RE =
  /^(?:\.env(?:\.(?!example$).+|~)?|\.dashboard-token|\.vault-key(?:\.migrated)?|vault\.json|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|id_ecdsa(?:\..*)?|id_dsa(?:\..*)?|vertex-eu-sa\.json|.*(?:service[-_]?account|credentials).*\.json|.*\.(?:pem|key|p12|pfx|ppk|sqlite3?|db|db-wal|db-shm|db-journal))$/i

const SENSITIVE_UPLOAD_DIR_RE =
  /(?:^|\/)(?:store|\.cli-profiles|\.claude|\.gemini|\.codex|\.ssh|\.config\/gcloud)(?:\/|$)/i

/**
 * Strictly blocks uploading secrets, SQLite DBs, Vault files, dashboard tokens, private SSH/TLS keys,
 * CLI OAuth profile directories, agent `protectedPaths`, and secret-gate flagged text files.
 */
export function assertSafeCloudUploadPath(
  agent: Pick<AlfredAgentDefinition, 'id' | 'workspace' | 'workspaceAbsPath' | 'protectedPaths'>,
  targetAbsPath: string,
  requestedPath: string,
): void {
  const wsReal = existsSync(agent.workspaceAbsPath) ? realpathSync(agent.workspaceAbsPath) : resolve(agent.workspaceAbsPath)
  const targetReal = existsSync(targetAbsPath) ? realpathSync(targetAbsPath) : resolve(targetAbsPath)
  const relPosix = relative(wsReal, targetReal).replace(/\\/g, '/')
  const absPosix = targetReal.replace(/\\/g, '/')
  const base = basename(targetReal)

  if (SENSITIVE_UPLOAD_BASENAME_RE.test(base)) {
    throw new ProtectedPathError(agent.id, requestedPath, base, 'fs_read', 'sensitive secret/database file cannot be uploaded to cloud')
  }
  if (SENSITIVE_UPLOAD_DIR_RE.test(relPosix) || SENSITIVE_UPLOAD_DIR_RE.test(absPosix)) {
    throw new ProtectedPathError(agent.id, requestedPath, 'protected_dir', 'fs_read', 'protected system/auth directory cannot be uploaded to cloud')
  }
  const matchedProtected = matchProtectedPath(agent.workspaceAbsPath, targetReal, agent.protectedPaths)
  if (matchedProtected) {
    throw new ProtectedPathError(agent.id, requestedPath, matchedProtected, 'fs_read', 'agent protectedPath cannot be uploaded to cloud')
  }

  // Run EVIDGUARD818 secret-gate scan on small text-like files (< 2 MiB) before uploading
  if (existsSync(targetReal)) {
    const st = statSync(targetReal)
    if (st.isFile() && st.size > 0 && st.size <= 2 * 1024 * 1024) {
      const sample = readFileSync(targetReal)
      const looksBinary = sample.subarray(0, Math.min(sample.length, 4096)).includes(0)
      if (!looksBinary) {
        const findings = scanFile({ path: relPosix || base, content: sample.toString('utf-8') })
        if (findings.length > 0) {
          throw new ProtectedPathError(
            agent.id,
            requestedPath,
            findings[0]!.reason,
            'fs_read',
            `secret-gate blocked upload (${findings[0]!.detector})`,
          )
        }
      }
    }
  }
}

export function assertAccountWritable(
  target: ResolvedCloudTarget,
  remoteRelPath?: string,
): void {
  if (target.meta.accessMode === 'read_only') {
    throw new CloudStorageError(
      'CLOUD_ACCOUNT_READONLY',
      `A(z) ${target.provider}::${target.account} fiók csak olvasható (read_only) módban van összekötve — írás, mappa létrehozás és megosztás tiltott.`,
      { statusHttp: 403, provider: target.provider, account: target.account },
    )
  }
  if (remoteRelPath && target.meta.readOnlyPrefixes && target.meta.readOnlyPrefixes.length > 0) {
    const norm = remoteRelPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    for (const rawPref of target.meta.readOnlyPrefixes) {
      const pref = rawPref.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
      if (!pref) continue
      if (norm === pref || norm.startsWith(`${pref}/`)) {
        throw new CloudStorageError(
          'CLOUD_READONLY_TARGET',
          `A(z) "${remoteRelPath}" célútvonal védett, csak olvasható előtag alatt áll ("${rawPref}").`,
          { statusHttp: 403, provider: target.provider, account: target.account },
        )
      }
    }
  }
}

export function resolveCloudSharePolicy(params: {
  target: ResolvedCloudTarget
  cfg: CloudModuleConfigJson
  env: Record<string, string | undefined>
  explicitEmail?: string
  publicLink?: boolean
  notify?: boolean
}): { email?: string; publicLink: boolean; notify: boolean } {
  const { target, cfg, env } = params
  const wantPublic = params.publicLink === true
  const notify = params.notify === true

  if (wantPublic) {
    const allowed =
      target.meta.allowPublicLinks !== undefined
        ? target.meta.allowPublicLinks === true
        : cfg.cloud_allow_public_links === true
    if (!allowed) {
      throw new CloudStorageError(
        'CLOUD_PUBLIC_LINK_FORBIDDEN',
        `A nyilvános (anyone / anonymous) linkek létrehozása le van tiltva a(z) ${target.provider}::${target.account} fiókon. ` +
          `Engedélyezd expliciten az allowPublicLinks kapcsolót a #vpsCloudStorageCard felületen, vagy oszd meg e-mail címmel!`,
        { statusHttp: 403, provider: target.provider, account: target.account },
      )
    }
    return { publicLink: true, notify: false }
  }

  const email =
    (params.explicitEmail ?? '').trim() ||
    (target.meta.defaultShareEmail ?? '').trim() ||
    (cfg.cloud_default_share_email ?? '').trim() ||
    (env['ALFRED_CLOUD_SHARE_EMAIL'] ?? '').trim()

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CloudStorageError(
      'CLOUD_SHARE_RECIPIENT_REQUIRED',
      `Nincs megadva megosztási e-mail cím (sem explicit, sem fiókszintű defaultShareEmail, sem globális ALFRED_CLOUD_SHARE_EMAIL). ` +
        `A rendszer biztonsági okból nem hoz létre automatikusan nyilvános linket.`,
      { statusHttp: 400, provider: target.provider, account: target.account },
    )
  }

  return { email, publicLink: false, notify }
}

// --- Transparent relative path <-> ID resolution for ID-based providers (gdrive / onedrive) ---

function looksLikeRelativePath(ref: string): boolean {
  const clean = ref.trim()
  if (!clean) return false
  if (clean === 'root') return false
  if (clean.startsWith('id:')) return false
  if (clean.includes('/') || clean.includes('\\')) return true
  return false
}

function splitAndValidatePathSegments(rawPath: string): string[] {
  const norm = rawPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!norm) return []
  const segments = norm.split('/').filter(Boolean)
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new CloudStorageError('CLOUD_PATH_TRAVERSAL', `Érvénytelen felhő útvonal ("${rawPath}"): ".." tiltott.`, {
        statusHttp: 400,
      })
    }
  }
  return segments
}

function getCachedPathId(key: string): string | null {
  const hit = pathIdCache.get(key)
  if (!hit) return null
  if (hit.expiresAtMs <= Date.now()) {
    pathIdCache.delete(key)
    return null
  }
  return hit.itemId
}

function setCachedPathId(key: string, itemId: string): void {
  if (pathIdCache.size >= PATH_CACHE_MAX_ENTRIES) {
    const oldest = pathIdCache.keys().next().value
    if (oldest) pathIdCache.delete(oldest)
  }
  pathIdCache.set(key, { itemId, expiresAtMs: Date.now() + PATH_CACHE_TTL_MS })
}

async function resolveFolderPathOrId(
  adapter: CloudStorageProvider,
  ctx: CloudAdapterCallContext,
  refOrPath: string | undefined,
  opts: { createMissing?: boolean } = {},
): Promise<string> {
  const raw = (refOrPath ?? '').trim()
  if (adapter.id === 'dropbox') {
    if (!raw) return normalizeDropboxConfinedPath(ctx.rootRef, '')
    const segments = splitAndValidatePathSegments(raw)
    if (opts.createMissing && segments.length > 0) {
      let cur = normalizeDropboxConfinedPath(ctx.rootRef, '')
      for (const seg of segments) {
        const created = await adapter.mkdir(ctx, seg, cur)
        cur = created.pathDisplay || normalizeDropboxConfinedPath(ctx.rootRef, cur ? `${cur}/${seg}` : `/${seg}`)
      }
      return cur
    }
    return normalizeDropboxConfinedPath(ctx.rootRef, raw)
  }

  const rootId = (ctx.rootRef ?? '').trim() || 'root'
  if (!raw || raw === 'root' || raw === '/' || raw === '.') {
    return rootId
  }
  if (!looksLikeRelativePath(raw)) {
    return raw
  }

  const segments = splitAndValidatePathSegments(raw)
  let currentId = rootId
  let walked = ''
  for (const seg of segments) {
    walked = walked ? `${walked}/${seg}` : seg
    const cacheKey = `${adapter.id}::${ctx.account}::${rootId}::dir::${walked.toLowerCase()}`
    const cached = getCachedPathId(cacheKey)
    if (cached) {
      currentId = cached
      continue
    }
    const children = await adapter.list(ctx, { folderRef: currentId, kind: 'folder', limit: 200 })
    const hit = children.find((c) => c.name.toLowerCase() === seg.toLowerCase())
    if (hit) {
      currentId = hit.id
      setCachedPathId(cacheKey, hit.id)
    } else if (opts.createMissing) {
      const created = await adapter.mkdir(ctx, seg, currentId)
      currentId = created.id
      setCachedPathId(cacheKey, created.id)
    } else {
      throw new CloudStorageError('CLOUD_NOT_FOUND', `A(z) "${walked}" felhőmappa nem található (${adapter.id}::${ctx.account}).`, {
        statusHttp: 404,
        provider: adapter.id,
        account: ctx.account,
      })
    }
  }
  return currentId
}

async function resolveItemRefOrPath(
  adapter: CloudStorageProvider,
  ctx: CloudAdapterCallContext,
  refOrPath: string,
): Promise<string> {
  const raw = refOrPath.trim()
  if (!raw) {
    throw new CloudStorageError('CLOUD_NOT_FOUND', 'A fájl hivatkozása (file_ref_or_path) nem lehet üres.', {
      statusHttp: 400,
      provider: adapter.id,
      account: ctx.account,
    })
  }
  if (adapter.id === 'dropbox') {
    return normalizeDropboxConfinedPath(ctx.rootRef, raw)
  }
  if (!looksLikeRelativePath(raw)) {
    return raw
  }
  const segments = splitAndValidatePathSegments(raw)
  if (segments.length === 0) {
    return (ctx.rootRef ?? '').trim() || 'root'
  }
  const fileName = segments[segments.length - 1]!
  const parentPath = segments.slice(0, -1).join('/')
  const parentId = await resolveFolderPathOrId(adapter, ctx, parentPath || undefined, { createMissing: false })
  const items = await adapter.list(ctx, { folderRef: parentId, limit: 200 })
  const hit = items.find((i) => i.name.toLowerCase() === fileName.toLowerCase())
  if (!hit) {
    throw new CloudStorageError('CLOUD_NOT_FOUND', `A(z) "${raw}" elem nem található (${adapter.id}::${ctx.account}).`, {
      statusHttp: 404,
      provider: adapter.id,
      account: ctx.account,
    })
  }
  return hit.id
}

/**
 * Registers a `heavy-job-hold` entry in `store/context-guard-heavy-holds.json` during large (>= 16 MiB)
 * cloud transfers so automated maintenance restarts do not interrupt active I/O.
 */
export async function withCloudHeavyJobHold<T>(
  projectRoot: string,
  agentId: string,
  transferLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  const storeFile = holdStorePath(projectRoot)
  const nowMs = Date.now()
  const pid = process.pid
  const entry = {
    pid,
    start: String(Math.floor(nowMs / 1000)),
    label: `cloud:${transferLabel}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 64),
    state: 'running' as const,
    firstSeenMs: nowMs,
    alerted: false,
  }
  const k = jobKey(entry)
  const agentKey = agentId || 'alfred-cloud'

  const register = () => {
    try {
      mkdirSync(dirname(storeFile), { recursive: true })
      let store: HoldStore = {}
      try {
        store = readHoldStore(storeFile)
      } catch {
        store = {}
      }
      const existing: Episode = store[agentKey] ?? { startMs: nowMs, panes: [pid], jobs: {} }
      existing.jobs[k] = entry
      store[agentKey] = existing
      writeHoldStore(storeFile, store)
    } catch {
      // non-fatal
    }
  }

  const release = () => {
    try {
      const store = readHoldStore(storeFile)
      const ep = store[agentKey]
      if (!ep) return
      delete ep.jobs[k]
      if (Object.keys(ep.jobs).length === 0) {
        delete store[agentKey]
      }
      writeHoldStore(storeFile, store)
    } catch {
      // non-fatal
    }
  }

  register()
  try {
    return await fn()
  } finally {
    release()
  }
}

async function buildAdapterContext(
  target: ResolvedCloudTarget,
  opts?: CloudStorageOptions,
): Promise<CloudAdapterCallContext> {
  const { accessToken } = await getValidAccessToken(target, opts)
  return {
    accessToken,
    account: target.account,
    rootRef: target.meta.rootRef ?? null,
    fetchImpl: opts?.fetchImpl ?? fetch,
    retryDelaysMs: opts?.retryDelaysMs,
    skipDiskSpaceCheck: opts?.skipDiskSpaceCheck,
  }
}

// --- High-level Multi-Cloud Operations (called by tool-executor.ts & Admin API) ---

export async function cloudList(
  params: {
    provider?: string
    account?: string
    folderRef?: string
    query?: string
    kind?: CloudItemKindFilter
    limit?: number
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; items: CloudItem[] }> {
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  try {
    const ctx = await buildAdapterContext(target, opts)
    const resolvedFolder = params.folderRef
      ? await resolveFolderPathOrId(adapter, ctx, params.folderRef, { createMissing: false })
      : undefined
    const items = await adapter.list(ctx, {
      folderRef: resolvedFolder,
      query: params.query,
      kind: params.kind,
      limit: params.limit,
    })
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'system',
      provider: target.provider,
      account: target.account,
      action: 'list',
      targetName: params.query ? `query:${params.query}` : params.folderRef || target.meta.rootRef || 'root',
      status: 'ok',
      detail: `${items.length} elem`,
    })
    return { provider: target.provider, account: target.account, items }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'system',
      provider: target.provider,
      account: target.account,
      action: 'list',
      targetName: params.folderRef || 'root',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function cloudMkdir(
  params: {
    pathOrName: string
    parentRef?: string
    provider?: string
    account?: string
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; folder: CloudItem }> {
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  const effectivePath = params.parentRef
    ? `${params.parentRef.replace(/\/+$/, '')}/${params.pathOrName.replace(/^\/+/, '')}`
    : params.pathOrName
  assertAccountWritable(target, effectivePath)
  assertAccountWritable(target, params.pathOrName)
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  try {
    const ctx = await buildAdapterContext(target, opts)
    const segments = splitAndValidatePathSegments(params.pathOrName)
    if (segments.length === 0) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'A létrehozandó mappa neve nem lehet üres.', {
        statusHttp: 400,
        provider: target.provider,
        account: target.account,
      })
    }
    let parentId = params.parentRef
      ? await resolveFolderPathOrId(adapter, ctx, params.parentRef, { createMissing: true })
      : undefined
    let lastFolder: CloudItem | null = null
    for (const seg of segments) {
      lastFolder = await adapter.mkdir(ctx, seg, parentId)
      parentId = adapter.id === 'dropbox' ? (lastFolder.pathDisplay || lastFolder.id) : lastFolder.id
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'system',
      provider: target.provider,
      account: target.account,
      action: 'mkdir',
      targetName: params.pathOrName,
      status: 'ok',
    })
    return { provider: target.provider, account: target.account, folder: lastFolder! }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'system',
      provider: target.provider,
      account: target.account,
      action: 'mkdir',
      targetName: params.pathOrName,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function cloudUpload(
  params: {
    agent: Pick<AlfredAgentDefinition, 'id' | 'workspace' | 'workspaceAbsPath' | 'protectedPaths'>
    localPath: string
    remotePathOrName?: string
    parentRef?: string
    onConflict?: CloudUploadConflictMode
    provider?: string
    account?: string
    chunkBytes?: number
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; item: CloudItem }> {
  const localAbs = resolvePathInWorkspace(params.agent.workspaceAbsPath, params.localPath)
  assertSafeCloudUploadPath(params.agent, localAbs, params.localPath)
  if (!existsSync(localAbs)) {
    throw new CloudStorageError('CLOUD_NOT_FOUND', `Helyi fájl nem található: "${params.localPath}"`, { statusHttp: 404 })
  }
  const st = statSync(localAbs)
  if (!st.isFile()) {
    throw new CloudStorageError('CLOUD_API_ERROR', `A feltöltendő útvonal nem reguláris fájl: "${params.localPath}"`, {
      statusHttp: 400,
    })
  }

  const env = resolveEnv(opts)
  const maxUploadBytes = resolveMaxUploadBytes(env)
  if (st.size > maxUploadBytes) {
    const fileMb = Math.round((st.size / 1_048_576) * 10) / 10
    const maxMb = Math.round((maxUploadBytes / 1_048_576) * 10) / 10
    throw new CloudStorageError(
      'CLOUD_UPLOAD_LIMIT_EXCEEDED',
      `A feltöltendő fájl (${fileMb} MB) meghaladja a vezérlő VPS ALFRED_CLOUD_MAX_UPLOAD_MB (${maxMb} MB) korlátját. ` +
        `Nagy fájlok feltöltéséhez használd a 03-as munkagép közvetlen felhő-szinkronját!`,
      { statusHttp: 413, details: { fileMb, maxMb } },
    )
  }

  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  const rawRemote = (params.remotePathOrName || basename(localAbs)).trim()
  assertAccountWritable(target, rawRemote)

  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  const projectRoot = resolve(opts?.projectRoot ?? PROJECT_ROOT)

  const runUpload = async (): Promise<CloudItem> => {
    const ctx = await buildAdapterContext(target, opts)
    let parentId = params.parentRef
      ? await resolveFolderPathOrId(adapter, ctx, params.parentRef, { createMissing: true })
      : undefined
    let remoteName = rawRemote
    if (rawRemote.includes('/') || rawRemote.includes('\\')) {
      const segs = splitAndValidatePathSegments(rawRemote)
      remoteName = segs[segs.length - 1] || basename(localAbs)
      const subDir = segs.slice(0, -1).join('/')
      if (subDir) {
        const combinedDir = params.parentRef ? `${params.parentRef}/${subDir}` : subDir
        parentId = await resolveFolderPathOrId(adapter, ctx, combinedDir, { createMissing: true })
      }
    }
    return adapter.uploadStream(ctx, {
      localFilePath: localAbs,
      remoteName,
      fileSizeBytes: st.size,
      mimeType: guessMimeTypeFromFilename(remoteName),
      parentRef: parentId,
      onConflict: params.onConflict ?? 'update_in_place',
      chunkBytes: params.chunkBytes,
    })
  }

  try {
    const item =
      st.size >= HEAVY_TRANSFER_HOLD_MIN_BYTES
        ? await withCloudHeavyJobHold(projectRoot, params.agent.id, `upload:${basename(localAbs)}`, runUpload)
        : await runUpload()
    recordCloudActivity(db, {
      agentId: params.agent.id,
      provider: target.provider,
      account: target.account,
      action: 'upload',
      targetName: item.name || rawRemote,
      bytes: st.size,
      status: 'ok',
    })
    return { provider: target.provider, account: target.account, item }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: params.agent.id,
      provider: target.provider,
      account: target.account,
      action: 'upload',
      targetName: rawRemote,
      bytes: st.size,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function cloudDownload(
  params: {
    agent: Pick<AlfredAgentDefinition, 'id' | 'workspace' | 'workspaceAbsPath' | 'protectedPaths'>
    fileRefOrPath: string
    localDestPath: string
    exportFormat?: string
    provider?: string
    account?: string
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; result: CloudDownloadResult }> {
  const destAbs = resolvePathInWorkspace(params.agent.workspaceAbsPath, params.localDestPath)
  assertWriteAllowed(params.agent, destAbs, params.localDestPath)
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  const env = resolveEnv(opts)
  const maxDownloadBytes = resolveMaxDownloadBytes(env)
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  const projectRoot = resolve(opts?.projectRoot ?? PROJECT_ROOT)

  const runDownload = async (): Promise<CloudDownloadResult> => {
    const ctx = await buildAdapterContext(target, opts)
    const resolvedRef = await resolveItemRefOrPath(adapter, ctx, params.fileRefOrPath)
    return adapter.downloadStream(ctx, {
      fileRef: resolvedRef,
      destFilePath: destAbs,
      maxDownloadBytes,
      exportFormat: params.exportFormat,
    })
  }

  try {
    const result = await withCloudHeavyJobHold(
      projectRoot,
      params.agent.id,
      `download:${basename(destAbs)}`,
      runDownload,
    )
    recordCloudActivity(db, {
      agentId: params.agent.id,
      provider: target.provider,
      account: target.account,
      action: 'download',
      targetName: result.item.name || params.fileRefOrPath,
      bytes: result.bytesWritten,
      status: 'ok',
    })
    return { provider: target.provider, account: target.account, result }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: params.agent.id,
      provider: target.provider,
      account: target.account,
      action: 'download',
      targetName: params.fileRefOrPath,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function cloudShare(
  params: {
    fileRefOrPath: string
    email?: string
    role?: CloudShareRole
    publicLink?: boolean
    notify?: boolean
    expiresInDays?: number
    provider?: string
    account?: string
  },
  opts?: CloudStorageOptions,
): Promise<CloudShareResult> {
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  assertAccountWritable(target, params.fileRefOrPath)
  const cfg = readCloudConfigJson(opts)
  const env = resolveEnv(opts)
  const policy = resolveCloudSharePolicy({
    target,
    cfg,
    env,
    explicitEmail: params.email,
    publicLink: params.publicLink,
    notify: params.notify,
  })
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)

  try {
    const ctx = await buildAdapterContext(target, opts)
    const resolvedRef = await resolveItemRefOrPath(adapter, ctx, params.fileRefOrPath)
    const res = await adapter.share(ctx, {
      fileRef: resolvedRef,
      email: policy.email,
      role: params.role === 'writer' ? 'writer' : 'reader',
      publicLink: policy.publicLink,
      notify: policy.notify,
      expiresInDays: params.expiresInDays,
    })
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'system',
      provider: target.provider,
      account: target.account,
      action: 'share',
      targetName: params.fileRefOrPath,
      status: 'ok',
      detail: `${res.mode}:${res.sharedWith}`,
    })
    return res
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'system',
      provider: target.provider,
      account: target.account,
      action: 'share',
      targetName: params.fileRefOrPath,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function cloudRename(
  params: {
    itemRef: string
    newName: string
    provider?: string
    account?: string
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; item: CloudItem }> {
  const cleanName = String(params.newName ?? '').trim()
  if (!cleanName || cleanName === '.' || cleanName === '..' || /[/\\]/.test(cleanName)) {
    throw new CloudStorageError(
      'CLOUD_API_ERROR',
      'Érvénytelen új név: nem lehet üres és nem tartalmazhat perjelet (/ vagy \\) vagy ".." elemet.',
      { statusHttp: 400 },
    )
  }
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  assertAccountWritable(target, params.itemRef)
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  try {
    const ctx = await buildAdapterContext(target, opts)
    const item = await adapter.rename(ctx, params.itemRef, cleanName)
    pathIdCache.clear()
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'dashboard',
      provider: target.provider,
      account: target.account,
      action: 'rename',
      targetName: cleanName,
      status: 'ok',
      detail: params.itemRef,
    })
    return { provider: target.provider, account: target.account, item }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'dashboard',
      provider: target.provider,
      account: target.account,
      action: 'rename',
      targetName: cleanName,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function cloudDelete(
  params: {
    itemRef: string
    provider?: string
    account?: string
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; deleted: boolean; trashed: boolean }> {
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  assertAccountWritable(target, params.itemRef)
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  try {
    const ctx = await buildAdapterContext(target, opts)
    const res = await adapter.deleteItem(ctx, params.itemRef)
    pathIdCache.clear()
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'dashboard',
      provider: target.provider,
      account: target.account,
      action: 'delete',
      targetName: params.itemRef,
      status: 'ok',
      detail: res.trashed ? 'trashed' : 'deleted',
    })
    return { provider: target.provider, account: target.account, ...res }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'dashboard',
      provider: target.provider,
      account: target.account,
      action: 'delete',
      targetName: params.itemRef,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

const MAX_DASHBOARD_BROWSER_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MiB cap for 256 MB web heap

export async function cloudUploadBuffer(
  params: {
    fileName: string
    buffer: Buffer
    mimeType?: string
    parentRef?: string
    onConflict?: CloudUploadConflictMode
    provider?: string
    account?: string
  },
  opts?: CloudStorageOptions,
): Promise<{ provider: CloudProviderId; account: string; item: CloudItem }> {
  const cleanName = basename(String(params.fileName ?? '').trim())
  if (!cleanName || cleanName === '.' || cleanName === '..') {
    throw new CloudStorageError('CLOUD_API_ERROR', 'Érvénytelen fájlnév.', { statusHttp: 400 })
  }
  if (params.buffer.byteLength > MAX_DASHBOARD_BROWSER_UPLOAD_BYTES) {
    throw new CloudStorageError(
      'CLOUD_UPLOAD_LIMIT_EXCEEDED',
      `A böngészős feltöltés maximuma 20 MB (kapott: ${Math.round((params.buffer.byteLength / 1_048_576) * 10) / 10} MB). Nagy fájlokhoz használd a VPS/ügynök stream feltöltést.`,
      { statusHttp: 413 },
    )
  }
  const target = resolveCloudTarget({ provider: params.provider, account: params.account }, opts)
  const effectiveRel = params.parentRef ? `${params.parentRef.replace(/\/+$/, '')}/${cleanName}` : cleanName
  assertAccountWritable(target, effectiveRel)
  assertAccountWritable(target, cleanName)
  const adapter = getCloudAdapter(target.provider)
  const db = resolveOptionalDb(opts)
  const tmpFile = join(tmpdir(), `alfred-web-up-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.cloud-part.tmp`)
  try {
    writeFileSync(tmpFile, params.buffer)
    const ctx = await buildAdapterContext(target, opts)
    const parentId = params.parentRef
      ? await resolveFolderPathOrId(adapter, ctx, params.parentRef, { createMissing: false })
      : undefined
    const item = await adapter.uploadStream(ctx, {
      localFilePath: tmpFile,
      fileSizeBytes: params.buffer.byteLength,
      remoteName: cleanName,
      parentRef: parentId,
      mimeType: params.mimeType || guessMimeTypeFromFilename(cleanName),
      onConflict: params.onConflict ?? 'update_in_place',
    })
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'dashboard',
      provider: target.provider,
      account: target.account,
      action: 'upload',
      targetName: cleanName,
      bytes: params.buffer.byteLength,
      status: 'ok',
      detail: item.id,
    })
    return { provider: target.provider, account: target.account, item }
  } catch (err) {
    if (err instanceof CloudReauthRequiredError) {
      markAccountReauthState(target.provider, target.account, true, err.message, opts)
    }
    recordCloudActivity(db, {
      agentId: opts?.agentId ?? 'dashboard',
      provider: target.provider,
      account: target.account,
      action: 'upload',
      targetName: cleanName,
      bytes: params.buffer.byteLength,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    } catch {
      // ignore cleanup error
    }
  }
}

// --- Short-lived token minting for 03 (feat/worker-machines) ---

export type MintCloudTokenRequest =
  | CloudProviderId
  | {
      provider?: CloudProviderId
      account?: string
    }

export interface MintedCloudToken {
  provider: CloudProviderId
  account: string
  accountEmail: string | null
  accessMode: CloudAccessMode
  readOnly: boolean
  accessToken: string
  expiresAtIso: string
  expiresInSec: number
  rootRef: string | null
  defaultShareEmail: string | null
  recommendedChunkBytes: number
  transferHints: {
    apiBaseUrl: string
    uploadMode: 'gdrive_resumable' | 'onedrive_upload_session' | 'dropbox_upload_session'
  }
}

/**
 * Issues a short-lived OAuth2 `access_token` for internal worker modules (`03 worker-machines`)
 * so Spot CPU/GPU VMs stream large assets directly with Google Drive / OneDrive / Dropbox
 * WITHOUT ever receiving `refresh_token` or `client_secret`.
 */
export async function mintShortLivedCloudToken(
  req?: MintCloudTokenRequest,
  opts?: CloudStorageOptions,
): Promise<MintedCloudToken> {
  const normalized = typeof req === 'string' ? { provider: req } : (req ?? {})
  const target = resolveCloudTarget(normalized, opts)
  const adapter = getCloudAdapter(target.provider)
  const cfg = readCloudConfigJson(opts)
  const env = resolveEnv(opts)
  const { accessToken, expiresAtMs } = await getValidAccessToken(target, opts)
  const expiresInSec = Math.max(1, Math.floor((expiresAtMs - Date.now()) / 1000))

  recordCloudActivity(resolveOptionalDb(opts), {
    agentId: opts?.agentId ?? 'worker-machines',
    provider: target.provider,
    account: target.account,
    action: 'mint_token',
    targetName: target.meta.rootRef || 'root',
    status: 'ok',
    detail: `ttl=${expiresInSec}s`,
  })

  return {
    provider: target.provider,
    account: target.account,
    accountEmail: target.meta.accountEmail ?? null,
    accessMode: target.meta.accessMode,
    readOnly: target.meta.accessMode === 'read_only',
    accessToken,
    expiresAtIso: new Date(expiresAtMs).toISOString(),
    expiresInSec,
    rootRef: target.meta.rootRef ?? null,
    defaultShareEmail:
      target.meta.defaultShareEmail ||
      cfg.cloud_default_share_email ||
      env['ALFRED_CLOUD_SHARE_EMAIL'] ||
      null,
    recommendedChunkBytes: adapter.recommendedChunkBytes,
    transferHints: {
      apiBaseUrl: adapter.apiBaseUrl,
      uploadMode: adapter.uploadMode,
    },
  }
}

// --- OAuth2 PKCE Flow & Admin API Helpers ---

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function sweepExpiredOAuthSessions(): void {
  const now = Date.now()
  for (const [k, v] of pendingOAuthSessions) {
    if (v.expiresAtMs <= now) pendingOAuthSessions.delete(k)
  }
}

export function startCloudOAuthFlow(
  params: {
    provider: string
    redirectUri: string
    account?: string
    createNew?: boolean
    label?: string
    accessMode?: CloudAccessMode
  },
  opts?: CloudStorageOptions,
): {
  provider: CloudProviderId
  account: string | null
  state: string
  redirectUri: string
  authUrl: string
  accessMode: CloudAccessMode
} {
  sweepExpiredOAuthSessions()
  const provider = assertValidCloudProvider(params.provider)
  const vaultOps = resolveVaultOps(opts)
  const cfg = readCloudConfigJson(opts)
  const vaultIds = getPresentVaultSecretIds(vaultOps)

  const targetAccount =
    params.account && params.account.trim()
      ? normalizeCloudAccountKey(params.account)
      : params.createNew
        ? null
        : resolveDefaultAccountForProvider(provider, cfg, vaultIds)

  const lookupAcc = targetAccount ?? DEFAULT_CLOUD_ACCOUNT
  const clientId =
    (lookupAcc !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_id', lookupAcc)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_id', DEFAULT_CLOUD_ACCOUNT)) ??
    ''
  const clientSecret =
    (lookupAcc !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', lookupAcc)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', DEFAULT_CLOUD_ACCOUNT)) ??
    ''

  if (!clientId.trim() || !clientSecret.trim()) {
    throw new CloudStorageError(
      'CLOUD_NOT_CONFIGURED',
      `Előbb mentsd el a(z) ${provider} OAuth2 Client ID és Client Secret kulcsait a Vaultba!`,
      { statusHttp: 400, provider },
    )
  }

  const state = base64UrlEncode(randomBytes(24))
  const codeVerifier = base64UrlEncode(randomBytes(32))
  const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest())
  const accessMode: CloudAccessMode = params.accessMode === 'read_only' ? 'read_only' : 'read_write'
  const redirectUri = params.redirectUri.trim()

  pendingOAuthSessions.set(state, {
    provider,
    account: targetAccount,
    label: params.label?.trim() || undefined,
    accessMode,
    redirectUri,
    codeVerifier,
    expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS,
  })

  const adapter = getCloudAdapter(provider)
  const authUrl = adapter.buildAuthorizationUrl({
    clientId: clientId.trim(),
    redirectUri,
    state,
    codeChallenge,
    accessMode,
  })

  return {
    provider,
    account: targetAccount,
    state,
    redirectUri,
    authUrl,
    accessMode,
  }
}

export function extractCodeAndStateFromInput(input: {
  code?: string
  state?: string
  callbackUrl?: string
}): { code: string; state: string } {
  let code = (input.code ?? '').trim()
  let state = (input.state ?? '').trim()

  const rawUrl = (input.callbackUrl ?? '').trim()
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://localhost/cb?${rawUrl.replace(/^\?/, '')}`)
      const err = parsed.searchParams.get('error')
      if (err) {
        const desc = parsed.searchParams.get('error_description') || err
        throw new CloudStorageError('CLOUD_OAUTH_STATE_INVALID', `OAuth2 hiba a visszatérési URL-ben: ${desc}`, {
          statusHttp: 400,
        })
      }
      code = code || (parsed.searchParams.get('code') ?? '').trim()
      state = state || (parsed.searchParams.get('state') ?? '').trim()
    } catch (err) {
      if (err instanceof CloudStorageError) throw err
      // If user pasted bare authorization code in callbackUrl field
      if (!code && !rawUrl.includes(' ')) {
        code = rawUrl
      }
    }
  }

  return { code, state }
}

export async function completeCloudOAuthFlow(
  params: {
    provider: string
    code?: string
    state?: string
    callbackUrl?: string
  },
  opts?: CloudStorageOptions,
): Promise<{
  provider: CloudProviderId
  account: string
  accountEmail: string | null
  accessMode: CloudAccessMode
  quota: CloudQuotaInfo
}> {
  sweepExpiredOAuthSessions()
  const provider = assertValidCloudProvider(params.provider)
  const { code, state } = extractCodeAndStateFromInput(params)
  if (!code || !state) {
    throw new CloudStorageError('CLOUD_OAUTH_STATE_INVALID', 'Hiányzó OAuth2 code vagy state paraméter.', {
      statusHttp: 400,
      provider,
    })
  }

  const session = pendingOAuthSessions.get(state)
  if (!session || session.provider !== provider || session.expiresAtMs <= Date.now()) {
    pendingOAuthSessions.delete(state)
    throw new CloudStorageError(
      'CLOUD_OAUTH_STATE_INVALID',
      'Érvénytelen vagy lejárt OAuth2 state token. Indítsd újra a fiókválasztó folyamatot!',
      { statusHttp: 400, provider },
    )
  }
  // Single-use state token
  pendingOAuthSessions.delete(state)

  const vaultOps = resolveVaultOps(opts)
  const fetchImpl = opts?.fetchImpl ?? fetch
  const lookupAcc = session.account ?? DEFAULT_CLOUD_ACCOUNT
  const clientId =
    (lookupAcc !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_id', lookupAcc)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_id', DEFAULT_CLOUD_ACCOUNT)) ??
    ''
  const clientSecret =
    (lookupAcc !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', lookupAcc)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', DEFAULT_CLOUD_ACCOUNT)) ??
    ''

  const adapter = getCloudAdapter(provider)
  const tokens = await adapter.exchangeCodeForTokens({
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    code,
    redirectUri: session.redirectUri,
    codeVerifier: session.codeVerifier,
    fetchImpl,
  })

  // Probe connected account email & quota using the fresh access token
  const quota = await adapter.getAccountQuota({
    accessToken: tokens.accessToken,
    account: lookupAcc,
    fetchImpl,
  })

  const cfgBefore = readCloudConfigJson(opts)
  const vaultIdsBefore = getPresentVaultSecretIds(vaultOps)
  const existingKeys = new Set(discoverAccountKeysForProvider(provider, cfgBefore, vaultIdsBefore))
  const finalAccount =
    session.account ??
    (!vaultIdsBefore.has(cloudVaultKey(provider, 'refresh_token', DEFAULT_CLOUD_ACCOUNT))
      ? DEFAULT_CLOUD_ACCOUNT
      : deriveAccountAliasFromEmail(quota.accountEmail, existingKeys))

  vaultOps.setSecret(
    cloudVaultKey(provider, 'refresh_token', finalAccount),
    `Cloud ${provider} (${finalAccount}) Refresh Token`,
    tokens.refreshToken,
  )
  if (quota.accountEmail) {
    vaultOps.setSecret(
      cloudVaultKey(provider, 'account_email', finalAccount),
      `Cloud ${provider} (${finalAccount}) Account Email`,
      quota.accountEmail,
    )
  }

  accessTokenCache.set(tokenCacheKey(provider, finalAccount), {
    accessToken: tokens.accessToken,
    expiresAtMs: Date.now() + Math.max(60, tokens.expiresInSec) * 1000,
  })

  const nowIso = new Date().toISOString()
  writeCloudConfigJson((cfg) => {
    cfg.accounts = cfg.accounts ?? {}
    cfg.accounts[provider] = cfg.accounts[provider] ?? {}
    const prev = getAccountMeta(cfg, provider, finalAccount)
    cfg.accounts[provider]![finalAccount] = {
      ...prev,
      label: session.label ?? prev.label ?? (finalAccount === DEFAULT_CLOUD_ACCOUNT ? 'Alapértelmezett' : finalAccount),
      accountEmail: quota.accountEmail ?? prev.accountEmail ?? null,
      accessMode: session.accessMode,
      needsReauth: false,
      lastError: null,
      cachedQuota: quota,
      quotaFetchedAt: nowIso,
      updatedAt: nowIso,
    }
    cfg.providerDefaults = cfg.providerDefaults ?? {}
    const currentDefault = cfg.providerDefaults[provider]
    if (!currentDefault || !vaultIdsBefore.has(cloudVaultKey(provider, 'refresh_token', currentDefault))) {
      cfg.providerDefaults[provider] = finalAccount
    }
  }, opts)

  recordCloudActivity(resolveOptionalDb(opts), {
    agentId: opts?.agentId ?? 'dashboard',
    provider,
    account: finalAccount,
    action: 'oauth_connect',
    targetName: quota.accountEmail || finalAccount,
    status: 'ok',
    detail: `mode=${session.accessMode}`,
  })

  return {
    provider,
    account: finalAccount,
    accountEmail: quota.accountEmail,
    accessMode: session.accessMode,
    quota,
  }
}

export interface CloudAccountStatusView {
  account: string
  label: string
  isDefault: boolean
  status: CloudConnectionHealth
  accessMode: CloudAccessMode
  hasRefreshToken: boolean
  hasCustomClient: boolean
  accountEmail: string | null
  rootRef: string | null
  readOnlyPrefixes: string[]
  defaultShareEmail: string | null
  allowPublicLinks: boolean | null
  needsReauth: boolean
  lastError: string | null
  quota: CloudQuotaInfo | null
  quotaFetchedAt: string | null
}

export interface CloudProviderStatusView {
  id: CloudProviderId
  displayName: string
  hasClientId: boolean
  hasClientSecret: boolean
  defaultAccount: string
  connectedCount: number
  accounts: CloudAccountStatusView[]
}

export interface CloudAdminStatusSnapshot {
  defaultProvider: CloudProviderId
  defaultShareEmail: string | null
  maxDownloadMb: number
  maxUploadMb: number
  allowPublicLinks: boolean
  providers: CloudProviderStatusView[]
  recentActivity: CloudActivityRecord[]
}

/**
 * Decryption-free by default (`includeLiveQuota = false`) so `GET /api/admin/cloud/status`
 * runs in < 1 ms and ~0 MB extra RAM inside the 256 MB `alfred-web` process.
 */
export async function getCloudAdminStatus(
  opts?: CloudStorageOptions & {
    includeLiveQuota?: boolean
    filterProvider?: CloudProviderId
    filterAccount?: string
  },
): Promise<CloudAdminStatusSnapshot> {
  const vaultOps = resolveVaultOps(opts)
  const env = resolveEnv(opts)
  const cfg = readCloudConfigJson(opts)
  const vaultIds = getPresentVaultSecretIds(vaultOps)
  const defaultProvider = resolveDefaultProvider(cfg, vaultOps)

  const providers: CloudProviderStatusView[] = []

  for (const p of CLOUD_PROVIDERS) {
    const adapter = getCloudAdapter(p)
    const hasClientId = vaultIds.has(cloudVaultKey(p, 'client_id', DEFAULT_CLOUD_ACCOUNT))
    const hasClientSecret = vaultIds.has(cloudVaultKey(p, 'client_secret', DEFAULT_CLOUD_ACCOUNT))
    const defaultAccount = resolveDefaultAccountForProvider(p, cfg, vaultIds)
    const keys = discoverAccountKeysForProvider(p, cfg, vaultIds)

    const accounts: CloudAccountStatusView[] = []
    for (const acc of keys) {
      const meta = getAccountMeta(cfg, p, acc)
      const hasRefreshToken = vaultIds.has(cloudVaultKey(p, 'refresh_token', acc))
      const hasCustomClient =
        acc !== DEFAULT_CLOUD_ACCOUNT &&
        vaultIds.has(cloudVaultKey(p, 'client_id', acc)) &&
        vaultIds.has(cloudVaultKey(p, 'client_secret', acc))

      // Omit unconfigured non-default ghost keys
      if (acc !== DEFAULT_CLOUD_ACCOUNT && !hasRefreshToken && !hasCustomClient && !cfg.accounts?.[p]?.[acc]) {
        continue
      }

      let quota = meta.cachedQuota ?? null
      let quotaFetchedAt = meta.quotaFetchedAt ?? null
      let needsReauth = meta.needsReauth === true
      let lastError = meta.lastError ?? null
      let accountEmail = meta.accountEmail ?? null

      const shouldFetchLive =
        opts?.includeLiveQuota === true &&
        hasRefreshToken &&
        (!opts.filterProvider || opts.filterProvider === p) &&
        (!opts.filterAccount || opts.filterAccount === acc)

      if (shouldFetchLive) {
        try {
          const tested = await testCloudConnection(p, acc, opts)
          quota = tested.quota
          quotaFetchedAt = new Date().toISOString()
          accountEmail = tested.quota.accountEmail ?? accountEmail
          needsReauth = false
          lastError = null
        } catch (err) {
          if (err instanceof CloudReauthRequiredError) {
            needsReauth = true
            lastError = err.message
          } else {
            lastError = err instanceof Error ? err.message : String(err)
          }
        }
      }

      const status: CloudConnectionHealth = needsReauth
        ? 'needs_reauth'
        : hasRefreshToken
          ? 'connected'
          : (hasClientId && hasClientSecret) || hasCustomClient
            ? 'client_configured'
            : 'disconnected'

      accounts.push({
        account: acc,
        label: meta.label ?? (acc === DEFAULT_CLOUD_ACCOUNT ? 'Alapértelmezett' : acc),
        isDefault: acc === defaultAccount,
        status,
        accessMode: meta.accessMode,
        hasRefreshToken,
        hasCustomClient,
        accountEmail,
        rootRef: meta.rootRef ?? null,
        readOnlyPrefixes: meta.readOnlyPrefixes ?? [],
        defaultShareEmail: meta.defaultShareEmail ?? null,
        allowPublicLinks: meta.allowPublicLinks ?? null,
        needsReauth,
        lastError,
        quota,
        quotaFetchedAt,
      })
    }

    providers.push({
      id: p,
      displayName: adapter.displayName,
      hasClientId,
      hasClientSecret,
      defaultAccount,
      connectedCount: accounts.filter((a) => a.hasRefreshToken && !a.needsReauth).length,
      accounts,
    })
  }

  return {
    defaultProvider,
    defaultShareEmail: cfg.cloud_default_share_email || env['ALFRED_CLOUD_SHARE_EMAIL'] || null,
    maxDownloadMb: Math.round(resolveMaxDownloadBytes(env) / 1_048_576),
    maxUploadMb: Math.round(resolveMaxUploadBytes(env) / 1_048_576),
    allowPublicLinks: cfg.cloud_allow_public_links === true,
    providers,
    recentActivity: listRecentCloudActivity(resolveOptionalDb(opts), 15),
  }
}

export interface SaveCloudConfigPayload {
  defaultProvider?: string
  defaultShareEmail?: string | null
  allowPublicLinks?: boolean
  provider?: string
  account?: string
  defaultAccount?: string
  clientId?: string
  clientSecret?: string
  rootRef?: string | null
  label?: string
  accessMode?: CloudAccessMode
  readOnlyPrefixes?: string[]
  accountDefaultShareEmail?: string | null
  accountAllowPublicLinks?: boolean | null
}

export function saveCloudAdminConfig(
  payload: SaveCloudConfigPayload,
  opts?: CloudStorageOptions,
): CloudModuleConfigJson {
  const vaultOps = resolveVaultOps(opts)
  const prov = payload.provider ? assertValidCloudProvider(payload.provider) : undefined
  const acc = payload.account !== undefined ? normalizeCloudAccountKey(payload.account) : DEFAULT_CLOUD_ACCOUNT

  if (prov && payload.clientId && payload.clientId.trim()) {
    vaultOps.setSecret(
      cloudVaultKey(prov, 'client_id', acc),
      `Cloud ${prov} (${acc}) Client ID`,
      payload.clientId.trim(),
    )
  }
  if (prov && payload.clientSecret && payload.clientSecret.trim()) {
    vaultOps.setSecret(
      cloudVaultKey(prov, 'client_secret', acc),
      `Cloud ${prov} (${acc}) Client Secret`,
      payload.clientSecret.trim(),
    )
  }
  if (payload.defaultProvider && isCloudProviderId(payload.defaultProvider.trim().toLowerCase())) {
    vaultOps.setSecret('cloud_default_provider', 'Cloud Default Provider', payload.defaultProvider.trim().toLowerCase())
  }
  if (payload.defaultShareEmail !== undefined) {
    const cleanEmail = (payload.defaultShareEmail ?? '').trim()
    if (cleanEmail) {
      vaultOps.setSecret('cloud_default_share_email', 'Cloud Default Share Email', cleanEmail)
    } else {
      vaultOps.deleteSecret('cloud_default_share_email')
    }
  }

  return writeCloudConfigJson((cfg) => {
    if (payload.defaultProvider) {
      cfg.cloud_default_provider = assertValidCloudProvider(payload.defaultProvider)
    }
    if (payload.defaultShareEmail !== undefined) {
      cfg.cloud_default_share_email = (payload.defaultShareEmail ?? '').trim() || null
    }
    if (typeof payload.allowPublicLinks === 'boolean') {
      cfg.cloud_allow_public_links = payload.allowPublicLinks
    }

    if (prov) {
      if (payload.defaultAccount) {
        cfg.providerDefaults = cfg.providerDefaults ?? {}
        cfg.providerDefaults[prov] = normalizeCloudAccountKey(payload.defaultAccount)
      }

      const hasAccountField =
        payload.rootRef !== undefined ||
        payload.label !== undefined ||
        payload.accessMode !== undefined ||
        payload.readOnlyPrefixes !== undefined ||
        payload.accountDefaultShareEmail !== undefined ||
        payload.accountAllowPublicLinks !== undefined

      if (hasAccountField) {
        cfg.accounts = cfg.accounts ?? {}
        cfg.accounts[prov] = cfg.accounts[prov] ?? {}
        const prev = getAccountMeta(cfg, prov, acc)
        const nextRoot =
          payload.rootRef !== undefined ? (payload.rootRef ?? '').trim() || null : (prev.rootRef ?? null)
        cfg.accounts[prov]![acc] = {
          ...prev,
          ...(payload.label !== undefined ? { label: payload.label.trim() || acc } : {}),
          ...(payload.accessMode !== undefined
            ? { accessMode: payload.accessMode === 'read_only' ? 'read_only' : 'read_write' }
            : {}),
          rootRef: nextRoot,
          ...(payload.readOnlyPrefixes !== undefined
            ? {
                readOnlyPrefixes: payload.readOnlyPrefixes
                  .map((s) => String(s || '').trim())
                  .filter(Boolean),
              }
            : {}),
          ...(payload.accountDefaultShareEmail !== undefined
            ? { defaultShareEmail: (payload.accountDefaultShareEmail ?? '').trim() || null }
            : {}),
          ...(payload.accountAllowPublicLinks !== undefined
            ? {
                allowPublicLinks:
                  payload.accountAllowPublicLinks === null ? undefined : Boolean(payload.accountAllowPublicLinks),
              }
            : {}),
          updatedAt: new Date().toISOString(),
        }

        if (acc === DEFAULT_CLOUD_ACCOUNT && payload.rootRef !== undefined) {
          ;(cfg as Record<string, unknown>)[`cloud_${prov}_root_ref`] = nextRoot
          if (nextRoot) {
            vaultOps.setSecret(cloudVaultKey(prov, 'root_ref', DEFAULT_CLOUD_ACCOUNT), `Cloud ${prov} Root Ref`, nextRoot)
          } else {
            vaultOps.deleteSecret(cloudVaultKey(prov, 'root_ref', DEFAULT_CLOUD_ACCOUNT))
          }
        } else if (acc !== DEFAULT_CLOUD_ACCOUNT && payload.rootRef !== undefined) {
          if (nextRoot) {
            vaultOps.setSecret(cloudVaultKey(prov, 'root_ref', acc), `Cloud ${prov} (${acc}) Root Ref`, nextRoot)
          } else {
            vaultOps.deleteSecret(cloudVaultKey(prov, 'root_ref', acc))
          }
        }
      }
    }
  }, opts)
}

export async function testCloudConnection(
  providerRaw: string,
  accountRaw?: string,
  opts?: CloudStorageOptions,
): Promise<{ ok: true; provider: CloudProviderId; account: string; quota: CloudQuotaInfo }> {
  const provider = assertValidCloudProvider(providerRaw)
  // Temporarily allow testing a needs_reauth account to check if it recovered
  const vaultOps = resolveVaultOps(opts)
  const cfg = readCloudConfigJson(opts)
  const vaultIds = getPresentVaultSecretIds(vaultOps)
  const account = accountRaw ? normalizeCloudAccountKey(accountRaw) : resolveDefaultAccountForProvider(provider, cfg, vaultIds)
  const clientId =
    (account !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_id', account)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_id', DEFAULT_CLOUD_ACCOUNT)) ??
    ''
  const clientSecret =
    (account !== DEFAULT_CLOUD_ACCOUNT ? vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', account)) : null) ??
    vaultOps.getSecret(cloudVaultKey(provider, 'client_secret', DEFAULT_CLOUD_ACCOUNT)) ??
    ''
  const refreshToken = vaultOps.getSecret(cloudVaultKey(provider, 'refresh_token', account)) ?? ''
  if (!clientId.trim() || !clientSecret.trim() || !refreshToken.trim()) {
    throw new CloudStorageError('CLOUD_NOT_CONFIGURED', `A(z) ${provider}::${account} fiók nincs összekötve.`, {
      statusHttp: 400,
      provider,
      account,
    })
  }

  const target: ResolvedCloudTarget = {
    provider,
    account,
    explicitAccountRequested: Boolean(accountRaw),
    meta: { ...getAccountMeta(cfg, provider, account), needsReauth: false },
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    refreshToken: refreshToken.trim(),
  }

  accessTokenCache.delete(tokenCacheKey(provider, account))
  const adapter = getCloudAdapter(provider)
  const ctx = await buildAdapterContext(target, opts)
  const quota = await adapter.getAccountQuota(ctx)
  const nowIso = new Date().toISOString()

  writeCloudConfigJson((nextCfg) => {
    nextCfg.accounts = nextCfg.accounts ?? {}
    nextCfg.accounts[provider] = nextCfg.accounts[provider] ?? {}
    const prev = getAccountMeta(nextCfg, provider, account)
    nextCfg.accounts[provider]![account] = {
      ...prev,
      accountEmail: quota.accountEmail ?? prev.accountEmail ?? null,
      needsReauth: false,
      lastError: null,
      cachedQuota: quota,
      quotaFetchedAt: nowIso,
      updatedAt: nowIso,
    }
  }, opts)

  return { ok: true, provider, account, quota }
}

export function disconnectCloudAccount(
  providerRaw: string,
  params?: { account?: string; purgeClientCredentials?: boolean },
  opts?: CloudStorageOptions,
): { provider: CloudProviderId; account: string; nextDefaultAccount: string } {
  const provider = assertValidCloudProvider(providerRaw)
  const vaultOps = resolveVaultOps(opts)
  const cfgBefore = readCloudConfigJson(opts)
  const vaultIdsBefore = getPresentVaultSecretIds(vaultOps)
  const account = params?.account
    ? normalizeCloudAccountKey(params.account)
    : resolveDefaultAccountForProvider(provider, cfgBefore, vaultIdsBefore)

  vaultOps.deleteSecret(cloudVaultKey(provider, 'refresh_token', account))
  vaultOps.deleteSecret(cloudVaultKey(provider, 'account_email', account))
  if (params?.purgeClientCredentials) {
    vaultOps.deleteSecret(cloudVaultKey(provider, 'client_id', account))
    vaultOps.deleteSecret(cloudVaultKey(provider, 'client_secret', account))
  }
  accessTokenCache.delete(tokenCacheKey(provider, account))

  let nextDefaultAccount = DEFAULT_CLOUD_ACCOUNT
  writeCloudConfigJson((cfg) => {
    if (cfg.accounts?.[provider]) {
      if (account === DEFAULT_CLOUD_ACCOUNT) {
        const prev = getAccountMeta(cfg, provider, DEFAULT_CLOUD_ACCOUNT)
        cfg.accounts[provider]![DEFAULT_CLOUD_ACCOUNT] = {
          ...prev,
          accountEmail: null,
          needsReauth: false,
          lastError: null,
          cachedQuota: null,
          quotaFetchedAt: null,
          updatedAt: new Date().toISOString(),
        }
      } else {
        delete cfg.accounts[provider]![account]
      }
    }
    const vaultIdsAfter = getPresentVaultSecretIds(vaultOps)
    const remaining = discoverAccountKeysForProvider(provider, cfg, vaultIdsAfter).filter((k) =>
      vaultIdsAfter.has(cloudVaultKey(provider, 'refresh_token', k)),
    )
    cfg.providerDefaults = cfg.providerDefaults ?? {}
    if (cfg.providerDefaults[provider] === account || !cfg.providerDefaults[provider]) {
      nextDefaultAccount = remaining[0] ?? DEFAULT_CLOUD_ACCOUNT
      cfg.providerDefaults[provider] = nextDefaultAccount
    } else {
      nextDefaultAccount = cfg.providerDefaults[provider]!
    }
  }, opts)

  recordCloudActivity(resolveOptionalDb(opts), {
    agentId: opts?.agentId ?? 'dashboard',
    provider,
    account,
    action: 'oauth_disconnect',
    targetName: account,
    status: 'ok',
  })

  return { provider, account, nextDefaultAccount }
}

/**
 * 0-token probe invoked by `module-wizard.ts` (`testAction: "cloud_storage_probe"`).
 */
export async function probeCloudStorageForWizard(
  opts?: CloudStorageOptions,
): Promise<Array<{ label: string; ok: boolean; detail: string }>> {
  const vaultOps = resolveVaultOps(opts)
  const cfg = readCloudConfigJson(opts)
  const vaultIds = getPresentVaultSecretIds(vaultOps)
  const checks: Array<{ label: string; ok: boolean; detail: string }> = []

  for (const p of CLOUD_PROVIDERS) {
    const adapter = getCloudAdapter(p)
    const hasClient =
      vaultIds.has(cloudVaultKey(p, 'client_id', DEFAULT_CLOUD_ACCOUNT)) &&
      vaultIds.has(cloudVaultKey(p, 'client_secret', DEFAULT_CLOUD_ACCOUNT))
    const keys = discoverAccountKeysForProvider(p, cfg, vaultIds).filter((k) =>
      vaultIds.has(cloudVaultKey(p, 'refresh_token', k)),
    )

    if (keys.length > 0) {
      for (const acc of keys) {
        try {
          const res = await testCloudConnection(p, acc, opts)
          const emailPart = res.quota.accountEmail ? ` (${res.quota.accountEmail})` : ''
          const pctPart = res.quota.usedPct !== null ? ` · kvóta: ${res.quota.usedPct}%` : ''
          checks.push({
            label: `${adapter.displayName} [${acc}]`,
            ok: true,
            detail: `Csatlakoztatva${emailPart}${pctPart}`,
          })
        } catch (err) {
          checks.push({
            label: `${adapter.displayName} [${acc}]`,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } else if (hasClient) {
      checks.push({
        label: adapter.displayName,
        ok: true,
        detail: 'OAuth2 Client ID + Secret elmentve a Vaultban — indítsd el a fiókválasztós összekötést a #vps kártyán!',
      })
    }
  }

  if (checks.length === 0) {
    checks.push({
      label: 'Felhőtárhely OAuth2',
      ok: false,
      detail: 'Egyetlen szolgáltató (Google Drive, OneDrive vagy Dropbox) OAuth2 kliense sincs még beállítva.',
    })
  }

  return checks
}
