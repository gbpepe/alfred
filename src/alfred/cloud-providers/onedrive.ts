import {
  CloudReauthRequiredError,
  CloudStorageError,
  computeQuotaPct,
  executeChunkWithRetry,
  isInvalidGrantError,
  ONEDRIVE_CHUNK_ALIGNMENT,
  ONEDRIVE_DEFAULT_CHUNK_BYTES,
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

const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GRAPH_API = 'https://graph.microsoft.com/v1.0'

const SAFE_ITEM_ID_RE = /^(?:root|[A-Za-z0-9!._-]{3,160})$/

function assertGraphItemId(raw: string, label: string): string {
  const clean = raw.trim()
  if (!SAFE_ITEM_ID_RE.test(clean)) {
    throw new CloudStorageError('CLOUD_API_ERROR', `Érvénytelen OneDrive ${label} azonosító: "${raw}"`, {
      statusHttp: 400,
      provider: 'onedrive',
    })
  }
  return clean
}

function itemBaseUrl(itemId: string): string {
  return itemId === 'root'
    ? `${GRAPH_API}/me/drive/root`
    : `${GRAPH_API}/me/drive/items/${encodeURIComponent(itemId)}`
}

interface GraphDriveItemRaw {
  id?: string
  name?: string
  size?: number
  folder?: { childCount?: number }
  file?: { mimeType?: string; hashes?: { sha256Hash?: string; quickXorHash?: string } }
  lastModifiedDateTime?: string
  webUrl?: string
  parentReference?: { id?: string; path?: string }
}

function mapGraphItem(raw: GraphDriveItemRaw): CloudItem {
  const isFolder = Boolean(raw.folder)
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    kind: isFolder ? 'folder' : 'file',
    sizeBytes: isFolder ? null : typeof raw.size === 'number' ? raw.size : null,
    mimeType: raw.file?.mimeType ?? (isFolder ? 'folder' : null),
    modifiedAt: raw.lastModifiedDateTime ?? null,
    webUrl: raw.webUrl ?? null,
    parentRef: raw.parentReference?.id ?? null,
    checksum: raw.file?.hashes?.sha256Hash ?? raw.file?.hashes?.quickXorHash ?? null,
  }
}

async function graphJsonFetch<T>(
  ctx: CloudAdapterCallContext,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const resp = await ctx.fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await resp.text()
  if (!resp.ok) {
    if (isInvalidGrantError(resp.status, text)) {
      throw new CloudReauthRequiredError('onedrive', ctx.account, `HTTP ${resp.status}`)
    }
    if (resp.status === 404) {
      throw new CloudStorageError('CLOUD_NOT_FOUND', `OneDrive elem nem található (HTTP 404).`, {
        statusHttp: 404,
        provider: 'onedrive',
        account: ctx.account,
      })
    }
    throw new CloudStorageError('CLOUD_API_ERROR', `OneDrive Graph API hiba (HTTP ${resp.status}): ${text.slice(0, 260)}`, {
      statusHttp: resp.status,
      provider: 'onedrive',
      account: ctx.account,
    })
  }
  return (text ? JSON.parse(text) : {}) as T
}

export const oneDriveProvider: CloudStorageProvider = {
  id: 'onedrive',
  displayName: 'Microsoft OneDrive',
  recommendedChunkBytes: ONEDRIVE_DEFAULT_CHUNK_BYTES,
  apiBaseUrl: GRAPH_API,
  uploadMode: 'onedrive_upload_session',

  buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, accessMode }) {
    const scope =
      accessMode === 'read_only'
        ? 'Files.Read.All User.Read offline_access'
        : 'Files.ReadWrite.All User.Read offline_access'
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      prompt: 'select_account',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    })
    return `${MS_AUTH_URL}?${params.toString()}`
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
    const resp = await fetchImpl(MS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new CloudStorageError('CLOUD_API_ERROR', `Microsoft OAuth2 token csere sikertelen (HTTP ${resp.status}): ${text.slice(0, 240)}`, {
        statusHttp: resp.status,
        provider: 'onedrive',
      })
    }
    const parsed = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!parsed.access_token || !parsed.refresh_token) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'A Microsoft OAuth2 válasz nem tartalmazott refresh_token-t (offline_access kötelező).', {
        statusHttp: 502,
        provider: 'onedrive',
      })
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresInSec: Number(parsed.expires_in ?? 3600),
    }
  },

  async refreshAccessToken({ clientId, clientSecret, refreshToken, account, fetchImpl = fetch }) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const resp = await fetchImpl(MS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      if (isInvalidGrantError(resp.status, text)) {
        throw new CloudReauthRequiredError('onedrive', account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `Microsoft token frissítés sikertelen (HTTP ${resp.status}): ${text.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'onedrive',
        account,
      })
    }
    const parsed = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!parsed.access_token) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Hiányzó access_token a Microsoft token frissítési válaszban.', {
        statusHttp: 502,
        provider: 'onedrive',
        account,
      })
    }
    return {
      accessToken: parsed.access_token,
      ...(parsed.refresh_token ? { rotatedRefreshToken: parsed.refresh_token } : {}),
      expiresInSec: Number(parsed.expires_in ?? 3600),
    }
  },

  async getAccountQuota(ctx): Promise<CloudQuotaInfo> {
    const [me, drive] = await Promise.all([
      graphJsonFetch<{ displayName?: string; mail?: string; userPrincipalName?: string }>(
        ctx,
        `${GRAPH_API}/me?$select=displayName,mail,userPrincipalName`,
      ),
      graphJsonFetch<{ quota?: { used?: number; total?: number } }>(
        ctx,
        `${GRAPH_API}/me/drive?$select=id,driveType,quota`,
      ),
    ])
    const usedBytes = typeof drive.quota?.used === 'number' ? drive.quota.used : null
    const totalBytes = typeof drive.quota?.total === 'number' ? drive.quota.total : null
    return {
      accountEmail: me.mail || me.userPrincipalName || null,
      displayName: me.displayName ?? null,
      usedBytes,
      totalBytes,
      usedPct: computeQuotaPct(usedBytes, totalBytes),
    }
  },

  async list(ctx, params?: CloudListParams): Promise<CloudItem[]> {
    const folderId = assertGraphItemId(params?.folderRef || ctx.rootRef || 'root', 'folderRef')
    const limit = Math.max(1, Math.min(200, Math.floor(params?.limit ?? 50)))
    const select = '$select=id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference'
    const base = itemBaseUrl(folderId)

    let url: string
    if (params?.query && params.query.trim()) {
      const escapedQ = params.query.trim().replace(/'/g, "''")
      url = `${base}/search(q='${encodeURIComponent(escapedQ)}')?$top=${limit}&${select}`
    } else {
      url = `${base}/children?$top=${limit}&${select}`
    }

    const data = await graphJsonFetch<{ value?: GraphDriveItemRaw[] }>(ctx, url)
    let items = (data.value ?? []).map(mapGraphItem)
    if (params?.kind === 'folder') {
      items = items.filter((i) => i.kind === 'folder')
    } else if (params?.kind === 'file') {
      items = items.filter((i) => i.kind === 'file')
    }
    return items.slice(0, limit)
  },

  async mkdir(ctx, name, parentRef): Promise<CloudItem> {
    const parentId = assertGraphItemId(parentRef || ctx.rootRef || 'root', 'parentRef')
    const cleanName = name.trim()
    if (!cleanName) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'A mappa neve nem lehet üres.', { provider: 'onedrive' })
    }

    const children = await this.list(ctx, { folderRef: parentId, kind: 'folder', limit: 200 })
    const existing = children.find((c) => c.name.toLowerCase() === cleanName.toLowerCase())
    if (existing) return existing

    const resp = await ctx.fetchImpl(`${itemBaseUrl(parentId)}/children`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    })

    if (resp.status === 409) {
      const refreshed = await this.list(ctx, { folderRef: parentId, kind: 'folder', limit: 200 })
      const hit = refreshed.find((c) => c.name.toLowerCase() === cleanName.toLowerCase())
      if (hit) return hit
    }
    const text = await resp.text()
    if (!resp.ok) {
      if (isInvalidGrantError(resp.status, text)) {
        throw new CloudReauthRequiredError('onedrive', ctx.account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `OneDrive mappa létrehozási hiba (HTTP ${resp.status}): ${text.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'onedrive',
        account: ctx.account,
      })
    }
    return mapGraphItem(JSON.parse(text) as GraphDriveItemRaw)
  },

  async uploadStream(ctx, params: CloudUploadParams): Promise<CloudItem> {
    const parentId = assertGraphItemId(params.parentRef || ctx.rootRef || 'root', 'parentRef')
    const conflictBehavior =
      params.onConflict === 'fail' ? 'fail' : params.onConflict === 'autorename' ? 'rename' : 'replace'
    const encodedName = encodeURIComponent(params.remoteName)
    const targetPrefix =
      parentId === 'root'
        ? `${GRAPH_API}/me/drive/root:/${encodedName}:`
        : `${GRAPH_API}/me/drive/items/${encodeURIComponent(parentId)}:/${encodedName}:`

    if (params.fileSizeBytes === 0) {
      const zeroResp = await ctx.fetchImpl(`${targetPrefix}/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': params.mimeType,
          'Content-Length': '0',
        },
        body: new Uint8Array(0),
      })
      const zeroText = await zeroResp.text()
      if (zeroResp.status === 409) {
        throw new CloudStorageError('CLOUD_CONFLICT_EXISTS', `A(z) "${params.remoteName}" fájl már létezik OneDrive-on.`, {
          statusHttp: 409,
          provider: 'onedrive',
          account: ctx.account,
        })
      }
      if (!zeroResp.ok) {
        throw new CloudStorageError('CLOUD_API_ERROR', `OneDrive 0-bájtos feltöltés sikertelen (HTTP ${zeroResp.status}): ${zeroText.slice(0, 220)}`, {
          statusHttp: zeroResp.status,
          provider: 'onedrive',
          account: ctx.account,
        })
      }
      return mapGraphItem(JSON.parse(zeroText) as GraphDriveItemRaw)
    }

    const sessionResp = await ctx.fetchImpl(`${targetPrefix}/createUploadSession`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': conflictBehavior,
          name: params.remoteName,
        },
      }),
    })
    const sessionText = await sessionResp.text()
    if (sessionResp.status === 409) {
      throw new CloudStorageError('CLOUD_CONFLICT_EXISTS', `A(z) "${params.remoteName}" fájl már létezik OneDrive-on (on_conflict=fail).`, {
        statusHttp: 409,
        provider: 'onedrive',
        account: ctx.account,
      })
    }
    if (!sessionResp.ok) {
      if (isInvalidGrantError(sessionResp.status, sessionText)) {
        throw new CloudReauthRequiredError('onedrive', ctx.account, `HTTP ${sessionResp.status}`)
      }
      throw new CloudStorageError(
        'CLOUD_API_ERROR',
        `OneDrive createUploadSession sikertelen (HTTP ${sessionResp.status}): ${sessionText.slice(0, 220)}`,
        { statusHttp: sessionResp.status, provider: 'onedrive', account: ctx.account },
      )
    }
    const { uploadUrl } = JSON.parse(sessionText) as { uploadUrl?: string }
    if (!uploadUrl) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Hiányzó uploadUrl a OneDrive createUploadSession válaszból.', {
        statusHttp: 502,
        provider: 'onedrive',
        account: ctx.account,
      })
    }

    // Microsoft Graph strictly requires non-final chunk sizes to be exact multiples of 320 KiB!
    const rawChunk = params.chunkBytes ?? ONEDRIVE_DEFAULT_CHUNK_BYTES
    const alignedChunk = Math.max(
      ONEDRIVE_CHUNK_ALIGNMENT,
      Math.floor(rawChunk / ONEDRIVE_CHUNK_ALIGNMENT) * ONEDRIVE_CHUNK_ALIGNMENT,
    )

    let finalItem: GraphDriveItemRaw | null = null
    for await (const slice of readFileInBoundedChunks(params.localFilePath, params.fileSizeBytes, alignedChunk)) {
      const resp = await executeChunkWithRetry(
        () =>
          ctx.fetchImpl(uploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Length': String(slice.buffer.length),
              'Content-Range': `bytes ${slice.start}-${slice.end}/${slice.totalBytes}`,
            },
            body: new Uint8Array(slice.buffer),
          }),
        {
          retryDelaysMs: ctx.retryDelaysMs,
          isAcceptedStatus: (s) => s === 200 || s === 201 || s === 202,
        },
      )

      const respText = await resp.text()
      if (!resp.ok) {
        throw new CloudStorageError(
          'CLOUD_API_ERROR',
          `OneDrive szelet feltöltés sikertelen (HTTP ${resp.status}): ${respText.slice(0, 220)}`,
          { statusHttp: resp.status, provider: 'onedrive', account: ctx.account },
        )
      }
      if (resp.status === 200 || resp.status === 201) {
        finalItem = JSON.parse(respText) as GraphDriveItemRaw
      }
    }

    if (!finalItem) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'OneDrive feltöltés nem adott vissza végleges DriveItem választ.', {
        statusHttp: 502,
        provider: 'onedrive',
        account: ctx.account,
      })
    }
    const mapped = mapGraphItem(finalItem)
    if (mapped.sizeBytes !== null && mapped.sizeBytes !== params.fileSizeBytes) {
      throw new CloudStorageError(
        'CLOUD_INTEGRITY_MISMATCH',
        `Feltöltési méreteltérés OneDrive-on: helyi ${params.fileSizeBytes} B, távoli ${mapped.sizeBytes} B.`,
        { statusHttp: 502, provider: 'onedrive', account: ctx.account },
      )
    }
    return mapped
  },

  async downloadStream(ctx, params: CloudDownloadParams): Promise<CloudDownloadResult> {
    const itemId = assertGraphItemId(params.fileRef, 'fileRef')
    const rawMeta = await graphJsonFetch<GraphDriveItemRaw>(
      ctx,
      `${itemBaseUrl(itemId)}?$select=id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference`,
    )
    const item = mapGraphItem(rawMeta)

    const resp = await ctx.fetchImpl(`${itemBaseUrl(itemId)}/content`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      if (isInvalidGrantError(resp.status, errText)) {
        throw new CloudReauthRequiredError('onedrive', ctx.account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `OneDrive letöltés sikertelen (HTTP ${resp.status}): ${errText.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'onedrive',
        account: ctx.account,
      })
    }

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
    const itemId = assertGraphItemId(params.fileRef, 'fileRef')

    if (params.publicLink) {
      const expiresAt =
        typeof params.expiresInDays === 'number' && params.expiresInDays > 0
          ? new Date(Date.now() + params.expiresInDays * 86_400_000).toISOString()
          : undefined
      const resp = await ctx.fetchImpl(`${itemBaseUrl(itemId)}/createLink`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: params.role === 'writer' ? 'edit' : 'view',
          scope: 'anonymous',
          ...(expiresAt ? { expirationDateTime: expiresAt } : {}),
        }),
      })
      const text = await resp.text()
      if (!resp.ok) {
        if (isInvalidGrantError(resp.status, text)) {
          throw new CloudReauthRequiredError('onedrive', ctx.account, `HTTP ${resp.status}`)
        }
        throw new CloudStorageError(
          'CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER',
          `A OneDrive bérlő/fiók nem engedélyezte az anonim linket (HTTP ${resp.status}): ${text.slice(0, 220)}`,
          { statusHttp: resp.status, provider: 'onedrive', account: ctx.account },
        )
      }
      const parsed = JSON.parse(text) as { link?: { webUrl?: string } }
      return {
        provider: 'onedrive',
        account: ctx.account,
        itemId,
        webUrl: parsed.link?.webUrl ?? '',
        mode: 'public_link',
        sharedWith: 'anyone',
        role: params.role,
        notified: false,
        expiresAt: expiresAt ?? null,
      }
    }

    const inviteResp = await ctx.fetchImpl(`${itemBaseUrl(itemId)}/invite`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipients: [{ email: params.email }],
        message: '',
        requireSignIn: true,
        sendInvitation: params.notify,
        roles: [params.role === 'writer' ? 'write' : 'read'],
      }),
    })
    const inviteText = await inviteResp.text()
    if (!inviteResp.ok) {
      if (isInvalidGrantError(inviteResp.status, inviteText)) {
        throw new CloudReauthRequiredError('onedrive', ctx.account, `HTTP ${inviteResp.status}`)
      }
      throw new CloudStorageError(
        'CLOUD_SHARE_PROVIDER_ERROR',
        `OneDrive e-mailes megosztás sikertelen (HTTP ${inviteResp.status}): ${inviteText.slice(0, 220)}`,
        { statusHttp: inviteResp.status, provider: 'onedrive', account: ctx.account },
      )
    }

    const inviteParsed = JSON.parse(inviteText) as { value?: Array<{ link?: { webUrl?: string } }> }
    let webUrl = inviteParsed.value?.[0]?.link?.webUrl ?? ''
    if (!webUrl) {
      const meta = await graphJsonFetch<GraphDriveItemRaw>(ctx, `${itemBaseUrl(itemId)}?$select=webUrl`)
      webUrl = meta.webUrl ?? ''
    }

    return {
      provider: 'onedrive',
      account: ctx.account,
      itemId,
      webUrl,
      mode: 'email',
      sharedWith: String(params.email ?? ''),
      role: params.role,
      notified: params.notify,
    }
  },
}
