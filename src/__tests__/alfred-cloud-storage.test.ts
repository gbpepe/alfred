import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlfredAgentDefinition } from '../alfred/agents-config.js'
import { buildSanitizedCliEnv, sanitizeCliText } from '../alfred/cli-runner.js'
import {
  assertSafeCloudUploadPath,
  clearCloudStorageInMemoryCaches,
  cloudDownload,
  cloudList,
  cloudMkdir,
  cloudShare,
  cloudUpload,
  cloudVaultKey,
  completeCloudOAuthFlow,
  disconnectCloudAccount,
  extractCodeAndStateFromInput,
  getCloudAdminStatus,
  listRecentCloudActivity,
  mintShortLivedCloudToken,
  probeCloudStorageForWizard,
  saveCloudAdminConfig,
  startCloudOAuthFlow,
  type CloudStorageOptions,
  type CloudVaultOps,
} from '../alfred/cloud-storage.js'
import { runHousekeeping } from '../alfred/housekeeper.js'
import { invalidateModuleManifestCache, listModules } from '../alfred/module-manager.js'
import { getModuleWizardState } from '../alfred/module-wizard.js'
import { executeWhitelistedToolAsync } from '../alfred/tool-executor.js'
import { tryHandleAlfredVps } from '../web/routes/alfred-vps.js'
import type { RouteContext } from '../web/routes/types.js'
import { isAgentReadableDecodedVaultId } from '../web/vault-acl.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_modules (
      module_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
      installed_at TEXT,
      updated_at TEXT,
      config_json TEXT
    );
  `)
  return db
}

function createInMemoryVault(): {
  store: Map<string, { label: string; value: string }>
  ops: CloudVaultOps
  getSecretSpy: ReturnType<typeof vi.fn>
} {
  const store = new Map<string, { label: string; value: string }>()
  const getSecretSpy = vi.fn((id: string) => store.get(id)?.value ?? null)
  const ops: CloudVaultOps = {
    listSecrets: () => Array.from(store.entries()).map(([id, v]) => ({ id, label: v.label })),
    setSecret: (id: string, label: string, value: string) => {
      store.set(id, { label, value })
    },
    getSecret: getSecretSpy,
    deleteSecret: (id: string) => store.delete(id),
  }
  return { store, ops, getSecretSpy }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function createFakeAgent(wsDir: string): AlfredAgentDefinition {
  return {
    id: 'alfred-test',
    displayName: 'Test Agent',
    enabled: true,
    channelName: 'test',
    discordChannelId: '123456789012345678',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    workspace: 'workspaces/main',
    workspaceAbsPath: wsDir,
    memoryNamespace: 'test',
    dailyBudgetUsd: 5,
    allowedUserIds: [],
    tools: ['cloud_list', 'cloud_mkdir', 'cloud_upload', 'cloud_download', 'cloud_share'],
    protectedPaths: [],
    resolvedSystemPrompt: '',
  }
}

function createMockReqRes(opts: {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  auth?: RouteContext['auth']
}): { ctx: RouteContext; getResult: () => { status: number; body: Record<string, unknown> } } {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter
  emitter.method = opts.method
  emitter.url = opts.path
  emitter.headers = opts.headers ?? {}

  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : ''
  setImmediate(() => {
    if (bodyStr) emitter.emit('data', Buffer.from(bodyStr, 'utf-8'))
    emitter.emit('end')
  })

  let statusCode = 200
  let rawBody = ''
  const res = {
    writeHead(code: number) {
      statusCode = code
      return this
    },
    end(chunk?: string | Buffer) {
      if (chunk) rawBody += chunk.toString()
      return this
    },
    setHeader() {
      return this
    },
  } as unknown as ServerResponse

  const url = new URL(`http://127.0.0.1:3420${opts.path}`)
  const ctx: RouteContext = {
    req: emitter,
    res,
    url,
    path: url.pathname,
    method: opts.method,
    auth: opts.auth,
  }

  return {
    ctx,
    getResult: () => ({
      status: statusCode,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    }),
  }
}

describe('Cloud Storage Module (feat/cloud-storage)', () => {
  let tmpRoot: string
  let wsDir: string
  let db: Database.Database

  beforeEach(() => {
    clearCloudStorageInMemoryCaches()
    invalidateModuleManifestCache()
    tmpRoot = mkdtempSync(join(tmpdir(), 'alfred-cloud-test-'))
    wsDir = join(tmpRoot, 'workspaces', 'main')
    mkdirSync(wsDir, { recursive: true })
    mkdirSync(join(tmpRoot, 'store'), { recursive: true })
    db = createTestDb()
  })

  afterEach(() => {
    clearCloudStorageInMemoryCaches()
    try {
      db.close()
    } catch {
      // ignore
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // 1. Module manifest, setupWizard, probe & MODULE_DISABLED_ERROR
  // ---------------------------------------------------------------------------
  describe('1. Module manifest, setupWizard & disabled gate', () => {
    it('discovers cloud-storage manifest with defaultEnabled=false, ramImpactMb=15, 5 tools and setupWizard', () => {
      const mods = listModules({ db })
      const mod = mods.find((m) => m.id === 'cloud-storage')
      expect(mod).toBeTruthy()
      expect(mod?.defaultEnabled).toBe(false)
      expect(mod?.ramImpactMb).toBe(15)
      expect(mod?.state).not.toBe('active')
      expect(mod?.uiCardIds).toContain('vpsCloudStorageCard')
      expect(mod?.tools).toEqual([
        'cloud_list',
        'cloud_mkdir',
        'cloud_upload',
        'cloud_download',
        'cloud_share',
      ])

      const wiz = getModuleWizardState('cloud-storage', { db })
      expect(wiz.steps.map((s) => s.id)).toEqual(['oauth_clients', 'defaults_and_limits', 'verify'])
      expect(wiz.testAction).toBe('cloud_storage_probe')
    })

    it('blocks cloud_list tool execution with MODULE_DISABLED_ERROR when cloud-storage is inactive', async () => {
      const fakeAgent = createFakeAgent(wsDir)
      const raw = await executeWhitelistedToolAsync({ agent: fakeAgent, db }, 'cloud_list', {})
      const parsed = JSON.parse(raw) as { ok?: boolean; code?: string; moduleId?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.code).toBe('MODULE_DISABLED_ERROR')
      expect(parsed.moduleId).toBe('cloud-storage')
    })

    it('runs cloud_storage_probe cleanly when no accounts are connected', async () => {
      const { ops } = createInMemoryVault()
      const checks = await probeCloudStorageForWizard({
        db,
        projectRoot: tmpRoot,
        vaultOps: ops,
        env: {},
      })
      expect(Array.isArray(checks)).toBe(true)
      expect(checks.length).toBeGreaterThanOrEqual(1)
      expect(checks.some((c) => c.ok === false)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Multi-Account OAuth2 + PKCE S256 + Single-Use state + OneDrive rotation
  // ---------------------------------------------------------------------------
  describe('2. Multi-Account OAuth2 + PKCE S256 & token rotation', () => {
    it('builds provider-specific PKCE S256 URLs with least-privilege read_only scopes', () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_gd')
      ops.setSecret('cloud_onedrive_client_id', 'od id', 'cid_od')
      ops.setSecret('cloud_onedrive_client_secret', 'od sec', 'csec_od')
      ops.setSecret('cloud_dropbox_client_id', 'dbx id', 'cid_dbx')
      ops.setSecret('cloud_dropbox_client_secret', 'dbx sec', 'csec_dbx')

      const opts: CloudStorageOptions = { db, projectRoot: tmpRoot, vaultOps: ops, env: {} }

      const gdRw = startCloudOAuthFlow(
        { provider: 'gdrive', redirectUri: 'https://test.example/oauth-cloud-callback.html', accessMode: 'read_write' },
        opts,
      )
      const gdRo = startCloudOAuthFlow(
        {
          provider: 'gdrive',
          account: 'archive',
          redirectUri: 'https://test.example/oauth-cloud-callback.html',
          accessMode: 'read_only',
        },
        opts,
      )
      const odRo = startCloudOAuthFlow(
        { provider: 'onedrive', redirectUri: 'https://test.example/oauth-cloud-callback.html', accessMode: 'read_only' },
        opts,
      )
      const dbxRo = startCloudOAuthFlow(
        { provider: 'dropbox', redirectUri: 'https://test.example/oauth-cloud-callback.html', accessMode: 'read_only' },
        opts,
      )

      const gdRwUrl = new URL(gdRw.authUrl)
      expect(gdRwUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(gdRwUrl.searchParams.get('prompt')).toBe('select_account consent')
      expect(gdRwUrl.searchParams.get('access_type')).toBe('offline')
      expect(gdRwUrl.searchParams.get('scope')).toContain('auth/drive')

      const gdRoUrl = new URL(gdRo.authUrl)
      expect(gdRoUrl.searchParams.get('scope')).toContain('auth/drive.readonly')
      expect(gdRoUrl.searchParams.get('scope')).not.toContain('auth/drive ')

      const odRoUrl = new URL(odRo.authUrl)
      expect(odRoUrl.searchParams.get('prompt')).toBe('select_account')
      expect(odRoUrl.searchParams.get('scope')).toContain('Files.Read')
      expect(odRoUrl.searchParams.get('scope')).not.toContain('Files.ReadWrite')

      const dbxRoUrl = new URL(dbxRo.authUrl)
      expect(dbxRoUrl.searchParams.get('token_access_type')).toBe('offline')
      expect(dbxRoUrl.searchParams.get('force_reapprove')).toBe('true')
      expect(dbxRoUrl.searchParams.get('scope')).toContain('files.content.read')
      expect(dbxRoUrl.searchParams.get('scope')).not.toContain('files.content.write')
    })

    it('completes OAuth2 from pasted callbackUrl, auto-derives alias, rejects state replay, and persists OneDrive rotated refresh_token', async () => {
      const { ops, store } = createInMemoryVault()
      ops.setSecret('cloud_onedrive_client_id', 'od id', 'cid_od')
      ops.setSecret('cloud_onedrive_client_secret', 'od sec', 'csec_od')
      // Pre-connect default so createNew=true auto-derives an alias ('work-team') from email
      ops.setSecret('cloud_onedrive_refresh_token', 'od default rt', 'ref_od_default_existing')

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2/v2.0/token')) {
          return jsonResponse({
            access_token: 'acc_od_1',
            refresh_token: 'ref_od_initial',
            expires_in: 3600,
          })
        }
        if (url.includes('/v1.0/me/drive')) {
          return jsonResponse({
            id: 'drv_1',
            quota: { used: 1024, total: 10240 },
          })
        }
        if (url.includes('/v1.0/me?')) {
          return jsonResponse({
            mail: 'work.team@example.com',
            displayName: 'Work Team',
          })
        }
        return jsonResponse({ error: 'unexpected url ' + url }, 404)
      })

      const opts: CloudStorageOptions = {
        db,
        projectRoot: tmpRoot,
        vaultOps: ops,
        env: {},
        fetchImpl: fetchMock as unknown as typeof fetch,
      }

      const start = startCloudOAuthFlow(
        {
          provider: 'onedrive',
          createNew: true,
          redirectUri: 'https://test.example/oauth-cloud-callback.html',
          accessMode: 'read_write',
        },
        opts,
      )

      const pasted = `https://test.example/oauth-cloud-callback.html?code=auth_code_99&state=${encodeURIComponent(start.state)}`
      const extracted = extractCodeAndStateFromInput({ callbackUrl: pasted })
      expect(extracted.code).toBe('auth_code_99')
      expect(extracted.state).toBe(start.state)

      const completed = await completeCloudOAuthFlow(
        { provider: 'onedrive', callbackUrl: pasted },
        opts,
      )
      expect(completed.account).toBe('work-team')
      expect(completed.accountEmail).toBe('work.team@example.com')
      expect(store.get(cloudVaultKey('onedrive', 'refresh_token', 'work-team'))?.value).toBe('ref_od_initial')

      // Single-use state replay MUST fail
      await expect(
        completeCloudOAuthFlow({ provider: 'onedrive', callbackUrl: pasted }, opts),
      ).rejects.toThrow(/state|lejárt|érvénytelen/i)

      // Clear access token cache and simulate rotated refresh_token on next API call
      clearCloudStorageInMemoryCaches()
      const rotatedFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2/v2.0/token')) {
          return jsonResponse({
            access_token: 'acc_od_2',
            refresh_token: 'ref_od_rotated_2',
            expires_in: 3600,
          })
        }
        if (url.includes('/me/drive/root/children')) {
          return jsonResponse({ value: [] })
        }
        return jsonResponse({}, 404)
      })

      await cloudList(
        { provider: 'onedrive', account: 'work-team' },
        { ...opts, fetchImpl: rotatedFetch as unknown as typeof fetch },
      )
      expect(store.get(cloudVaultKey('onedrive', 'refresh_token', 'work-team'))?.value).toBe('ref_od_rotated_2')
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Multi-Account targeting, read_only, readOnlyPrefixes, needs_reauth fail-closed
  // ---------------------------------------------------------------------------
  describe('3. Multi-Account targeting, read-only guards & needs_reauth fail-closed', () => {
    it('targets accounts by alias or email, rejects unknown account, blocks read_only & readOnlyPrefixes, and fails closed on default needs_reauth', async () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_gd')
      ops.setSecret(cloudVaultKey('gdrive', 'refresh_token', 'default'), 'rt def', 'ref_gd_def')
      ops.setSecret(cloudVaultKey('gdrive', 'account_email', 'default'), 'em def', 'personal@ex.com')
      ops.setSecret(cloudVaultKey('gdrive', 'refresh_token', 'work'), 'rt work', 'ref_gd_work')
      ops.setSecret(cloudVaultKey('gdrive', 'account_email', 'work'), 'em work', 'work@ex.com')
      ops.setSecret(cloudVaultKey('gdrive', 'refresh_token', 'archive'), 'rt arch', 'ref_gd_arch')
      ops.setSecret(cloudVaultKey('gdrive', 'account_email', 'archive'), 'em arch', 'archive@ex.com')

      const baseOpts: CloudStorageOptions = { db, projectRoot: tmpRoot, vaultOps: ops, env: {} }

      saveCloudAdminConfig(
        {
          defaultProvider: 'gdrive',
          provider: 'gdrive',
          account: 'default',
          defaultAccount: 'default',
          readOnlyPrefixes: ['Archive/'],
        },
        baseOpts,
      )
      saveCloudAdminConfig(
        { provider: 'gdrive', account: 'work', accessMode: 'read_write' },
        baseOpts,
      )
      saveCloudAdminConfig(
        { provider: 'gdrive', account: 'archive', accessMode: 'read_only' },
        baseOpts,
      )

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const body = typeof init?.body === 'string' ? init.body : ''
        if (url.includes('oauth2.googleapis.com/token')) {
          if (body.includes('ref_gd_def')) {
            return jsonResponse({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, 400)
          }
          return jsonResponse({ access_token: 'acc_gd_ok', expires_in: 3600 })
        }
        if (url.includes('/drive/v3/files')) {
          return jsonResponse({ files: [{ id: 'f1', name: 'doc.txt', mimeType: 'text/plain', size: '5' }] })
        }
        return jsonResponse({}, 404)
      })
      const opts: CloudStorageOptions = { ...baseOpts, fetchImpl: fetchMock as unknown as typeof fetch }

      // Unknown explicit account -> CLOUD_ACCOUNT_NOT_FOUND
      await expect(cloudList({ provider: 'gdrive', account: 'nonexistent' }, opts)).rejects.toMatchObject({
        code: 'CLOUD_ACCOUNT_NOT_FOUND',
      })

      // Target by email -> resolves to 'work'
      const workRes = await cloudList({ provider: 'gdrive', account: 'work@ex.com' }, opts)
      expect(workRes.account).toBe('work')
      expect(workRes.items).toHaveLength(1)

      // read_only account blocks cloudMkdir with CLOUD_ACCOUNT_READONLY
      await expect(
        cloudMkdir({ provider: 'gdrive', account: 'archive', pathOrName: 'NewDir' }, opts),
      ).rejects.toMatchObject({ code: 'CLOUD_ACCOUNT_READONLY' })

      // readOnlyPrefixes blocks writes under Archive/ on default account
      await expect(
        cloudMkdir({ provider: 'gdrive', account: 'default', parentRef: 'Archive/2026', pathOrName: 'Sub' }, opts),
      ).rejects.toMatchObject({ code: 'CLOUD_READONLY_TARGET' })

      // Default account hits invalid_grant -> marks needsReauth and fails closed (never falls back to 'work'!)
      await expect(cloudList({ provider: 'gdrive' }, opts)).rejects.toMatchObject({
        code: 'CLOUD_NEEDS_REAUTH',
      })

      // Subsequent default call fails closed immediately with healthyAlternateAccounts: ['work', 'archive']
      try {
        await cloudList({ provider: 'gdrive' }, opts)
        expect.unreachable('should have thrown CLOUD_NEEDS_REAUTH')
      } catch (err: unknown) {
        const e = err as { code?: string; details?: { healthyAlternateAccounts?: string[] } }
        expect(e.code).toBe('CLOUD_NEEDS_REAUTH')
        expect(e.details?.healthyAlternateAccounts).toEqual(expect.arrayContaining(['work', 'archive']))
      }

      // Explicit healthy account 'work' STILL works!
      const stillOk = await cloudList({ provider: 'gdrive', account: 'work' }, opts)
      expect(stillOk.account).toBe('work')
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Relative Path Resolution, cloud_list search, update_in_place, Docs /export
  // ---------------------------------------------------------------------------
  describe('4. Path resolution, server-side search, update_in_place & Google Docs export', () => {
    it('resolves relative path, rejects .. traversal, filters server-side, PATCHes in-place, and exports Google Docs to PDF', async () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_gd')
      ops.setSecret('cloud_gdrive_refresh_token', 'gd rt', 'ref_gd_1')

      const fakeAgent = createFakeAgent(wsDir)
      const calls: Array<{ method: string; url: string }> = []
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const decodedUrl = decodeURIComponent(url)
        const method = init?.method ?? 'GET'
        calls.push({ method, url: decodedUrl })

        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('/upload/drive/v3/files/file_existing_1') && method === 'PATCH') {
          return new Response('', {
            status: 200,
            headers: { Location: 'https://upload.example/session_patch_1' },
          })
        }
        if (url === 'https://upload.example/session_patch_1' && method === 'PUT') {
          return jsonResponse({
            id: 'file_existing_1',
            name: 'existing.txt',
            mimeType: 'text/plain',
            size: '11',
            webViewLink: 'https://drive.google.com/file/d/file_existing_1/view',
          })
        }
        if (decodedUrl.includes('/drive/v3/files?') && decodedUrl.includes("'root'")) {
          return jsonResponse({
            files: [{ id: 'dir_brand_123', name: 'Alfred-Brand-Kit', mimeType: 'application/vnd.google-apps.folder' }],
          })
        }
        if (decodedUrl.includes('/drive/v3/files?') && decodedUrl.includes('dir_brand_123')) {
          return jsonResponse({
            files: [{ id: 'dir_sub_456', name: 'SubAssets', mimeType: 'application/vnd.google-apps.folder' }],
          })
        }
        if (decodedUrl.includes('/drive/v3/files?') && decodedUrl.includes('existing.txt')) {
          return jsonResponse({
            files: [
              {
                id: 'file_existing_1',
                name: 'existing.txt',
                mimeType: 'text/plain',
                webViewLink: 'https://drive.google.com/file/d/file_existing_1/view',
              },
            ],
          })
        }
        if (decodedUrl.includes('/drive/v3/files?')) {
          return jsonResponse({
            files: [{ id: 'f_search', name: 'brand-guide.pdf', mimeType: 'application/pdf', size: '123' }],
          })
        }
        if (url.includes('/drive/v3/files/gdoc_123?')) {
          return jsonResponse({
            id: 'gdoc_123',
            name: 'Project Brief',
            mimeType: 'application/vnd.google-apps.document',
          })
        }
        if (url.includes('/drive/v3/files/gdoc_123/export')) {
          return new Response(Buffer.from('%PDF-1.4 fake pdf'), {
            status: 200,
            headers: { 'Content-Type': 'application/pdf' },
          })
        }
        return jsonResponse({}, 404)
      })

      const opts: CloudStorageOptions = {
        db,
        projectRoot: tmpRoot,
        vaultOps: ops,
        env: {},
        fetchImpl: fetchMock as unknown as typeof fetch,
        skipDiskSpaceCheck: true,
      }

      // Path traversal blocked
      await expect(cloudList({ provider: 'gdrive', folderRef: '../etc' }, opts)).rejects.toMatchObject({
        code: 'CLOUD_PATH_TRAVERSAL',
      })

      // Relative path + server-side search query + kind filter
      const listRes = await cloudList(
        { provider: 'gdrive', folderRef: 'Alfred-Brand-Kit/SubAssets', query: 'brand', kind: 'file', limit: 10 },
        opts,
      )
      expect(listRes.items[0]?.name).toBe('brand-guide.pdf')
      const searchCall = calls.find((c) => c.url.includes('brand') && c.url.includes('dir_sub_456'))
      expect(searchCall).toBeTruthy()

      // update_in_place uses PATCH and preserves fileId & webViewLink
      const localUpload = join(wsDir, 'existing.txt')
      writeFileSync(localUpload, 'hello world', 'utf-8')
      const upRes = await cloudUpload(
        {
          agent: fakeAgent,
          provider: 'gdrive',
          localPath: 'existing.txt',
          remotePathOrName: 'existing.txt',
          parentRef: 'dir_brand',
          onConflict: 'update_in_place',
        },
        opts,
      )
      expect(upRes.item.id).toBe('file_existing_1')
      expect(upRes.item.webUrl).toBe('https://drive.google.com/file/d/file_existing_1/view')
      expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('/upload/drive/v3/files/file_existing_1'))).toBe(
        true,
      )

      // Google Docs auto-export to PDF based on target .pdf extension
      const dlRes = await cloudDownload(
        { agent: fakeAgent, provider: 'gdrive', fileRefOrPath: 'gdoc_123', localDestPath: 'brief.pdf' },
        opts,
      )
      expect(dlRes.result.exportedMimeType).toBe('application/pdf')
      expect(dlRes.result.savedPath.endsWith('.pdf')).toBe(true)
      expect(readFileSync(dlRes.result.savedPath, 'utf-8')).toContain('%PDF-1.4')
    })
  })

  // ---------------------------------------------------------------------------
  // 5. > 16 MB Multi-Chunk Upload (all 3 adapters), retry, 0-byte, download limit, integrity, housekeeper
  // ---------------------------------------------------------------------------
  describe('5. Multi-chunk 8 MB streaming engine, retries, limits & housekeeper', () => {
    it('uploads > 16 MiB in bounded chunks across Google Drive (with chunk #2 503 retry), OneDrive (320 KiB aligned) and Dropbox (Unicode header escape)', async () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_gd')
      ops.setSecret('cloud_gdrive_refresh_token', 'gd rt', 'ref_gd_1')
      ops.setSecret('cloud_onedrive_client_id', 'od id', 'cid_od')
      ops.setSecret('cloud_onedrive_client_secret', 'od sec', 'csec_od')
      ops.setSecret('cloud_onedrive_refresh_token', 'od rt', 'ref_od_1')
      ops.setSecret('cloud_dropbox_client_id', 'dbx id', 'cid_dbx')
      ops.setSecret('cloud_dropbox_client_secret', 'dbx sec', 'csec_dbx')
      ops.setSecret('cloud_dropbox_refresh_token', 'dbx rt', 'ref_dbx_1')

      const fakeAgent = createFakeAgent(wsDir)
      // Create a 16.5 MiB test file
      const totalBytes = 16 * 1024 * 1024 + 512 * 1024
      const bigFile = join(wsDir, 'big-video.bin')
      writeFileSync(bigFile, Buffer.alloc(totalBytes, 0x41))

      // --- Google Drive: 3 chunks (8 MiB + 8 MiB + 512 KiB) + 503 retry on chunk #2 ---
      const gdRanges: string[] = []
      let gdChunk2Attempts = 0
      const gdFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('/upload/drive/v3/files')) {
          return new Response('', { status: 200, headers: { Location: 'https://gd-upload.example/s1' } })
        }
        if (url.includes('/drive/v3/files?')) {
          return jsonResponse({ files: [] })
        }
        if (url === 'https://gd-upload.example/s1') {
          const headers = new Headers(init?.headers)
          const range = headers.get('Content-Range') || ''
          gdRanges.push(range)
          if (range.startsWith('bytes 8388608-') && gdChunk2Attempts === 0) {
            gdChunk2Attempts++
            return new Response('Service Unavailable', { status: 503 })
          }
          if (range.endsWith(`/${totalBytes}`) && range.includes(`-${totalBytes - 1}/`)) {
            return jsonResponse({ id: 'gd_big_1', name: 'big-video.bin', size: String(totalBytes) })
          }
          return new Response('', { status: 308 })
        }
        return jsonResponse({}, 404)
      })

      const gdRes = await cloudUpload(
        { agent: fakeAgent, provider: 'gdrive', localPath: 'big-video.bin', onConflict: 'autorename' },
        {
          db,
          projectRoot: tmpRoot,
          vaultOps: ops,
          env: {},
          fetchImpl: gdFetch as unknown as typeof fetch,
          retryDelaysMs: [1, 1],
          skipDiskSpaceCheck: true,
        },
      )
      expect(gdRes.item.id).toBe('gd_big_1')
      // Chunk 1 once, Chunk 2 retried once (503 -> 308), Chunk 3 once => 4 PUTs, Chunk 1 NOT re-uploaded!
      expect(gdRanges).toEqual([
        `bytes 0-8388607/${totalBytes}`,
        `bytes 8388608-16777215/${totalBytes}`,
        `bytes 8388608-16777215/${totalBytes}`,
        `bytes 16777216-${totalBytes - 1}/${totalBytes}`,
      ])

      // --- OneDrive: 320 KiB-aligned 8,192,000 B chunks ---
      const odChunkSizes: number[] = []
      const odFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('oauth2/v2.0/token')) {
          return jsonResponse({ access_token: 'acc_od_1', expires_in: 3600 })
        }
        if (url.includes('createUploadSession')) {
          return jsonResponse({ uploadUrl: 'https://od-upload.example/s1' })
        }
        if (url === 'https://od-upload.example/s1') {
          const buf = init?.body as Buffer
          odChunkSizes.push(buf.byteLength)
          const headers = new Headers(init?.headers)
          const range = headers.get('Content-Range') || ''
          if (range.includes(`-${totalBytes - 1}/`)) {
            return jsonResponse({ id: 'od_big_1', name: 'big-video.bin', size: totalBytes })
          }
          return jsonResponse({ nextExpectedRanges: [] }, 202)
        }
        return jsonResponse({}, 404)
      })

      const odRes = await cloudUpload(
        { agent: fakeAgent, provider: 'onedrive', localPath: 'big-video.bin', onConflict: 'autorename' },
        {
          db,
          projectRoot: tmpRoot,
          vaultOps: ops,
          env: {},
          fetchImpl: odFetch as unknown as typeof fetch,
          retryDelaysMs: [1],
          skipDiskSpaceCheck: true,
        },
      )
      expect(odRes.item.id).toBe('od_big_1')
      expect(odChunkSizes[0]).toBe(8_192_000)
      expect(odChunkSizes[0]! % 327_680).toBe(0)
      expect(odChunkSizes[1]).toBe(8_192_000)
      expect(odChunkSizes.reduce((a, b) => a + b, 0)).toBe(totalBytes)

      // --- Dropbox: upload_session start/append_v2/finish + ASCII \uXXXX header escape ---
      const dbxCalls: Array<{ url: string; apiArg: string }> = []
      const dbxFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        const apiArg = headers.get('Dropbox-API-Arg') || ''
        if (url.includes('api.dropboxapi.com/oauth2/token')) {
          return jsonResponse({ access_token: 'acc_dbx_1', expires_in: 3600 })
        }
        if (url.includes('upload_session/start')) {
          dbxCalls.push({ url, apiArg })
          return jsonResponse({ session_id: 'dbx_sess_1' })
        }
        if (url.includes('upload_session/append_v2')) {
          dbxCalls.push({ url, apiArg })
          return new Response('', { status: 200 })
        }
        if (url.includes('upload_session/finish')) {
          dbxCalls.push({ url, apiArg })
          return jsonResponse({
            id: 'id:dbx_big_1',
            name: 'árvíztűrő.mp4',
            path_display: '/árvíztűrő.mp4',
            size: totalBytes,
          })
        }
        return jsonResponse({}, 404)
      })

      const dbxRes = await cloudUpload(
        {
          agent: fakeAgent,
          provider: 'dropbox',
          localPath: 'big-video.bin',
          remotePathOrName: 'árvíztűrő.mp4',
          onConflict: 'autorename',
        },
        {
          db,
          projectRoot: tmpRoot,
          vaultOps: ops,
          env: {},
          fetchImpl: dbxFetch as unknown as typeof fetch,
          retryDelaysMs: [1],
          skipDiskSpaceCheck: true,
        },
      )
      expect(dbxRes.item.id).toBe('id:dbx_big_1')
      expect(dbxCalls.map((c) => c.url.split('/').pop())).toEqual([
        'start',
        'append_v2',
        'append_v2',
        'append_v2',
        'finish',
      ])
      const finishArg = dbxCalls.at(-1)!.apiArg
      expect(/^[\x20-\x7e]+$/.test(finishArg)).toBe(true)
      expect(finishArg).toContain('\\u00e1')

      // --- 0-byte upload succeeds cleanly ---
      const emptyFile = join(wsDir, 'empty.txt')
      writeFileSync(emptyFile, '')
      const emptyFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('/upload/drive/v3/files')) {
          return new Response('', { status: 200, headers: { Location: 'https://gd-upload.example/empty1' } })
        }
        if (url === 'https://gd-upload.example/empty1') {
          return jsonResponse({ id: 'gd_empty_1', name: 'empty.txt', size: '0' })
        }
        if (url.includes('/drive/v3/files?')) {
          return jsonResponse({ files: [] })
        }
        return jsonResponse({}, 404)
      })
      const emptyRes = await cloudUpload(
        { agent: fakeAgent, provider: 'gdrive', localPath: 'empty.txt', onConflict: 'autorename' },
        {
          db,
          projectRoot: tmpRoot,
          vaultOps: ops,
          env: {},
          fetchImpl: emptyFetch as unknown as typeof fetch,
          skipDiskSpaceCheck: true,
        },
      )
      expect(emptyRes.item.id).toBe('gd_empty_1')
    })

    it('aborts download exceeding ALFRED_CLOUD_MAX_DOWNLOAD_MB, rejects integrity mismatch, and cleans stale .cloud-part.* in housekeeper', async () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_gd')
      ops.setSecret('cloud_gdrive_refresh_token', 'gd rt', 'ref_gd_1')

      const fakeAgent = createFakeAgent(wsDir)

      // 1. Download limit exceeded (1 MB cap, 1.5 MB stream)
      const limitFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('alt=media')) {
          return new Response(Buffer.alloc(1.5 * 1024 * 1024, 0x42), { status: 200 })
        }
        return jsonResponse({ id: 'f_big', name: 'big.bin', mimeType: 'application/octet-stream', size: '100' })
      })

      await expect(
        cloudDownload(
          { agent: fakeAgent, provider: 'gdrive', fileRefOrPath: 'f_big', localDestPath: 'big.bin' },
          {
            db,
            projectRoot: tmpRoot,
            vaultOps: ops,
            env: { ALFRED_CLOUD_MAX_DOWNLOAD_MB: '1' },
            fetchImpl: limitFetch as unknown as typeof fetch,
            skipDiskSpaceCheck: true,
          },
        ),
      ).rejects.toMatchObject({ code: 'CLOUD_DOWNLOAD_LIMIT_EXCEEDED' })

      expect(existsSync(join(wsDir, 'big.bin'))).toBe(false)

      // 2. Integrity mismatch (metadata says 100 bytes, stream delivers 42 bytes)
      const mismatchFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('alt=media')) {
          return new Response(Buffer.alloc(42, 0x43), { status: 200 })
        }
        return jsonResponse({ id: 'f_bad', name: 'bad.bin', mimeType: 'application/octet-stream', size: '100' })
      })

      await expect(
        cloudDownload(
          { agent: fakeAgent, provider: 'gdrive', fileRefOrPath: 'f_bad', localDestPath: 'bad.bin' },
          {
            db,
            projectRoot: tmpRoot,
            vaultOps: ops,
            env: {},
            fetchImpl: mismatchFetch as unknown as typeof fetch,
            skipDiskSpaceCheck: true,
          },
        ),
      ).rejects.toMatchObject({ code: 'CLOUD_INTEGRITY_MISMATCH' })

      // 3. Housekeeper deletes stale (> 24h) .cloud-part.* files and keeps fresh ones
      const stalePart = join(wsDir, 'aborted.bin.cloud-part.old')
      const freshPart = join(wsDir, 'active.bin.cloud-part.new')
      writeFileSync(stalePart, 'stale')
      writeFileSync(freshPart, 'fresh')
      const oldDate = new Date(Date.now() - 48 * 3600 * 1000)
      utimesSync(stalePart, oldDate, oldDate)

      await runHousekeeping({ projectRoot: tmpRoot, db })
      expect(existsSync(stalePart)).toBe(false)
      expect(existsSync(freshPart)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Share Contract Matrix (email vs publicLink across all 3 providers)
  // ---------------------------------------------------------------------------
  describe('6. Share policy contract (email vs publicLink, 3-tier precedence, fail-closed)', () => {
    it('enforces 3-tier defaultShareEmail, silent email sharing, publicLink gate, provider fail-closed & Dropbox 409 fallback', async () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_gd')
      ops.setSecret('cloud_gdrive_refresh_token', 'gd rt', 'ref_gd_1')
      ops.setSecret('cloud_dropbox_client_id', 'dbx id', 'cid_dbx')
      ops.setSecret('cloud_dropbox_client_secret', 'dbx sec', 'csec_dbx')
      ops.setSecret('cloud_dropbox_refresh_token', 'dbx rt', 'ref_dbx_1')

      const baseOpts: CloudStorageOptions = { db, projectRoot: tmpRoot, vaultOps: ops, env: {} }

      // No email configured anywhere -> CLOUD_SHARE_RECIPIENT_REQUIRED
      await expect(
        cloudShare({ provider: 'gdrive', fileRefOrPath: 'file_12345678' }, baseOpts),
      ).rejects.toMatchObject({ code: 'CLOUD_SHARE_RECIPIENT_REQUIRED' })

      // publicLink=true when allowPublicLinks=false -> CLOUD_PUBLIC_LINK_FORBIDDEN
      await expect(
        cloudShare({ provider: 'gdrive', fileRefOrPath: 'file_12345678', publicLink: true }, baseOpts),
      ).rejects.toMatchObject({ code: 'CLOUD_PUBLIC_LINK_FORBIDDEN' })

      // Configure global share email + per-account override
      saveCloudAdminConfig(
        {
          defaultShareEmail: 'global@example.com',
          allowPublicLinks: false,
          provider: 'gdrive',
          account: 'default',
          accountDefaultShareEmail: 'account@example.com',
        },
        baseOpts,
      )

      const gdPermBodies: Array<{ url: string; body: Record<string, unknown> }> = []
      const gdFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('/permissions')) {
          gdPermBodies.push({ url, body: JSON.parse(String(init?.body || '{}')) })
          return jsonResponse({ id: 'perm_1' })
        }
        if (url.includes('/drive/v3/files/file_12345678')) {
          return jsonResponse({ id: 'file_12345678', webViewLink: 'https://drive.google.com/file/d/file_12345678/view' })
        }
        return jsonResponse({}, 404)
      })

      // Uses account-level defaultShareEmail ('account@example.com') and sendNotificationEmail=false
      const shareRes = await cloudShare(
        { provider: 'gdrive', fileRefOrPath: 'file_12345678' },
        { ...baseOpts, fetchImpl: gdFetch as unknown as typeof fetch },
      )
      expect(shareRes.mode).toBe('email')
      expect(shareRes.sharedWith).toBe('account@example.com')
      expect(gdPermBodies[0]?.url).toContain('sendNotificationEmail=false')
      expect(gdPermBodies[0]?.body.emailAddress).toBe('account@example.com')

      // Provider 403 on email share fails closed with CLOUD_SHARE_PROVIDER_ERROR (never creates public link)
      const gdFailFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) {
          return jsonResponse({ access_token: 'acc_gd_1', expires_in: 3600 })
        }
        if (url.includes('/permissions')) {
          return jsonResponse({ error: { message: 'Forbidden domain policy' } }, 403)
        }
        return jsonResponse({}, 404)
      })
      await expect(
        cloudShare(
          { provider: 'gdrive', fileRefOrPath: 'file_12345678', email: 'ext@blocked.com' },
          { ...baseOpts, fetchImpl: gdFailFetch as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({ code: 'CLOUD_SHARE_PROVIDER_ERROR' })

      // Dropbox publicLink=true when allowPublicLinks=true handles 409 shared_link_already_exists -> list_shared_links
      saveCloudAdminConfig({ allowPublicLinks: true }, baseOpts)
      const dbxFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('api.dropboxapi.com/oauth2/token')) {
          return jsonResponse({ access_token: 'acc_dbx_1', expires_in: 3600 })
        }
        if (url.includes('create_shared_link_with_settings')) {
          return jsonResponse({ error_summary: 'shared_link_already_exists/..' }, 409)
        }
        if (url.includes('list_shared_links')) {
          return jsonResponse({ links: [{ url: 'https://www.dropbox.com/s/existing123/file.mp4?dl=0' }] })
        }
        return jsonResponse({}, 404)
      })
      const dbxPub = await cloudShare(
        { provider: 'dropbox', fileRefOrPath: '/file.mp4', publicLink: true },
        { ...baseOpts, fetchImpl: dbxFetch as unknown as typeof fetch },
      )
      expect(dbxPub.mode).toBe('public_link')
      expect(dbxPub.webUrl).toBe('https://www.dropbox.com/s/existing123/file.mp4?dl=0')
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Worker Token Minting (03 worker-machines ready)
  // ---------------------------------------------------------------------------
  describe('7. mintShortLivedCloudToken (03 worker-machines)', () => {
    it('mints short-lived accessToken + transferHints without leaking refresh_token or client_secret', async () => {
      const { ops } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_client_secret', 'gd sec', 'csec_super_secret')
      ops.setSecret(cloudVaultKey('gdrive', 'refresh_token', 'work'), 'rt work', 'ref_super_secret')
      saveCloudAdminConfig(
        { provider: 'gdrive', account: 'work', rootRef: 'dir_work_root', accessMode: 'read_write' },
        { db, projectRoot: tmpRoot, vaultOps: ops, env: {} },
      )

      const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'short_tok_1', expires_in: 3600 }))
      const minted = await mintShortLivedCloudToken(
        { provider: 'gdrive', account: 'work' },
        { db, projectRoot: tmpRoot, vaultOps: ops, env: {}, fetchImpl: fetchMock as unknown as typeof fetch },
      )

      expect(minted.provider).toBe('gdrive')
      expect(minted.account).toBe('work')
      expect(minted.accessToken).toBe('short_tok_1')
      expect(minted.rootRef).toBe('dir_work_root')
      expect(minted.readOnly).toBe(false)
      expect(minted.recommendedChunkBytes).toBe(8 * 1024 * 1024)
      expect(minted.transferHints.uploadMode).toBe('gdrive_resumable')

      const serialized = JSON.stringify(minted)
      expect(serialized).not.toContain('ref_super_secret')
      expect(serialized).not.toContain('csec_super_secret')
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Security Isolation, 0-decryption status, audit log & Admin API auth
  // ---------------------------------------------------------------------------
  describe('8. Security isolation, 0-decryption status & Admin API', () => {
    it('blocks protected paths in assertSafeCloudUploadPath, strips cloud env from CLI, blocks vault-acl, and redacts tokens', () => {
      const fakeAgent = createFakeAgent(wsDir)
      const forbiddenTargets = [
        join(tmpRoot, '.env'),
        join(tmpRoot, '.env.production'),
        join(tmpRoot, 'store', 'alfred-prod.db'),
        join(tmpRoot, 'store', 'vault.json'),
        join(tmpRoot, 'store', '.dashboard-token'),
        join(wsDir, 'id_ed25519'),
        join(tmpRoot, '.cli-profiles', 'gemini', 'creds.json'),
      ]

      for (const p of forbiddenTargets) {
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, 'dummy')
        expect(() => assertSafeCloudUploadPath(fakeAgent, p, p)).toThrow()
      }

      // buildSanitizedCliEnv strips cloud_* and ALFRED_CLOUD_*
      const sanitized = buildSanitizedCliEnv('gemini-cli', {
        PATH: process.env.PATH,
        cloud_gdrive_refresh_token: 'ref_leak',
        ALFRED_CLOUD_SHARE_EMAIL: 'owner@example.com',
      })
      expect(sanitized.cloud_gdrive_refresh_token).toBeUndefined()
      expect(sanitized.ALFRED_CLOUD_SHARE_EMAIL).toBeUndefined()

      // vault-acl blocks cloud_*
      expect(isAgentReadableDecodedVaultId('cloud_gdrive_refresh_token')).toBe(false)
      expect(isAgentReadableDecodedVaultId('cloud_gdrive__archive_refresh_token')).toBe(false)

      // sanitizeCliText redacts Dropbox & Google refresh token shapes
      const redacted = sanitizeCliText('token=sl.B1234567890abcdefghij1234567890 and 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz12345')
      expect(redacted).not.toContain('sl.B1234567890')
      expect(redacted).not.toContain('1//0gAbCdEfGhIjKlMnOpQrStUvWxYz12345')
    })

    it('reads getCloudAdminStatus with ZERO Vault decryptions, records audit activity, and enforces Admin API auth', async () => {
      const { ops, store, getSecretSpy } = createInMemoryVault()
      ops.setSecret('cloud_gdrive_client_id', 'gd id', 'cid_gd')
      ops.setSecret('cloud_gdrive_refresh_token', 'gd rt', 'ref_gd_secret')

      getSecretSpy.mockClear()
      const status = await getCloudAdminStatus({
        db,
        projectRoot: tmpRoot,
        vaultOps: ops,
        env: {},
      })
      expect(getSecretSpy).not.toHaveBeenCalled()
      expect(status.providers.find((p) => p.id === 'gdrive')?.connectedCount).toBe(1)
      expect(JSON.stringify(status)).not.toContain('ref_gd_secret')

      // Disconnect removes refresh_token and records activity
      const disc = disconnectCloudAccount('gdrive', { account: 'default' }, { db, projectRoot: tmpRoot, vaultOps: ops })
      expect(disc.account).toBe('default')
      expect(store.has('cloud_gdrive_refresh_token')).toBe(false)
      const activity = listRecentCloudActivity(db, 10)
      expect(activity.some((a) => a.action === 'oauth_disconnect' && a.provider === 'gdrive')).toBe(true)

      // Admin API route rejects unauthorized requests
      const unauth = createMockReqRes({
        method: 'GET',
        path: '/api/admin/cloud/status',
        auth: undefined,
      })
      const handled = await tryHandleAlfredVps(unauth.ctx)
      expect(handled).toBe(true)
      expect([401, 403]).toContain(unauth.getResult().status)

      const unauthBrowse = createMockReqRes({
        method: 'GET',
        path: '/api/admin/cloud/gdrive/browse',
        auth: undefined,
      })
      const handledBrowse = await tryHandleAlfredVps(unauthBrowse.ctx)
      expect(handledBrowse).toBe(true)
      expect([401, 403]).toContain(unauthBrowse.getResult().status)
    })
  })
})
