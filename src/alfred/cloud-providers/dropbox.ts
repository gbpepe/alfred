import {
  CloudReauthRequiredError,
  CloudStorageError,
  computeQuotaPct,
  DEFAULT_CLOUD_CHUNK_BYTES,
  escapeHttpHeaderJson,
  executeChunkWithRetry,
  isInvalidGrantError,
  readFileInBoundedChunks,
  streamResponseToDiskAtomic,
  type CloudAdapterCallContext,
  type CloudDownloadParams,
  type CloudDownloadResult,
  type CloudItem,
  type CloudListParams,
  type CloudQuotaInfo,
  type CloudShareParams,
  type CloudShareResult,
  type CloudStorageProvider,
  type CloudUploadParams,
} from './types.js'

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize'
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const DROPBOX_RPC_API = 'https://api.dropboxapi.com/2'
const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com/2'

interface DropboxEntryRaw {
  '.tag'?: string
  id?: string
  name?: string
  path_lower?: string
  path_display?: string
  size?: number
  server_modified?: string
  content_hash?: string
}

function mapDropboxEntry(raw: DropboxEntryRaw): CloudItem {
  const isFolder = raw['.tag'] === 'folder'
  return {
    id: String(raw.id || raw.path_display || raw.path_lower || ''),
    name: String(raw.name ?? ''),
    kind: isFolder ? 'folder' : 'file',
    sizeBytes: isFolder ? null : typeof raw.size === 'number' ? raw.size : null,
    modifiedAt: raw.server_modified ?? null,
    pathDisplay: raw.path_display ?? raw.path_lower ?? null,
    checksum: raw.content_hash ?? null,
  }
}

/**
 * Normalizes and confines a Dropbox path strictly inside `rootRef` (e.g. `"/Alfred"`),
 * blocking `..` traversal attempts. Returns `""` for Dropbox root (as required by API v2).
 */
export function normalizeDropboxConfinedPath(rootRef: string | null | undefined, requested?: string | null): string {
  const cleanRoot = (rootRef ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const normalizedRoot = cleanRoot && cleanRoot !== '/' ? (cleanRoot.startsWith('/') ? cleanRoot : `/${cleanRoot}`) : ''

  const rawReq = (requested ?? '').trim().replace(/\\/g, '/')
  if (!rawReq || rawReq === '/' || rawReq === '.') {
    return normalizedRoot
  }
  if (rawReq.startsWith('id:')) {
    return rawReq
  }

  const segments = rawReq.split('/').filter(Boolean)
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new CloudStorageError('CLOUD_PATH_TRAVERSAL', `Érvénytelen Dropbox útvonal ("${requested}"): ".." tiltott.`, {
        statusHttp: 400,
        provider: 'dropbox',
      })
    }
  }

  const joinedReq = `/${segments.join('/')}`
  if (!normalizedRoot) {
    return joinedReq
  }
  const rootLower = normalizedRoot.toLowerCase()
  const reqLower = joinedReq.toLowerCase()
  if (reqLower === rootLower || reqLower.startsWith(`${rootLower}/`)) {
    return joinedReq
  }
  return `${normalizedRoot}${joinedReq}`
}

async function dropboxRpc<T>(
  ctx: CloudAdapterCallContext,
  endpoint: string,
  payload: unknown = null,
): Promise<T> {
  const resp = await ctx.fetchImpl(`${DROPBOX_RPC_API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const text = await resp.text()
  if (!resp.ok) {
    if (isInvalidGrantError(resp.status, text)) {
      throw new CloudReauthRequiredError('dropbox', ctx.account, `HTTP ${resp.status}`)
    }
    if (resp.status === 409 && /not_found/i.test(text)) {
      throw new CloudStorageError('CLOUD_NOT_FOUND', `Dropbox elem nem található: ${text.slice(0, 180)}`, {
        statusHttp: 404,
        provider: 'dropbox',
        account: ctx.account,
      })
    }
    throw new CloudStorageError('CLOUD_API_ERROR', `Dropbox API hiba (HTTP ${resp.status}): ${text.slice(0, 260)}`, {
      statusHttp: resp.status,
      provider: 'dropbox',
      account: ctx.account,
    })
  }
  return (text ? JSON.parse(text) : {}) as T
}

export const dropboxProvider: CloudStorageProvider = {
  id: 'dropbox',
  displayName: 'Dropbox',
  recommendedChunkBytes: DEFAULT_CLOUD_CHUNK_BYTES,
  apiBaseUrl: DROPBOX_RPC_API,
  uploadMode: 'dropbox_upload_session',

  buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, accessMode }) {
    const scope =
      accessMode === 'read_only'
        ? 'files.metadata.read files.content.read account_info.read'
        : 'files.metadata.read files.content.write files.content.read sharing.write account_info.read'
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      token_access_type: 'offline',
      force_reapprove: 'true',
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    })
    return `${DROPBOX_AUTH_URL}?${params.toString()}`
  },

  async exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri, codeVerifier, fetchImpl = fetch }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
    })
    const resp = await fetchImpl(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new CloudStorageError('CLOUD_API_ERROR', `Dropbox OAuth2 token csere sikertelen (HTTP ${resp.status}): ${text.slice(0, 240)}`, {
        statusHttp: resp.status,
        provider: 'dropbox',
      })
    }
    const parsed = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!parsed.access_token || !parsed.refresh_token) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'A Dropbox OAuth2 válasz nem tartalmazott refresh_token-t (token_access_type=offline kötelező).', {
        statusHttp: 502,
        provider: 'dropbox',
      })
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresInSec: Number(parsed.expires_in ?? 14400),
    }
  },

  async refreshAccessToken({ clientId, clientSecret, refreshToken, account, fetchImpl = fetch }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const resp = await fetchImpl(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      if (isInvalidGrantError(resp.status, text)) {
        throw new CloudReauthRequiredError('dropbox', account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `Dropbox token frissítés sikertelen (HTTP ${resp.status}): ${text.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'dropbox',
        account,
      })
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number }
    if (!parsed.access_token) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Hiányzó access_token a Dropbox token frissítési válaszban.', {
        statusHttp: 502,
        provider: 'dropbox',
        account,
      })
    }
    return {
      accessToken: parsed.access_token,
      expiresInSec: Number(parsed.expires_in ?? 14400),
    }
  },

  async getAccountQuota(ctx): Promise<CloudQuotaInfo> {
    const [acct, space] = await Promise.all([
      dropboxRpc<{ email?: string; name?: { display_name?: string } }>(ctx, '/users/get_current_account', null),
      dropboxRpc<{ used?: number; allocation?: { allocated?: number } }>(ctx, '/users/get_space_usage', null),
    ])
    const usedBytes = typeof space.used === 'number' ? space.used : null
    const totalBytes = typeof space.allocation?.allocated === 'number' ? space.allocation.allocated : null
    return {
      accountEmail: acct.email ?? null,
      displayName: acct.name?.display_name ?? null,
      usedBytes,
      totalBytes,
      usedPct: computeQuotaPct(usedBytes, totalBytes),
    }
  },

  async list(ctx, params?: CloudListParams): Promise<CloudItem[]> {
    const path = normalizeDropboxConfinedPath(ctx.rootRef, params?.folderRef)
    const limit = Math.max(1, Math.min(200, Math.floor(params?.limit ?? 50)))

    let items: CloudItem[]
    if (params?.query && params.query.trim()) {
      const data = await dropboxRpc<{
        matches?: Array<{ metadata?: { metadata?: DropboxEntryRaw } }>
      }>(ctx, '/files/search_v2', {
        query: params.query.trim(),
        options: {
          ...(path ? { path } : {}),
          max_results: limit,
        },
      })
      items = (data.matches ?? [])
        .map((m) => m.metadata?.metadata)
        .filter((e): e is DropboxEntryRaw => Boolean(e))
        .map(mapDropboxEntry)
    } else {
      const data = await dropboxRpc<{ entries?: DropboxEntryRaw[] }>(ctx, '/files/list_folder', {
        path,
        limit,
      })
      items = (data.entries ?? []).map(mapDropboxEntry)
    }

    if (params?.kind === 'folder') {
      items = items.filter((i) => i.kind === 'folder')
    } else if (params?.kind === 'file') {
      items = items.filter((i) => i.kind === 'file')
    }
    return items.slice(0, limit)
  },

  async mkdir(ctx, name, parentRef): Promise<CloudItem> {
    const cleanName = name.trim().replace(/^\/+|\/+$/g, '')
    if (!cleanName) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'A mappa neve nem lehet üres.', { provider: 'dropbox' })
    }
    const parentPath = normalizeDropboxConfinedPath(ctx.rootRef, parentRef)
    const targetPath = normalizeDropboxConfinedPath(ctx.rootRef, parentPath ? `${parentPath}/${cleanName}` : `/${cleanName}`)

    const resp = await ctx.fetchImpl(`${DROPBOX_RPC_API}/files/create_folder_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: targetPath, autorename: false }),
    })
    const text = await resp.text()
    if (resp.status === 409 && /conflict\/folder/i.test(text)) {
      const existing = await dropboxRpc<DropboxEntryRaw>(ctx, '/files/get_metadata', { path: targetPath })
      return mapDropboxEntry(existing)
    }
    if (!resp.ok) {
      if (isInvalidGrantError(resp.status, text)) {
        throw new CloudReauthRequiredError('dropbox', ctx.account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `Dropbox mappa létrehozási hiba (HTTP ${resp.status}): ${text.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'dropbox',
        account: ctx.account,
      })
    }
    const parsed = JSON.parse(text) as { metadata?: DropboxEntryRaw }
    return mapDropboxEntry(parsed.metadata ?? { '.tag': 'folder', name: cleanName, path_display: targetPath })
  },

  async uploadStream(ctx, params: CloudUploadParams): Promise<CloudItem> {
    const parentPath = normalizeDropboxConfinedPath(ctx.rootRef, params.parentRef)
    const targetPath = normalizeDropboxConfinedPath(
      ctx.rootRef,
      parentPath ? `${parentPath}/${params.remoteName}` : `/${params.remoteName}`,
    )

    const commitMode = params.onConflict === 'update_in_place' || !params.onConflict ? 'overwrite' : 'add'
    const autorename = params.onConflict === 'autorename'

    // Start upload session
    const startResp = await executeChunkWithRetry(
      () =>
        ctx.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload_session/start`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ctx.accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': escapeHttpHeaderJson({ close: false }),
          },
          body: new Uint8Array(0),
        }),
      { retryDelaysMs: ctx.retryDelaysMs },
    )
    const startText = await startResp.text()
    if (!startResp.ok) {
      if (isInvalidGrantError(startResp.status, startText)) {
        throw new CloudReauthRequiredError('dropbox', ctx.account, `HTTP ${startResp.status}`)
      }
      throw new CloudStorageError(
        'CLOUD_API_ERROR',
        `Dropbox upload_session/start sikertelen (HTTP ${startResp.status}): ${startText.slice(0, 220)}`,
        { statusHttp: startResp.status, provider: 'dropbox', account: ctx.account },
      )
    }
    const { session_id: sessionId } = JSON.parse(startText) as { session_id?: string }
    if (!sessionId) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Hiányzó session_id a Dropbox upload_session/start válaszból.', {
        statusHttp: 502,
        provider: 'dropbox',
        account: ctx.account,
      })
    }

    const chunkBytes = params.chunkBytes ?? DEFAULT_CLOUD_CHUNK_BYTES
    let uploadedOffset = 0

    for await (const slice of readFileInBoundedChunks(params.localFilePath, params.fileSizeBytes, chunkBytes)) {
      const appendResp = await executeChunkWithRetry(
        () =>
          ctx.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload_session/append_v2`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.accessToken}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': escapeHttpHeaderJson({
                cursor: { session_id: sessionId, offset: slice.start },
                close: false,
              }),
            },
            body: new Uint8Array(slice.buffer),
          }),
        { retryDelaysMs: ctx.retryDelaysMs },
      )
      if (!appendResp.ok) {
        const errText = await appendResp.text().catch(() => '')
        throw new CloudStorageError(
          'CLOUD_API_ERROR',
          `Dropbox upload_session/append_v2 sikertelen (HTTP ${appendResp.status}): ${errText.slice(0, 220)}`,
          { statusHttp: appendResp.status, provider: 'dropbox', account: ctx.account },
        )
      }
      await appendResp.body?.cancel().catch(() => {})
      uploadedOffset = slice.end + 1
    }

    const finishResp = await executeChunkWithRetry(
      () =>
        ctx.fetchImpl(`${DROPBOX_CONTENT_API}/files/upload_session/finish`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ctx.accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': escapeHttpHeaderJson({
              cursor: { session_id: sessionId, offset: uploadedOffset },
              commit: {
                path: targetPath,
                mode: commitMode,
                autorename,
                mute: true,
              },
            }),
          },
          body: new Uint8Array(0),
        }),
      { retryDelaysMs: ctx.retryDelaysMs },
    )
    const finishText = await finishResp.text()
    if (finishResp.status === 409 && /conflict/i.test(finishText)) {
      throw new CloudStorageError(
        'CLOUD_CONFLICT_EXISTS',
        `A(z) "${params.remoteName}" fájl már létezik Dropboxon (on_conflict=fail).`,
        { statusHttp: 409, provider: 'dropbox', account: ctx.account },
      )
    }
    if (!finishResp.ok) {
      throw new CloudStorageError(
        'CLOUD_API_ERROR',
        `Dropbox upload_session/finish sikertelen (HTTP ${finishResp.status}): ${finishText.slice(0, 220)}`,
        { statusHttp: finishResp.status, provider: 'dropbox', account: ctx.account },
      )
    }
    const mapped = mapDropboxEntry(JSON.parse(finishText) as DropboxEntryRaw)
    if (mapped.sizeBytes !== null && mapped.sizeBytes !== params.fileSizeBytes) {
      throw new CloudStorageError(
        'CLOUD_INTEGRITY_MISMATCH',
        `Feltöltési méreteltérés Dropboxon: helyi ${params.fileSizeBytes} B, távoli ${mapped.sizeBytes} B.`,
        { statusHttp: 502, provider: 'dropbox', account: ctx.account },
      )
    }
    return mapped
  },

  async downloadStream(ctx, params: CloudDownloadParams): Promise<CloudDownloadResult> {
    const targetRef = normalizeDropboxConfinedPath(ctx.rootRef, params.fileRef)
    const resp = await ctx.fetchImpl(`${DROPBOX_CONTENT_API}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Dropbox-API-Arg': escapeHttpHeaderJson({ path: targetRef }),
      },
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      if (isInvalidGrantError(resp.status, errText)) {
        throw new CloudReauthRequiredError('dropbox', ctx.account, `HTTP ${resp.status}`)
      }
      if (resp.status === 409 && /not_found/i.test(errText)) {
        throw new CloudStorageError('CLOUD_NOT_FOUND', `Dropbox fájl nem található: "${params.fileRef}"`, {
          statusHttp: 404,
          provider: 'dropbox',
          account: ctx.account,
        })
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `Dropbox letöltés sikertelen (HTTP ${resp.status}): ${errText.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'dropbox',
        account: ctx.account,
      })
    }

    const resultHeader = resp.headers.get('dropbox-api-result')
    const rawMeta = resultHeader ? (JSON.parse(resultHeader) as DropboxEntryRaw) : { '.tag': 'file', path_display: targetRef }
    const item = mapDropboxEntry(rawMeta)

    const bytesWritten = await streamResponseToDiskAtomic({
      resp,
      destFilePath: params.destFilePath,
      maxDownloadBytes: params.maxDownloadBytes,
      expectedSizeBytes: item.sizeBytes,
      skipDiskSpaceCheck: ctx.skipDiskSpaceCheck,
    })

    return {
      item,
      bytesWritten,
      savedPath: params.destFilePath,
    }
  },

  async share(ctx, params: CloudShareParams): Promise<CloudShareResult> {
    const targetRef = normalizeDropboxConfinedPath(ctx.rootRef, params.fileRef)

    if (params.publicLink) {
      const expires =
        typeof params.expiresInDays === 'number' && params.expiresInDays > 0
          ? new Date(Date.now() + params.expiresInDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
          : undefined
      const resp = await ctx.fetchImpl(`${DROPBOX_RPC_API}/sharing/create_shared_link_with_settings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: targetRef,
          settings: {
            requested_visibility: 'public',
            ...(expires ? { expires } : {}),
          },
        }),
      })
      const text = await resp.text()
      if (resp.status === 409 && /shared_link_already_exists/i.test(text)) {
        const listData = await dropboxRpc<{ links?: Array<{ url?: string }> }>(ctx, '/sharing/list_shared_links', {
          path: targetRef,
          direct_only: true,
        })
        const existingUrl = listData.links?.[0]?.url ?? ''
        return {
          provider: 'dropbox',
          account: ctx.account,
          itemId: targetRef,
          webUrl: existingUrl,
          mode: 'public_link',
          sharedWith: 'anyone',
          role: params.role,
          notified: false,
          expiresAt: expires ?? null,
        }
      }
      if (!resp.ok) {
        if (isInvalidGrantError(resp.status, text)) {
          throw new CloudReauthRequiredError('dropbox', ctx.account, `HTTP ${resp.status}`)
        }
        throw new CloudStorageError(
          'CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER',
          `A Dropbox fiók/csomag nem engedélyezte a nyilvános linket (HTTP ${resp.status}): ${text.slice(0, 220)}`,
          { statusHttp: resp.status, provider: 'dropbox', account: ctx.account },
        )
      }
      const created = JSON.parse(text) as { url?: string }
      return {
        provider: 'dropbox',
        account: ctx.account,
        itemId: targetRef,
        webUrl: created.url ?? '',
        mode: 'public_link',
        sharedWith: 'anyone',
        role: params.role,
        notified: false,
        expiresAt: expires ?? null,
      }
    }

    const addResp = await ctx.fetchImpl(`${DROPBOX_RPC_API}/sharing/add_file_member`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: targetRef,
        members: [{ '.tag': 'email', email: params.email }],
        access_level: params.role === 'writer' ? 'editor' : 'viewer',
        quiet: !params.notify,
      }),
    })
    const addText = await addResp.text()
    if (!addResp.ok) {
      if (isInvalidGrantError(addResp.status, addText)) {
        throw new CloudReauthRequiredError('dropbox', ctx.account, `HTTP ${addResp.status}`)
      }
      throw new CloudStorageError(
        'CLOUD_SHARE_PROVIDER_ERROR',
        `Dropbox e-mailes megosztás sikertelen (HTTP ${addResp.status}): ${addText.slice(0, 220)}`,
        { statusHttp: addResp.status, provider: 'dropbox', account: ctx.account },
      )
    }

    // Fetch account-bound preview_url (never creates a public link)
    let webUrl = ''
    try {
      const meta = await dropboxRpc<{ preview_url?: string }>(ctx, '/sharing/get_file_metadata', {
        file: targetRef,
      })
      webUrl = meta.preview_url ?? ''
    } catch {
      webUrl = ''
    }

    return {
      provider: 'dropbox',
      account: ctx.account,
      itemId: targetRef,
      webUrl,
      mode: 'email',
      sharedWith: String(params.email ?? ''),
      role: params.role,
      notified: params.notify,
    }
  },
}
