/* Build-free ES6 Dashboard slot widget for core-ops VPS Storage & Telemetry. */

const activeControllers = new WeakMap()

function formatBytes(rawBytes) {
  const n = Number(rawBytes || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = n
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  const decimals = idx === 0 ? 0 : val >= 10 ? 1 : 2
  return `${val.toFixed(decimals)} ${units[idx]}`
}

function healthColor(level) {
  if (level === 'crit') return '#dc2626'
  if (level === 'warn') return '#d97706'
  return '#16a34a'
}

function el(tag, styleText, textValue) {
  const node = document.createElement(tag)
  if (styleText) node.style.cssText = styleText
  if (textValue !== undefined && textValue !== null) {
    node.textContent = String(textValue)
  }
  return node
}

async function requestJson(url, ctx, opts = {}) {
  if (ctx && typeof ctx.apiJson === 'function') {
    return ctx.apiJson(url, opts)
  }
  const fetchFn = (ctx && typeof ctx.fetch === 'function' ? ctx.fetch : globalThis.fetch)
  const headers = new Headers(opts.headers || {})
  if (!headers.has('Content-Type') && opts.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  const csrf = typeof ctx?.getCsrfToken === 'function'
    ? ctx.getCsrfToken()
    : ctx?.csrfToken
  if (csrf && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', csrf)
  }
  const res = await fetchFn(url, {
    credentials: 'same-origin',
    ...opts,
    headers,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.message || data.error || `HTTP ${res.status}`)
  }
  return data
}

function buildBarCard(title, usedPct, subtitle, warnPct = 85, critPct = 95) {
  const pct = Math.max(0, Math.min(100, Number(usedPct || 0)))
  const color = pct >= critPct ? '#dc2626' : pct >= warnPct ? '#d97706' : '#16a34a'
  const card = el(
    'div',
    'padding:10px;border:1px solid var(--border,#334155);border-radius:8px;background:var(--bg,#0f172a);display:flex;flex-direction:column;gap:6px',
  )
  const top = el('div', 'display:flex;justify-content:space-between;align-items:center;font-size:12px;gap:6px')
  top.append(
    el('strong', '', title),
    el('span', `font-weight:700;color:${color}`, `${pct.toFixed(1)}%`),
  )
  const track = el('div', 'height:8px;border-radius:999px;background:rgba(128,128,128,0.22);overflow:hidden')
  const fill = el('div', `height:100%;width:${pct}%;background:${color};border-radius:999px`)
  track.append(fill)
  card.append(top, track, el('div', 'font-size:11px;opacity:.82', subtitle))
  return card
}

export function unmount(container) {
  if (!container) return
  const entry = activeControllers.get(container)
  if (entry) {
    entry.disposed = true
    entry.controller.abort()
    activeControllers.delete(container)
  }
  container.replaceChildren()
}

export function mount(container, ctx = {}) {
  if (!container) {
    return { unmount() {} }
  }
  unmount(container)

  const state = {
    disposed: false,
    controller: new AbortController(),
  }
  activeControllers.set(container, state)

  const root = el(
    'div',
    'padding:14px;border:1px solid var(--border,#334155);border-radius:10px;background:var(--surface,#1e293b);display:flex;flex-direction:column;gap:10px',
  )
  root.dataset.moduleCard = 'core-ops'

  const header = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap')
  const titleGroup = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap')
  const titleEl = el('strong', '', 'VPS Storage & Telemetry')
  const badgeEl = el(
    'span',
    'padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#fff;background:#16a34a',
    'OK',
  )
  titleGroup.append(titleEl, badgeEl)

  const actions = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center')
  const refreshBtn = el('button', 'padding:5px 10px;border-radius:6px;cursor:pointer', 'Refresh')
  refreshBtn.type = 'button'
  const cleanupBtn = el('button', 'padding:5px 10px;border-radius:6px;cursor:pointer', 'Run Housekeeping')
  cleanupBtn.type = 'button'
  actions.append(refreshBtn, cleanupBtn)
  header.append(titleGroup, actions)

  const barsGrid = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px')
  const storageStrip = el('div', 'display:flex;gap:8px;flex-wrap:wrap;font-size:12px')
  const metaRow = el('div', 'font-size:12px;opacity:.85')
  const statusBanner = el(
    'div',
    'padding:8px 10px;border-radius:8px;border:1px solid var(--border,#334155);font-size:12px',
  )
  statusBanner.hidden = true

  root.append(header, barsGrid, storageStrip, metaRow, statusBanner)
  container.replaceChildren(root)

  function renderTelemetry(report) {
    if (state.disposed) return
    const level = report.health_level || 'ok'
    badgeEl.textContent = level.toUpperCase()
    badgeEl.style.background = healthColor(level)

    const mem = report.memory || {}
    const disk = report.disk || {}
    const psi = report.psi || {}
    const storage = report.storage || {}

    const psiCpu = psi.cpu && psi.cpu.available ? `${Number(psi.cpu.some_avg10 || 0).toFixed(2)}%` : 'n/a'
    const psiMem = psi.memory && psi.memory.available ? `${Number(psi.memory.some_avg10 || 0).toFixed(2)}%` : 'n/a'

    const memSub =
      `${mem.used_mb ?? 0} / ${mem.total_mb ?? 0} MB ` +
      `(avail: ${mem.available_mb ?? 0} MB · RSS: ${mem.process_rss_mb ?? 0} MB · ` +
      `PSI cpu/mem: ${psiCpu}/${psiMem})`
    const diskSub =
      `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)} ` +
      `(free: ${formatBytes(disk.free_bytes)})`

    barsGrid.replaceChildren(
      buildBarCard('RAM Usage', mem.used_pct || 0, memSub, 85, 95),
      buildBarCard(`SSD (${disk.path || '/'})`, disk.used_pct || 0, diskSub, 80, 90),
    )

    const entries = Array.isArray(storage.entries) ? storage.entries : []
    const pills = entries.map((entry) => {
      const label = entry.key === 'db'
        ? `db: ${formatBytes(entry.bytes)} (WAL: ${formatBytes(storage.db_wal_bytes)})`
        : `${entry.key}: ${formatBytes(entry.bytes)}`
      return el(
        'span',
        'padding:4px 8px;border:1px solid var(--border,#334155);border-radius:6px',
        label,
      )
    })
    storageStrip.replaceChildren(...pills)

    const holdsCount = Number(report.active_heavy_holds || 0)
    const holdSuffix = holdsCount > 0 ? ' (gentle housekeeping mode)' : ''
    metaRow.textContent = `Host: ${report.hostname || 'unknown'} · Active heavy holds: ${holdsCount}${holdSuffix}`
  }

  async function loadTelemetry() {
    if (state.disposed) return
    try {
      const report = await requestJson('/api/ops/telemetry', ctx, {
        method: 'GET',
        signal: state.controller.signal,
      })
      renderTelemetry(report)
    } catch (err) {
      if (state.disposed || err?.name === 'AbortError') return
      statusBanner.hidden = false
      statusBanner.textContent = `Telemetry error: ${err?.message || 'unknown error'}`
    }
  }

  async function triggerHousekeeping() {
    if (state.disposed) return
    cleanupBtn.disabled = true
    statusBanner.hidden = false
    statusBanner.textContent = 'Running housekeeping...'
    try {
      const res = await requestJson('/api/ops/housekeeping', ctx, {
        method: 'POST',
        body: JSON.stringify({}),
        signal: state.controller.signal,
      })
      if (state.disposed) return
      const modeText = res.gentle_mode ? 'Gentle mode (heavy job active)' : 'Full TRUNCATE WAL'
      statusBanner.textContent =
        `${modeText} · Freed: ${formatBytes(res.freed_bytes)} · ` +
        `Pruned rows: ${res.pruned_db_rows ?? 0} · Modules: ${(res.module_results || []).length}`
      await loadTelemetry()
    } catch (err) {
      if (state.disposed || err?.name === 'AbortError') return
      statusBanner.textContent = `Housekeeping error: ${err?.message || 'unknown error'}`
    } finally {
      if (!state.disposed) cleanupBtn.disabled = false
    }
  }

  refreshBtn.addEventListener('click', () => {
    void loadTelemetry()
  })
  cleanupBtn.addEventListener('click', () => {
    void triggerHousekeeping()
  })

  void loadTelemetry()

  return {
    unmount() {
      unmount(container)
    },
  }
}
