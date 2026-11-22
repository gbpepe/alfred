import { writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

// Atomic write: write to a sibling tmp file and rename over the target, so a
// crash/kill mid-write can never leave a zero-byte or half-written state file.
// Use this for anything the dashboard depends on surviving a restart
// (dashboard-token, agent CLAUDE.md / SOUL.md, discord env + access.json).
// When the target file is a systemd single-file bind-mount (e.g. ReadWritePaths=/opt/alfred-prod/.env),
// renameSync fails with EBUSY/EXDEV/EPERM — in that case we fall back to in-place writeFileSync
// and always unlink the sibling .tmp file so no orphan temp files remain.
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const writeOpts = opts.mode !== undefined ? { mode: opts.mode } : undefined
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  let tmpCreated = false
  try {
    writeFileSync(tmp, data, writeOpts)
    tmpCreated = true
    if (opts.mode !== undefined) {
      try { chmodSync(tmp, opts.mode) } catch { /* best-effort */ }
    }
    renameSync(tmp, path)
    tmpCreated = false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (tmpCreated) {
      try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      tmpCreated = false
    }
    if (code === 'EBUSY' || code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
      writeFileSync(path, data, writeOpts)
      if (opts.mode !== undefined) {
        try { chmodSync(path, opts.mode) } catch { /* best-effort */ }
      }
      return
    }
    throw err
  } finally {
    if (tmpCreated) {
      try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    }
  }
}
