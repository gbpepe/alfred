import { extname } from 'node:path'
import {
  CloudReauthRequiredError,
  CloudStorageError,
  computeQuotaPct,
  DEFAULT_CLOUD_CHUNK_BYTES,
  executeChunkWithRetry,
  isInvalidGrantError,
  readFileInBoundedChunks,
  streamResponseToDiskAtomic,
  type CloudAccessMode,
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

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3'
const GOOGLE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder'

const SAFE_DRIVE_ID_RE = /^(?:root|[A-Za-z0-9._-]{3,128})$/

function assertDriveId(raw: string, label: string): string {
  const clean = raw.trim()
  if (!SAFE_DRIVE_ID_RE.test(clean)) {
    throw new CloudStorageError('CLOUD_API_ERROR', `Érvénytelen Google Drive ${label} azonosító: "${raw}"`, {
      statusHttp: 400,
      provider: 'gdrive',
    })
  }
  return clean
}

function escapeDriveQueryLiteral(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

interface GoogleDriveFileRaw {
  id?: string
  name?: string
  mimeType?: string
  size?: string | number
  modifiedTime?: string
  webViewLink?: string
  parents?: string[]
  md5Checksum?: string
}

function mapDriveFile(raw: GoogleDriveFileRaw): CloudItem {
  const mime = raw.mimeType ?? null
  const isFolder = mime === GOOGLE_FOLDER_MIME
  const parsedSize = raw.size !== undefined && raw.size !== null ? Number(raw.size) : NaN
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    kind: isFolder ? 'folder' : 'file',
    sizeBytes: isFolder ? null : Number.isFinite(parsedSize) ? parsedSize : null,
    mimeType: mime,
    modifiedAt: raw.modifiedTime ?? null,
    webUrl: raw.webViewLink ?? null,
    parentRef: Array.isArray(raw.parents) && raw.parents.length > 0 ? raw.parents[0] : null,
    checksum: raw.md5Checksum ?? null,
  }
}

function resolveGoogleExportMime(nativeMime: string, destPath: string, explicitFormat?: string): string | null {
  const hint = (explicitFormat || extname(destPath).replace(/^\./, '')).trim().toLowerCase()
  const byHint: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    csv: 'text/csv',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    html: 'text/html',
  }
  if (hint && byHint[hint]) return byHint[hint]

  if (nativeMime === 'application/vnd.google-apps.document') return 'text/markdown'
  if (nativeMime === 'application/vnd.google-apps.spreadsheet') return 'text/csv'
  if (nativeMime === 'application/vnd.google-apps.presentation') return 'application/pdf'
  if (nativeMime === 'application/vnd.google-apps.drawing') return 'image/png'
  return null
}

async function driveJsonFetch<T>(
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
      throw new CloudReauthRequiredError('gdrive', ctx.account, `HTTP ${resp.status}`)
    }
    if (resp.status === 404) {
      throw new CloudStorageError('CLOUD_NOT_FOUND', `Google Drive elem nem található (HTTP 404).`, {
        statusHttp: 404,
        provider: 'gdrive',
        account: ctx.account,
      })
    }
    throw new CloudStorageError('CLOUD_API_ERROR', `Google Drive API hiba (HTTP ${resp.status}): ${text.slice(0, 260)}`, {
      statusHttp: resp.status,
      provider: 'gdrive',
      account: ctx.account,
    })
  }
  return (text ? JSON.parse(text) : {}) as T
}

async function findChildByName(
  ctx: CloudAdapterCallContext,
  parentId: string,
  name: string,
  folderOnly: boolean,
): Promise<CloudItem | null> {
  const safeParent = assertDriveId(parentId, 'parentRef')
  const parts = [
    `'${escapeDriveQueryLiteral(safeParent)}' in parents`,
    `name = '${escapeDriveQueryLiteral(name)}'`,
    'trashed = false',
  ]
  if (folderOnly) {
    parts.push(`mimeType = '${GOOGLE_FOLDER_MIME}'`)
  } else {
    parts.push(`mimeType != '${GOOGLE_FOLDER_MIME}'`)
  }
  const q = encodeURIComponent(parts.join(' and '))
  const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,webViewLink,parents,md5Checksum)')
  const data = await driveJsonFetch<{ files?: GoogleDriveFileRaw[] }>(
    ctx,
    `${GOOGLE_DRIVE_API}/files?q=${q}&pageSize=5&fields=${fields}`,
  )
  const first = data.files?.[0]
  return first ? mapDriveFile(first) : null
}

export const googleDriveProvider: CloudStorageProvider = {
  id: 'gdrive',
  displayName: 'Google Drive',
  recommendedChunkBytes: DEFAULT_CLOUD_CHUNK_BYTES,
  apiBaseUrl: GOOGLE_DRIVE_API,
  uploadMode: 'gdrive_resumable',

  buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, accessMode }) {
    const scope =
      accessMode === 'read_only'
        ? 'https://www.googleapis.com/auth/drive.readonly'
        : 'https://www.googleapis.com/auth/drive'
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: 'false',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    })
    return `${GOOGLE_AUTH_URL}?${params.toString()}`
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
    const resp = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new CloudStorageError('CLOUD_API_ERROR', `Google OAuth2 token csere sikertelen (HTTP ${resp.status}): ${text.slice(0, 240)}`, {
        statusHttp: resp.status,
        provider: 'gdrive',
      })
    }
    const parsed = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!parsed.access_token || !parsed.refresh_token) {
      throw new CloudStorageError(
        'CLOUD_API_ERROR',
        'A Google OAuth2 válasz nem tartalmazott refresh_token-t. Győződj meg róla, hogy a prompt=select_account consent jóváhagyás lefutott.',
        { statusHttp: 502, provider: 'gdrive' },
      )
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
    const resp = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const text = await resp.text()
    if (!resp.ok) {
      if (isInvalidGrantError(resp.status, text)) {
        throw new CloudReauthRequiredError('gdrive', account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError('CLOUD_API_ERROR', `Google token frissítés sikertelen (HTTP ${resp.status}): ${text.slice(0, 220)}`, {
        statusHttp: resp.status,
        provider: 'gdrive',
        account,
      })
    }
    const parsed = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!parsed.access_token) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Hiányzó access_token a Google token frissítési válaszban.', {
        statusHttp: 502,
        provider: 'gdrive',
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
    const data = await driveJsonFetch<{
      user?: { displayName?: string; emailAddress?: string }
      storageQuota?: { limit?: string; usage?: string; usageInDrive?: string }
    }>(ctx, `${GOOGLE_DRIVE_API}/about?fields=user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive)`)
    const usedRaw = data.storageQuota?.usage ?? data.storageQuota?.usageInDrive
    const totalRaw = data.storageQuota?.limit
    const usedBytes = usedRaw !== undefined && Number.isFinite(Number(usedRaw)) ? Number(usedRaw) : null
    const totalBytes = totalRaw !== undefined && Number.isFinite(Number(totalRaw)) ? Number(totalRaw) : null
    return {
      accountEmail: data.user?.emailAddress ?? null,
      displayName: data.user?.displayName ?? null,
      usedBytes,
      totalBytes,
      usedPct: computeQuotaPct(usedBytes, totalBytes),
    }
  },

  async list(ctx, params?: CloudListParams): Promise<CloudItem[]> {
    const parentId = assertDriveId(params?.folderRef || ctx.rootRef || 'root', 'folderRef')
    const limit = Math.max(1, Math.min(200, Math.floor(params?.limit ?? 50)))
    const qParts: string[] = ['trashed = false']
    if (params?.query && params.query.trim()) {
      qParts.push(`name contains '${escapeDriveQueryLiteral(params.query.trim())}'`)
      if (params.folderRef || (ctx.rootRef && ctx.rootRef !== 'root')) {
        qParts.push(`'${escapeDriveQueryLiteral(parentId)}' in parents`)
      }
    } else {
      qParts.push(`'${escapeDriveQueryLiteral(parentId)}' in parents`)
    }
    if (params?.kind === 'folder') {
      qParts.push(`mimeType = '${GOOGLE_FOLDER_MIME}'`)
    } else if (params?.kind === 'file') {
      qParts.push(`mimeType != '${GOOGLE_FOLDER_MIME}'`)
    }
    const q = encodeURIComponent(qParts.join(' and '))
    const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,webViewLink,parents,md5Checksum)')
    const data = await driveJsonFetch<{ files?: GoogleDriveFileRaw[] }>(
      ctx,
      `${GOOGLE_DRIVE_API}/files?q=${q}&pageSize=${limit}&orderBy=folder,modifiedTime desc&fields=${fields}`,
    )
    return (data.files ?? []).map(mapDriveFile)
  },

  async mkdir(ctx, name, parentRef): Promise<CloudItem> {
    const parentId = assertDriveId(parentRef || ctx.rootRef || 'root', 'parentRef')
    const cleanName = name.trim()
    if (!cleanName) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'A mappa neve nem lehet üres.', { provider: 'gdrive' })
    }
    const existing = await findChildByName(ctx, parentId, cleanName, true)
    if (existing) return existing

    const fields = encodeURIComponent('id,name,mimeType,modifiedTime,webViewLink,parents')
    const created = await driveJsonFetch<GoogleDriveFileRaw>(ctx, `${GOOGLE_DRIVE_API}/files?fields=${fields}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cleanName,
        mimeType: GOOGLE_FOLDER_MIME,
        parents: [parentId],
      }),
    })
    return mapDriveFile(created)
  },

  async uploadStream(ctx, params: CloudUploadParams): Promise<CloudItem> {
    const parentId = assertDriveId(params.parentRef || ctx.rootRef || 'root', 'parentRef')
    const conflictMode = params.onConflict ?? 'update_in_place'
    const existing = await findChildByName(ctx, parentId, params.remoteName, false)

    if (existing && conflictMode === 'fail') {
      throw new CloudStorageError(
        'CLOUD_CONFLICT_EXISTS',
        `A(z) "${params.remoteName}" fájl már létezik a Google Drive mappában (on_conflict=fail).`,
        { statusHttp: 409, provider: 'gdrive', account: ctx.account },
      )
    }

    const usePatchInPlace = Boolean(existing && conflictMode === 'update_in_place')
    const fields = encodeURIComponent('id,name,mimeType,size,modifiedTime,webViewLink,parents,md5Checksum')
    const initUrl = usePatchInPlace
      ? `${GOOGLE_UPLOAD_API}/files/${encodeURIComponent(existing!.id)}?uploadType=resumable&fields=${fields}`
      : `${GOOGLE_UPLOAD_API}/files?uploadType=resumable&fields=${fields}`

    const initResp = await ctx.fetchImpl(initUrl, {
      method: usePatchInPlace ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': params.mimeType,
        'X-Upload-Content-Length': String(params.fileSizeBytes),
      },
      body: JSON.stringify(
        usePatchInPlace
          ? { name: params.remoteName }
          : { name: params.remoteName, parents: [parentId] },
      ),
    })

    if (!initResp.ok) {
      const errText = await initResp.text().catch(() => '')
      if (isInvalidGrantError(initResp.status, errText)) {
        throw new CloudReauthRequiredError('gdrive', ctx.account, `HTTP ${initResp.status}`)
      }
      throw new CloudStorageError(
        'CLOUD_API_ERROR',
        `Google Drive resumable session indítása sikertelen (HTTP ${initResp.status}): ${errText.slice(0, 220)}`,
        { statusHttp: initResp.status, provider: 'gdrive', account: ctx.account },
      )
    }

    const sessionUri = initResp.headers.get('location')
    if (!sessionUri) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Hiányzó Location fejléc a Google Drive resumable válaszból.', {
        statusHttp: 502,
        provider: 'gdrive',
        account: ctx.account,
      })
    }

    // Handle 0-byte empty file cleanly
    if (params.fileSizeBytes === 0) {
      const zeroResp = await executeChunkWithRetry(
        () =>
          ctx.fetchImpl(sessionUri, {
            method: 'PUT',
            redirect: 'manual',
            headers: {
              'Content-Length': '0',
              'Content-Range': 'bytes */0',
              'Content-Type': params.mimeType,
            },
            body: new Uint8Array(0),
          }),
        { retryDelaysMs: ctx.retryDelaysMs },
      )
      const zeroText = await zeroResp.text()
      if (!zeroResp.ok) {
        throw new CloudStorageError(
          'CLOUD_API_ERROR',
          `Google Drive 0-bájtos feltöltés sikertelen (HTTP ${zeroResp.status}): ${zeroText.slice(0, 220)}`,
          { statusHttp: zeroResp.status, provider: 'gdrive', account: ctx.account },
        )
      }
      return mapDriveFile(JSON.parse(zeroText) as GoogleDriveFileRaw)
    }

    // Align chunk size to 256 KiB multiple as required by Google Drive Resumable Upload API
    const rawChunk = params.chunkBytes ?? DEFAULT_CLOUD_CHUNK_BYTES
    const alignedChunk = Math.max(256 * 1024, Math.floor(rawChunk / (256 * 1024)) * (256 * 1024))

    let finalFile: GoogleDriveFileRaw | null = null
    for await (const slice of readFileInBoundedChunks(params.localFilePath, params.fileSizeBytes, alignedChunk)) {
      const resp = await executeChunkWithRetry(
        () =>
          ctx.fetchImpl(sessionUri, {
            method: 'PUT',
            redirect: 'manual',
            headers: {
              'Content-Length': String(slice.buffer.length),
              'Content-Range': `bytes ${slice.start}-${slice.end}/${slice.totalBytes}`,
              'Content-Type': params.mimeType,
            },
            body: new Uint8Array(slice.buffer),
          }),
        {
          retryDelaysMs: ctx.retryDelaysMs,
          isAcceptedStatus: (s) => s === 200 || s === 201 || s === 308,
        },
      )

      if (resp.status === 308) {
        await resp.body?.cancel().catch(() => {})
        continue
      }
      const respText = await resp.text()
      if (!resp.ok) {
        throw new CloudStorageError(
          'CLOUD_API_ERROR',
          `Google Drive szelet feltöltés sikertelen (HTTP ${resp.status}): ${respText.slice(0, 220)}`,
          { statusHttp: resp.status, provider: 'gdrive', account: ctx.account },
        )
      }
      finalFile = JSON.parse(respText) as GoogleDriveFileRaw
    }

    if (!finalFile) {
      throw new CloudStorageError('CLOUD_API_ERROR', 'Google Drive feltöltés befejezése nem adott vissza fájl-metaadatot.', {
        statusHttp: 502,
        provider: 'gdrive',
        account: ctx.account,
      })
    }
    const mapped = mapDriveFile(finalFile)
    if (mapped.sizeBytes !== null && mapped.sizeBytes !== params.fileSizeBytes) {
      throw new CloudStorageError(
        'CLOUD_INTEGRITY_MISMATCH',
        `Feltöltési méreteltérés Google Drive-on: helyi ${params.fileSizeBytes} B, távoli ${mapped.sizeBytes} B.`,
        { statusHttp: 502, provider: 'gdrive', account: ctx.account },
      )
    }
    return mapped
  },

  async downloadStream(ctx, params: CloudDownloadParams): Promise<CloudDownloadResult> {
    const fileId = assertDriveId(params.fileRef, 'fileRef')
    const metaFields = encodeURIComponent('id,name,mimeType,size,modifiedTime,webViewLink,parents,md5Checksum')
    const rawMeta = await driveJsonFetch<GoogleDriveFileRaw>(
      ctx,
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${metaFields}`,
    )
    const item = mapDriveFile(rawMeta)

    let downloadUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
    let exportedMimeType: string | null = null
    if (item.mimeType && item.mimeType.startsWith('application/vnd.google-apps.')) {
      exportedMimeType = resolveGoogleExportMime(item.mimeType, params.destFilePath, params.exportFormat)
      if (!exportedMimeType) {
        throw new CloudStorageError(
          'CLOUD_API_ERROR',
          `A natív Google fájl (${item.mimeType}) nem exportálható a megadott célformátumba.`,
          { statusHttp: 400, provider: 'gdrive', account: ctx.account },
        )
      }
      downloadUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportedMimeType)}`
    }

    const resp = await ctx.fetchImpl(downloadUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      if (isInvalidGrantError(resp.status, errText)) {
        throw new CloudReauthRequiredError('gdrive', ctx.account, `HTTP ${resp.status}`)
      }
      throw new CloudStorageError(
        'CLOUD_API_ERROR',
        `Google Drive letöltés sikertelen (HTTP ${resp.status}): ${errText.slice(0, 220)}`,
        { statusHttp: resp.status, provider: 'gdrive', account: ctx.account },
      )
    }

    const bytesWritten = await streamResponseToDiskAtomic({
      resp,
      destFilePath: params.destFilePath,
      maxDownloadBytes: params.maxDownloadBytes,
      expectedSizeBytes: exportedMimeType ? null : item.sizeBytes,
      skipDiskSpaceCheck: ctx.skipDiskSpaceCheck,
    })

    return {
      item,
      bytesWritten,
      savedPath: params.destFilePath,
      exportedMimeType,
    }
  },

  async share(ctx, params: CloudShareParams): Promise<CloudShareResult> {
    const fileId = assertDriveId(params.fileRef, 'fileRef')
    const driveRole = params.role === 'writer' ? 'writer' : 'reader'

    const permPayload = params.publicLink
      ? { type: 'anyone', role: driveRole }
      : { type: 'user', role: driveRole, emailAddress: params.email }

    const permUrl = params.publicLink
      ? `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=id`
      : `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=${params.notify ? 'true' : 'false'}&fields=id`

    const permResp = await ctx.fetchImpl(permUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(permPayload),
    })

    if (!permResp.ok) {
      const errText = await permResp.text().catch(() => '')
      if (isInvalidGrantError(permResp.status, errText)) {
        throw new CloudReauthRequiredError('gdrive', ctx.account, `HTTP ${permResp.status}`)
      }
      if (params.publicLink && (permResp.status === 403 || permResp.status === 400)) {
        throw new CloudStorageError(
          'CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER',
          `A Google Drive fiók/szervezet tiltja a nyilvános (anyone) link létrehozását (HTTP ${permResp.status}): ${errText.slice(0, 220)}`,
          { statusHttp: permResp.status, provider: 'gdrive', account: ctx.account },
        )
      }
      throw new CloudStorageError(
        'CLOUD_SHARE_PROVIDER_ERROR',
        `Google Drive megosztási hiba (HTTP ${permResp.status}): ${errText.slice(0, 220)}`,
        { statusHttp: permResp.status, provider: 'gdrive', account: ctx.account },
      )
    }

    const meta = await driveJsonFetch<GoogleDriveFileRaw>(
      ctx,
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,webViewLink`,
    )
    const webUrl = meta.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`

    return {
      provider: 'gdrive',
      account: ctx.account,
      itemId: fileId,
      webUrl,
      mode: params.publicLink ? 'public_link' : 'email',
      sharedWith: params.publicLink ? 'anyone' : String(params.email ?? ''),
      role: params.role,
      notified: params.publicLink ? false : params.notify,
    }
  },

  async rename(ctx, itemRef, newName): Promise<CloudItem> {
    const fileId = assertDriveId(itemRef, 'itemRef')
    const fields = encodeURIComponent('id,name,mimeType,size,modifiedTime,webViewLink,parents')
    const updated = await driveJsonFetch<GoogleDriveFileRaw>(
      ctx,
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${fields}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      },
    )
    return mapDriveFile(updated)
  },

  async deleteItem(ctx, itemRef): Promise<{ deleted: boolean; trashed: boolean }> {
    const fileId = assertDriveId(itemRef, 'itemRef')
    await driveJsonFetch<GoogleDriveFileRaw>(
      ctx,
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
    )
    return { deleted: true, trashed: true }
  },
}
