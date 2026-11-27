import { randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statfsSync,
  unlinkSync,
} from 'node:fs'
import { dirname, extname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

export type CloudProviderId = 'gdrive' | 'onedrive' | 'dropbox'
export type CloudAccessMode = 'read_write' | 'read_only'
export type CloudUploadConflictMode = 'update_in_place' | 'autorename' | 'fail'
export type CloudItemKindFilter = 'all' | 'file' | 'folder'
export type CloudShareRole = 'reader' | 'writer'
export type CloudShareMode = 'email' | 'public_link'

export type CloudConnectionHealth =
  | 'disconnected'
  | 'client_configured'
  | 'connected'
  | 'needs_reauth'
  | 'error'

export const CLOUD_PROVIDERS: readonly CloudProviderId[] = ['gdrive', 'onedrive', 'dropbox'] as const
export const DEFAULT_CLOUD_CHUNK_BYTES = 8 * 1024 * 1024 // 8 MiB (32 * 256 KiB for Google Drive)
export const ONEDRIVE_CHUNK_ALIGNMENT = 320 * 1024 // 320 KiB Microsoft Graph alignment requirement
export const ONEDRIVE_DEFAULT_CHUNK_BYTES = 25 * ONEDRIVE_CHUNK_ALIGNMENT // 8,192,000 B (~7.81 MiB)
export const MIN_FREE_DISK_RESERVE_BYTES = 512 * 1024 * 1024 // 512 MiB SSD safety reserve

export type CloudErrorCode =
  | 'CLOUD_INVALID_PROVIDER'
  | 'CLOUD_INVALID_ACCOUNT'
  | 'CLOUD_ACCOUNT_NOT_FOUND'
  | 'CLOUD_NOT_CONFIGURED'
  | 'CLOUD_NEEDS_REAUTH'
  | 'CLOUD_ACCOUNT_READONLY'
  | 'CLOUD_READONLY_TARGET'
  | 'CLOUD_PATH_TRAVERSAL'
  | 'CLOUD_PUBLIC_LINK_FORBIDDEN'
  | 'CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER'
  | 'CLOUD_SHARE_RECIPIENT_REQUIRED'
  | 'CLOUD_SHARE_PROVIDER_ERROR'
  | 'CLOUD_DOWNLOAD_LIMIT_EXCEEDED'
  | 'CLOUD_UPLOAD_LIMIT_EXCEEDED'
  | 'CLOUD_DISK_SPACE_INSUFFICIENT'
  | 'CLOUD_INTEGRITY_MISMATCH'
  | 'CLOUD_CONFLICT_EXISTS'
  | 'CLOUD_NOT_FOUND'
  | 'CLOUD_OAUTH_STATE_INVALID'
  | 'CLOUD_API_ERROR'

export class CloudStorageError extends Error {
  public readonly code: CloudErrorCode
  public readonly statusHttp: number
  public readonly provider?: CloudProviderId
  public readonly account?: string
  public readonly details?: Record<string, unknown>

  constructor(
    code: CloudErrorCode,
    message: string,
    opts?: {
      statusHttp?: number
      provider?: CloudProviderId
      account?: string
      details?: Record<string, unknown>
    },
  ) {
    super(message)
    this.name = 'CloudStorageError'
    this.code = code
    this.statusHttp = opts?.statusHttp ?? 400
    this.provider = opts?.provider
    this.account = opts?.account
    this.details = opts?.details
  }
}

export class CloudReauthRequiredError extends CloudStorageError {
  constructor(
    provider: CloudProviderId,
    account: string,
    detail?: string,
    healthyAlternateAccounts: string[] = [],
  ) {
    const altHint =
      healthyAlternateAccounts.length > 0
        ? ` Más egészséges fiókok explicit account paraméterrel elérhetők: [${healthyAlternateAccounts.join(', ')}].`
        : ''
    super(
      'CLOUD_NEEDS_REAUTH',
      `A(z) ${provider}::${account} felhőfiók OAuth2 munkamenete lejárt vagy visszavonták (needs_reauth). ` +
        `Indítsd újra a fiókválasztós összekötést a Dashboard #vps kártyán!${detail ? ` (${detail})` : ''}${altHint}`,
      {
        statusHttp: 401,
        provider,
        account,
        details: {
          needsReauth: true,
          ...(healthyAlternateAccounts.length > 0 ? { healthyAlternateAccounts } : {}),
        },
      },
    )
    this.name = 'CloudReauthRequiredError'
  }
}

export interface CloudItem {
  id: string
  name: string
  kind: 'file' | 'folder'
  sizeBytes: number | null
  mimeType?: string | null
  modifiedAt?: string | null
  webUrl?: string | null
  parentRef?: string | null
  pathDisplay?: string | null
  checksum?: string | null
}

export interface CloudQuotaInfo {
  accountEmail: string | null
  displayName: string | null
  usedBytes: number | null
  totalBytes: number | null
  usedPct: number | null
}

export interface CloudShareResult {
  provider: CloudProviderId
  account: string
  itemId: string
  webUrl: string
  mode: CloudShareMode
  sharedWith: string
  role: CloudShareRole
  notified: boolean
  expiresAt?: string | null
}

export interface CloudAdapterCallContext {
  accessToken: string
  account: string
  rootRef?: string | null
  fetchImpl: typeof fetch
  retryDelaysMs?: readonly number[]
  skipDiskSpaceCheck?: boolean
}

export interface CloudListParams {
  folderRef?: string
  query?: string
  kind?: CloudItemKindFilter
  limit?: number
}

export interface CloudUploadParams {
  localFilePath: string
  remoteName: string
  fileSizeBytes: number
  mimeType: string
  parentRef?: string
  onConflict?: CloudUploadConflictMode
  chunkBytes?: number
}

export interface CloudDownloadParams {
  fileRef: string
  destFilePath: string
  maxDownloadBytes: number
  exportFormat?: string
}

export interface CloudDownloadResult {
  item: CloudItem
  bytesWritten: number
  savedPath: string
  exportedMimeType?: string | null
}

export interface CloudShareParams {
  fileRef: string
  email?: string
  role: CloudShareRole
  publicLink: boolean
  notify: boolean
  expiresInDays?: number
}

export interface CloudStorageProvider {
  readonly id: CloudProviderId
  readonly displayName: string
  readonly recommendedChunkBytes: number
  readonly apiBaseUrl: string
  readonly uploadMode: 'gdrive_resumable' | 'onedrive_upload_session' | 'dropbox_upload_session'

  buildAuthorizationUrl(params: {
    clientId: string
    redirectUri: string
    state: string
    codeChallenge: string
    accessMode?: CloudAccessMode
  }): string

  exchangeCodeForTokens(params: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
    codeVerifier: string
    fetchImpl?: typeof fetch
  }): Promise<{ accessToken: string; refreshToken: string; expiresInSec: number }>

  refreshAccessToken(params: {
    clientId: string
    clientSecret: string
    refreshToken: string
    account: string
    fetchImpl?: typeof fetch
  }): Promise<{ accessToken: string; rotatedRefreshToken?: string; expiresInSec: number }>

  getAccountQuota(ctx: CloudAdapterCallContext): Promise<CloudQuotaInfo>
  list(ctx: CloudAdapterCallContext, params?: CloudListParams): Promise<CloudItem[]>
  mkdir(ctx: CloudAdapterCallContext, name: string, parentRef?: string): Promise<CloudItem>
  uploadStream(ctx: CloudAdapterCallContext, params: CloudUploadParams): Promise<CloudItem>
  downloadStream(ctx: CloudAdapterCallContext, params: CloudDownloadParams): Promise<CloudDownloadResult>
  share(ctx: CloudAdapterCallContext, params: CloudShareParams): Promise<CloudShareResult>
  rename(ctx: CloudAdapterCallContext, itemRef: string, newName: string): Promise<CloudItem>
  deleteItem(ctx: CloudAdapterCallContext, itemRef: string): Promise<{ deleted: boolean; trashed: boolean }>
}

export function isCloudProviderId(raw: string): raw is CloudProviderId {
  return raw === 'gdrive' || raw === 'onedrive' || raw === 'dropbox'
}

export function computeQuotaPct(usedBytes: number | null, totalBytes: number | null): number | null {
  if (usedBytes === null || totalBytes === null || totalBytes <= 0) return null
  return Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10))
}

/**
 * Encodes a JSON value into an ASCII-safe string (`\uXXXX` for all chars > 0x7F)
 * so HTTP headers such as `Dropbox-API-Arg` never fail on Hungarian / Unicode filenames.
 */
export function escapeHttpHeaderJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  })
}

export function guessMimeTypeFromFilename(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function isInvalidGrantError(status: number, bodyText: string): boolean {
  const lower = bodyText.toLowerCase()
  if (status === 401 && /invalid_token|expired_access_token|invalid_grant|token.*revoked|unauthorized/.test(lower)) {
    return true
  }
  return /invalid_grant|expired_token|token has been expired or revoked|aadsts70000|aadsts50173|invalid_refresh_token/.test(
    lower,
  )
}

export interface FileChunkSlice {
  buffer: Buffer
  start: number
  end: number // inclusive byte index
  totalBytes: number
  isFinal: boolean
}

/**
 * Memory-bounded async generator over `fs.createReadStream` yielding exact `chunkBytes` slices
 * (except the final slice), ensuring at most 1 chunk buffer (~8 MiB) lives in RAM at any time.
 */
export async function* readFileInBoundedChunks(
  filePath: string,
  totalBytes: number,
  chunkBytes: number = DEFAULT_CLOUD_CHUNK_BYTES,
): AsyncGenerator<FileChunkSlice> {
  if (totalBytes <= 0) {
    return
  }
  const safeChunkSize = Math.max(64 * 1024, Math.floor(chunkBytes))
  const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 })
  let pendingParts: Buffer[] = []
  let pendingLen = 0
  let offset = 0

  for await (const rawPiece of stream) {
    const piece = Buffer.isBuffer(rawPiece) ? rawPiece : Buffer.from(rawPiece as Uint8Array)
    pendingParts.push(piece)
    pendingLen += piece.length

    while (pendingLen >= safeChunkSize) {
      const merged = pendingParts.length === 1 ? pendingParts[0] : Buffer.concat(pendingParts, pendingLen)
      const slice = merged.subarray(0, safeChunkSize)
      const remainder = merged.subarray(safeChunkSize)
      pendingParts = remainder.length > 0 ? [remainder] : []
      pendingLen = remainder.length

      const start = offset
      const end = start + slice.length - 1
      offset += slice.length
      yield {
        buffer: slice,
        start,
        end,
        totalBytes,
        isFinal: offset >= totalBytes,
      }
    }
  }

  if (pendingLen > 0) {
    const finalBuf = pendingParts.length === 1 ? pendingParts[0] : Buffer.concat(pendingParts, pendingLen)
    const start = offset
    const end = start + finalBuf.length - 1
    offset += finalBuf.length
    yield {
      buffer: finalBuf,
      start,
      end,
      totalBytes,
      isFinal: true,
    }
  }
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 3500] as const

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null
  const secs = Number(headerVal.trim())
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(30_000, Math.round(secs * 1000))
  }
  const dateMs = Date.parse(headerVal)
  if (Number.isFinite(dateMs)) {
    return Math.min(30_000, Math.max(0, dateMs - Date.now()))
  }
  return null
}

/**
 * Executes a single chunk upload attempt with chunk-level retry on `429` / `5xx` / transient network errors,
 * honoring `Retry-After` headers without re-uploading earlier completed chunks.
 */
export async function executeChunkWithRetry(
  sendAttempt: () => Promise<Response>,
  opts?: {
    retryDelaysMs?: readonly number[]
    isAcceptedStatus?: (status: number) => boolean
    onBeforeRetry?: (attemptIndex: number) => Promise<void>
  },
): Promise<Response> {
  const delays = opts?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const isAccepted = opts?.isAcceptedStatus ?? ((s) => s >= 200 && s < 300)
  let lastErr: unknown = null

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const resp = await sendAttempt()
      if (isAccepted(resp.status)) {
        return resp
      }
      const isRetryable = resp.status === 429 || (resp.status >= 500 && resp.status <= 599)
      if (!isRetryable || attempt === delays.length) {
        return resp
      }
      const retryAfter = parseRetryAfterMs(resp.headers.get('retry-after'))
      await resp.body?.cancel().catch(() => {})
      if (opts?.onBeforeRetry) {
        await opts.onBeforeRetry(attempt)
      }
      await sleepMs(retryAfter ?? delays[attempt]!)
    } catch (err) {
      lastErr = err
      if (attempt === delays.length) {
        throw err
      }
      if (opts?.onBeforeRetry) {
        await opts.onBeforeRetry(attempt)
      }
      await sleepMs(delays[attempt]!)
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Chunk upload failed after retries')
}

/**
 * Checks available disk space on the destination partition before starting a download
 * to protect the 2 GB VPS SSD (requires `expectedBytes + 512 MiB` free).
 */
export function assertDiskSpaceAvailable(
  destFilePath: string,
  expectedBytes: number | null,
  reserveBytes: number = MIN_FREE_DISK_RESERVE_BYTES,
): void {
  const dir = dirname(destFilePath)
  mkdirSync(dir, { recursive: true })
  try {
    const fsStats = statfsSync(dir)
    const availBytes = Number(fsStats.bavail) * Number(fsStats.bsize)
    if (!Number.isFinite(availBytes) || availBytes <= 0) return
    const needed = Math.max(0, expectedBytes ?? 0) + reserveBytes
    if (availBytes < needed) {
      const availMb = Math.round(availBytes / 1_048_576)
      const neededMb = Math.round(needed / 1_048_576)
      throw new CloudStorageError(
        'CLOUD_DISK_SPACE_INSUFFICIENT',
        `Nincs elég szabad SSD tárhely a letöltéshez (szabad: ${availMb} MB, szükséges tartalékkal: ${neededMb} MB). ` +
          `Nagy fájlokhoz használd a 03-as munkagép közvetlen felhő-szinkronját!`,
        { statusHttp: 507, details: { availMb, neededMb } },
      )
    }
  } catch (err) {
    if (err instanceof CloudStorageError) throw err
    // Non-fatal fallback on virtual filesystems that do not support statfsSync
  }
}

/**
 * Streams an HTTP response body directly to a `.cloud-part.<uuid>` temp file with live byte-limit
 * enforcement, verifies expected byte count when known, and atomically renames into `destFilePath`.
 */
export async function streamResponseToDiskAtomic(params: {
  resp: Response
  destFilePath: string
  maxDownloadBytes: number
  expectedSizeBytes?: number | null
  skipDiskSpaceCheck?: boolean
}): Promise<number> {
  const { resp, destFilePath, maxDownloadBytes, expectedSizeBytes, skipDiskSpaceCheck } = params

  const headerLenRaw = resp.headers.get('content-length')
  const headerLen = headerLenRaw ? Number(headerLenRaw) : NaN
  const knownLen =
    Number.isFinite(headerLen) && headerLen >= 0
      ? headerLen
      : typeof expectedSizeBytes === 'number' && expectedSizeBytes >= 0
        ? expectedSizeBytes
        : null

  if (knownLen !== null && knownLen > maxDownloadBytes) {
    await resp.body?.cancel().catch(() => {})
    const fileMb = Math.round((knownLen / 1_048_576) * 10) / 10
    const maxMb = Math.round((maxDownloadBytes / 1_048_576) * 10) / 10
    throw new CloudStorageError(
      'CLOUD_DOWNLOAD_LIMIT_EXCEEDED',
      `A letölteni kívánt fájl (${fileMb} MB) meghaladja a vezérlő VPS ALFRED_CLOUD_MAX_DOWNLOAD_MB (${maxMb} MB) korlátját. ` +
        `Nagy fájlokhoz használd a 03-as munkagép közvetlen felhő-szinkronját (worker_machine)!`,
      { statusHttp: 413, details: { fileMb, maxMb } },
    )
  }

  if (!skipDiskSpaceCheck) {
    assertDiskSpaceAvailable(destFilePath, knownLen)
  }

  mkdirSync(dirname(destFilePath), { recursive: true })
  const partPath = `${destFilePath}.cloud-part.${randomUUID().slice(0, 8)}`
  let bytesWritten = 0

  try {
    if (!resp.body) {
      const ws = createWriteStream(partPath, { mode: 0o600 })
      await new Promise<void>((resolve, reject) => {
        ws.on('finish', resolve)
        ws.on('error', reject)
        ws.end()
      })
    } else {
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytesWritten += chunk.length
          if (bytesWritten > maxDownloadBytes) {
            const maxMb = Math.round((maxDownloadBytes / 1_048_576) * 10) / 10
            cb(
              new CloudStorageError(
                'CLOUD_DOWNLOAD_LIMIT_EXCEEDED',
                `A streamelt letöltés meghaladta a(z) ${maxMb} MB-os ALFRED_CLOUD_MAX_DOWNLOAD_MB korlátot és megszakadt.`,
                { statusHttp: 413, details: { bytesWritten, maxMb } },
              ),
            )
            return
          }
          cb(null, chunk)
        },
      })
      const webReadable = resp.body as unknown as WebReadableStream<Uint8Array>
      await pipeline(Readable.fromWeb(webReadable), limiter, createWriteStream(partPath, { mode: 0o600 }))
    }

    if (knownLen !== null && bytesWritten !== knownLen) {
      throw new CloudStorageError(
        'CLOUD_INTEGRITY_MISMATCH',
        `Letöltési integritási hiba: várt méret ${knownLen} bájt, ténylegesen kiírva ${bytesWritten} bájt.`,
        { statusHttp: 502, details: { expectedBytes: knownLen, bytesWritten } },
      )
    }

    renameSync(partPath, destFilePath)
    return bytesWritten
  } catch (err) {
    try {
      if (existsSync(partPath)) unlinkSync(partPath)
    } catch {
      // ignore cleanup error
    }
    throw err
  }
}
