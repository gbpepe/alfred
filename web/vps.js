/* Alfred VPS & Core Chat view for the existing Kanban dashboard */
(function () {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function badgeColor(active) {
    if (active === 'active') return '#22c55e'
    if (active === 'local') return '#3b82f6'
    return '#ef4444'
  }

  async function apiJson(url, opts) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts && opts.headers ? opts.headers : {}),
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || data.output || 'HTTP ' + res.status)
    return data
  }

  async function refreshVpsStatus() {
    const svcEl = document.getElementById('vpsServicesGrid')
    const sysEl = document.getElementById('vpsSystemBar')
    const chatSelect = document.getElementById('vpsChatAgent')
    if (!svcEl || !sysEl) return
    try {
      const data = await apiJson('/api/vps/status')
      const sys = data.system || {}
      sysEl.innerHTML =
        '<span><b>Host:</b> ' + esc(sys.hostname) + '</span>' +
        '<span><b>RAM:</b> ' + esc(sys.memUsedMb) + ' / ' + esc(sys.memTotalMb) + ' MB (' + esc(sys.memAvailMb) + ' MB szabad)</span>' +
        (sys.diskSummary ? '<span><b>Lemez:</b> ' + esc(sys.diskSummary) + '</span>' : '')

      svcEl.innerHTML = (data.services || [])
        .map(function (s) {
          const gitText = s.git ? esc(s.git.branch) + '@' + esc(s.git.sha) : 'nincs worktree'
          const costHtml = s.costs
            ? '<div style="margin-top:8px;font-size:12px;opacity:.9">' +
            '<b>Napi költés:</b> $' + s.costs.globalSpendUsd.toFixed(4) + ' / $' + s.costs.globalBudgetUsd.toFixed(2) +
            '<div style="margin-top:4px">' +
            s.costs.agents
              .map(function (a) {
                return '<div>• ' + esc(a.id) + ' (' + esc(a.model) + '): $' + a.spendUsd.toFixed(4) + ' / $' + a.dailyBudgetUsd.toFixed(2) + '</div>'
              })
              .join('') +
            '</div></div>'
            : '<div style="margin-top:8px;font-size:12px;opacity:.6">Nincs DB adat</div>'

          return (
            '<div class="card" style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
            '<strong>' + esc(s.label) + ' (' + esc(s.unit) + ')</strong>' +
            '<span style="padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:' + badgeColor(s.active) + '">' + esc(s.active) + '</span>' +
            '</div>' +
            '<div style="margin-top:6px;font-size:12px;font-family:monospace;opacity:.85">' + gitText + '</div>' +
            costHtml +
            '</div>'
          )
        })
        .join('')

      if (chatSelect && data.agents && chatSelect.options.length === 0) {
        data.agents.forEach(function (a) {
          const opt = document.createElement('option')
          opt.value = a.id
          opt.textContent = a.id + ' (' + (a.role || '') + ' · ' + a.model + ')'
          chatSelect.appendChild(opt)
        })
      }

      renderRolesGrid(data.roles || [], data.agents || [])
      renderMultiTests(data.multiTests || [])
      refreshVpsSystemStorage()
    } catch (err) {
      sysEl.textContent = 'Hiba: ' + err.message
    }
  }

  function formatBytesUi(bytes) {
    const n = Number(bytes || 0)
    if (!Number.isFinite(n) || n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let val = n
    let idx = 0
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024
      idx += 1
    }
    return (val >= 10 || idx === 0 ? val.toFixed(idx === 0 ? 0 : 1) : val.toFixed(2)) + ' ' + units[idx]
  }

  function renderVpsSystemStorage(system) {
    const badgeEl = document.getElementById('vpsStorageHealthBadge')
    const barsEl = document.getElementById('vpsStorageBars')
    const dirsEl = document.getElementById('vpsStorageDirs')
    if (!barsEl || !dirsEl || !system) return

    const health = system.health || { overallLevel: 'ok' }
    const thresholds = system.thresholds || { memWarnPct: 85, diskWarnPct: 80, diskCritPct: 90 }
    if (badgeEl) {
      if (health.overallLevel === 'crit') {
        badgeEl.textContent = 'KRITIKUS'
        badgeEl.style.background = '#dc2626'
      } else if (health.overallLevel === 'warn') {
        badgeEl.textContent = 'FIGYELMEZTETÉS'
        badgeEl.style.background = '#d97706'
      } else {
        badgeEl.textContent = 'OK'
        badgeEl.style.background = '#16a34a'
      }
    }

    function renderBarCard(title, usedPct, subtitle, warnPct, critPct) {
      const pct = Math.max(0, Math.min(100, Number(usedPct || 0)))
      const color =
        critPct && pct >= critPct ? '#dc2626' : pct >= (warnPct || 85) ? '#d97706' : '#16a34a'
      return (
        '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);display:flex;flex-direction:column;gap:6px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;gap:6px">' +
        '<strong>' + esc(title) + '</strong>' +
        '<span style="font-weight:700;color:' + color + '">' + esc(pct.toFixed(1)) + '%</span>' +
        '</div>' +
        '<div style="height:8px;border-radius:999px;background:rgba(128,128,128,0.2);overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:999px;transition:width .25s ease"></div>' +
        '</div>' +
        '<div style="font-size:11px;opacity:.8">' + esc(subtitle) + '</div>' +
        '</div>'
      )
    }

    const m = system.memory || {}
    const cards = []
    cards.push(
      renderBarCard(
        'RAM & Node RSS',
        m.usedPct || 0,
        (m.usedMb || 0) + ' / ' + (m.totalMb || 0) + ' MB (szabad: ' + (m.availMb || 0) + ' MB · Node RSS: ' + (m.processRssMb || 0) + ' MB)',
        thresholds.memWarnPct,
        95,
      ),
    )

    if ((m.swapTotalMb || 0) > 0) {
      cards.push(
        renderBarCard(
          'Swap memória',
          m.swapUsedPct || 0,
          (m.swapUsedMb || 0) + ' / ' + (m.swapTotalMb || 0) + ' MB (szabad: ' + (m.swapFreeMb || 0) + ' MB)',
          80,
          95,
        ),
      )
    }

    ;(system.partitions || []).forEach(function (p) {
      cards.push(
        renderBarCard(
          'SSD (' + (p.mountpoint || '/') + ')',
          p.usedPct || 0,
          formatBytesUi(p.usedBytes) + ' / ' + formatBytesUi(p.sizeBytes) + ' (szabad: ' + formatBytesUi(p.availBytes) + ')',
          thresholds.diskWarnPct,
          thresholds.diskCritPct,
        ),
      )
    })

    barsEl.innerHTML = cards.join('')

    const dirs = system.directories || []
    dirsEl.innerHTML = dirs
      .map(function (d) {
        const walExtra =
          d.key === 'store' && d.walBytes != null
            ? ' <span style="opacity:.75">(DB: ' + esc(formatBytesUi(d.dbBytes || 0)) + ' · WAL: ' + esc(formatBytesUi(d.walBytes || 0)) + ')</span>'
            : ''
        return (
          '<span style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">' +
          '<code>' + esc(d.label) + '</code>: <b>' + esc(formatBytesUi(d.bytes)) + '</b>' +
          walExtra +
          '</span>'
        )
      })
      .join('')
  }

  async function refreshVpsSystemStorage() {
    const barsEl = document.getElementById('vpsStorageBars')
    if (!barsEl) return
    try {
      const data = await apiJson('/api/admin/system')
      if (data && data.system) {
        renderVpsSystemStorage(data.system)
      }
    } catch (err) {
      barsEl.innerHTML = '<div style="font-size:12px;color:#dc2626">Telemetria hiba: ' + esc(err.message) + '</div>'
    }
  }

  async function runVpsSystemCleanup() {
    const btn = document.getElementById('vpsRunCleanupBtn')
    const statusEl = document.getElementById('vpsStorageCleanupStatus')
    if (btn) btn.disabled = true
    if (statusEl) {
      statusEl.hidden = false
      statusEl.textContent = 'Housekeeping & SQLite WAL checkpoint futtatása...'
    }
    try {
      const data = await apiJson('/api/admin/system/cleanup', {
        method: 'POST',
        body: '{}',
      })
      if (data.system) {
        renderVpsSystemStorage(data.system)
      }
      const c = data.cleanup || {}
      const walBytes = c.walCheckpoint ? c.walCheckpoint.walReclaimedBytes || 0 : 0
      if (statusEl) {
        statusEl.textContent =
          '✓ Takarítás kész: felszabadítva ' +
          formatBytesUi(c.totalReclaimedBytes || 0) +
          ' (' +
          (c.deletedFilesCount || 0) +
          ' régi fájl törölve · SQLite WAL: ' +
          formatBytesUi(walBytes) +
          (c.npmCacheCleaned ? ' · npm cache ürítve' : '') +
          ').'
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = '✕ Takarítási hiba: ' + err.message
      }
    } finally {
      if (btn) btn.disabled = false
    }
  }

  function renderMultiTests(items) {
    const listEl = document.getElementById('vpsMultiTestList')
    if (!listEl) return
    if (!items || items.length === 0) {
      listEl.innerHTML = ''
      return
    }
    listEl.innerHTML = items
      .map(function (t) {
        return (
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);font-size:12px">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<strong>' + esc(t.branch) + '</strong>' +
          '<a href="' + esc(t.accessUrl || ('https://' + t.host)) + '" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">' + esc(t.host) + ' ↗</a>' +
          '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:' + badgeColor(t.active) + '">core: ' + esc(t.active) + '</span>' +
          '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:' + badgeColor(t.webActive) + '">web: ' + esc(t.webActive) + '</span>' +
          '</div>' +
          '<div style="display:flex;gap:6px">' +
          '<button class="btn-secondary btn-compact" data-multi-ops="reload-test" data-branch="' + esc(t.branch) + '">Reload</button>' +
          '<button class="btn-secondary btn-compact" data-multi-ops="teardown-test" data-branch="' + esc(t.branch) + '">Teardown</button>' +
          '</div>' +
          '</div>'
        )
      })
      .join('')

    listEl.querySelectorAll('[data-multi-ops]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runOpsAction(btn.getAttribute('data-multi-ops'), btn.getAttribute('data-branch'), btn)
      })
    })
  }

  async function runOpsAction(action, branch, btn) {
    const outEl = document.getElementById('vpsOpsOutput')
    if (btn) btn.disabled = true
    if (outEl) {
      outEl.hidden = false
      outEl.textContent = 'Futtatás: ' + action + (branch ? ' (' + branch + ')' : '') + '...'
    }
    try {
      const data = await apiJson('/api/vps/ops', {
        method: 'POST',
        body: JSON.stringify({ action: action, branch: branch || undefined }),
      })
      if (outEl) outEl.textContent = data.output || 'Kész.'
      refreshVpsStatus()
    } catch (err) {
      if (outEl) outEl.textContent = 'Hiba: ' + err.message
    } finally {
      if (btn) btn.disabled = false
    }
  }

  let vpsRolesCache = []
  let vpsAgentsCache = []
  let vpsGlobalCache = null
  let currentModalAgentId = null

  async function ensureVpsRolesData(force) {
    if (!force && vpsRolesCache.length > 0 && vpsAgentsCache.length > 0) return
    const data = await apiJson('/api/vps/status')
    vpsRolesCache = data.roles || []
    vpsAgentsCache = data.agents || []
    vpsGlobalCache = data.global || null
    const chatSelect = document.getElementById('vpsChatAgent')
    if (chatSelect && chatSelect.options.length === 0) {
      vpsAgentsCache.forEach(function (a) {
        const opt = document.createElement('option')
        opt.value = a.id
        opt.textContent = a.id + ' (' + (a.role || '') + ' · ' + a.model + ')'
        chatSelect.appendChild(opt)
      })
    }
  }

  function applyDisplayNamesToCards() {
    if (!vpsAgentsCache || vpsAgentsCache.length === 0) return
    const map = {}
    vpsAgentsCache.forEach(function (a) {
      if (a.displayName && a.displayName !== a.id) map[a.id.toLowerCase()] = a.displayName
    })
    document.querySelectorAll('#agentsGridView .agent-card, #agentsPage [data-agent]').forEach(function (card) {
      const id = (card.getAttribute('data-agent') || card.getAttribute('data-agent-name') || '').toLowerCase()
      const nameEl = card.querySelector('.agent-card-name, .agent-name, h3')
      if (!nameEl) return
      const key = id || (nameEl.textContent || '').trim().toLowerCase()
      if (map[key]) nameEl.textContent = map[key]
    })
  }

  let vpsGlobalWired = false
  function renderGlobalConfigBar() {
    const budgetInp = document.getElementById('vpsGlobalBudgetInp')
    const provSel = document.getElementById('vpsGlobalProvSel')
    const modelSel = document.getElementById('vpsGlobalModelSel')
    const saveBtn = document.getElementById('vpsGlobalSaveBtn')
    const statusEl = document.getElementById('vpsGlobalStatus')
    if (!budgetInp || !provSel || !modelSel || !vpsGlobalCache) return
    budgetInp.value = String(vpsGlobalCache.dailyBudgetUsd ?? 15)
    provSel.innerHTML = PROVIDER_OPTIONS.map(function (p) {
      return '<option value="' + p + '"' + (p === vpsGlobalCache.defaultProvider ? ' selected' : '') + '>' + p + '</option>'
    }).join('')
    function fillGlobalModels(prov, curModel) {
      const list = getModelsForProvider(prov)
      const all = curModel && list.indexOf(curModel) < 0 ? [curModel].concat(list) : list
      modelSel.innerHTML = all.filter(Boolean).map(function (m) {
        return '<option value="' + esc(m) + '"' + (m === curModel ? ' selected' : '') + '>' + esc(m) + '</option>'
      }).join('')
    }
    fillGlobalModels(vpsGlobalCache.defaultProvider || 'deepseek', vpsGlobalCache.defaultModel || '')
    if (!vpsGlobalWired) {
      vpsGlobalWired = true
      provSel.addEventListener('change', function () {
        fillGlobalModels(provSel.value, '')
      })
      if (saveBtn) {
        saveBtn.addEventListener('click', async function () {
          const bVal = Number(budgetInp.value)
          saveBtn.disabled = true
          if (statusEl) statusEl.textContent = 'Mentés...'
          try {
            const res = await apiJson('/api/vps/global-config', {
              method: 'POST',
              body: JSON.stringify({
                dailyBudgetUsd: Number.isFinite(bVal) ? bVal : null,
                defaultProvider: provSel.value,
                defaultModel: modelSel.value,
              }),
            })
            vpsGlobalCache = res.global || vpsGlobalCache
            if (statusEl) statusEl.textContent = 'Globális beállítások mentve!'
            refreshVpsStatus()
          } catch (err) {
            if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
          } finally {
            saveBtn.disabled = false
          }
        })
      }
    }
  }

  window.loadAgentsRoles = async function () {
    try {
      await Promise.all([ensureVpsRolesData(true), ensureModelCatalog(false)])
      renderRolesGrid(vpsRolesCache, vpsAgentsCache)
      renderGlobalConfigBar()
      applyDisplayNamesToCards()
      setTimeout(applyDisplayNamesToCards, 500)
    } catch { /* ignore */ }
  }

  const API_PROVIDER_OPTIONS = ['deepseek', 'vertex-eu', 'gemini', 'xai', 'openai']

  const PROVIDER_MODELS = {
    'claude-cli': ['default', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    'codex-cli': ['default', 'gpt-5-codex', 'o3', 'o4-mini', 'gpt-4.1'],
    'agy-cli': [
      'default',
      'gemini-4-neon-high',
      'gemini-4-neon-medium',
      'gemini-4-argon-high',
      'gemini-4-argon-medium',
      'gemini-4-hydrogen-high',
      'gemini-3.8-flash-high',
    ],
    'gemini-cli': ['default', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    'vertex-eu': ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    xai: ['grok-3', 'grok-3-mini', 'grok-4'],
    openai: ['gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'],
  }

  let vpsModelCatalogCache = null
  let vpsModelSyncedAt = null
  let vpsDiscordGuildsCache = []
  const coreFileDirty = { claude: false, soul: false, mcp: false }

  function getModelsForProvider(provider) {
    const entry = vpsModelCatalogCache && vpsModelCatalogCache[provider]
    if (entry && Array.isArray(entry.models) && entry.models.length > 0) return entry.models
    return PROVIDER_MODELS[provider] || []
  }

  const CATALOG_PROVIDER_META = {
    deepseek: { key: 'DEEPSEEK_API_KEY', placeholder: 'DeepSeek API kulcs (sk-...)', secret: true },
    'vertex-eu': { key: 'VERTEX_PROJECT_ID', placeholder: 'GCP Project ID (pl. alferd-hq-gc)', secret: false },
    gemini: { key: 'GEMINI_API_KEY', placeholder: 'Gemini API kulcs (AIza...)', secret: true },
    xai: { key: 'XAI_API_KEY', placeholder: 'xAI API kulcs (xai-...)', secret: true },
    openai: { key: 'OPENAI_API_KEY', placeholder: 'OpenAI API kulcs (sk-...)', secret: true },
  }

  function renderModelCatalog() {
    const grid = document.getElementById('vpsModelCatalogGrid')
    const syncedEl = document.getElementById('vpsModelCatalogSyncedAt')
    const statusEl = document.getElementById('vpsModelCatalogStatus')
    if (syncedEl) {
      syncedEl.textContent = vpsModelSyncedAt
        ? ('Utolsó szinkron: ' + vpsModelSyncedAt.slice(0, 19).replace('T', ' ') + ' UTC')
        : 'Még nem volt API szinkron (alapértelmezett lista)'
    }
    if (!grid || !vpsModelCatalogCache) return
    grid.innerHTML = API_PROVIDER_OPTIONS.map(function (p) {
      const info = vpsModelCatalogCache[p] || { configured: false, models: PROVIDER_MODELS[p] || [] }
      const meta = CATALOG_PROVIDER_META[p] || { key: '', placeholder: 'API kulcs...', secret: true }
      const badge = info.configured
        ? '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:#16a34a">API aktív</span>'
        : '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:#6b7280">nincs kulcs</span>'
      const errHtml = info.error ? '<div style="font-size:11px;color:#dc2626">Hiba: ' + esc(info.error) + '</div>' : ''
      const preview = (info.models || []).slice(0, 5).map(esc).join(', ') + ((info.models || []).length > 5 ? ' …' : '')
      return (
        '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);display:flex;flex-direction:column;gap:6px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + esc(p) + '</strong>' + badge + '</div>' +
        '<div style="font-size:11px;opacity:.75">' + (info.models || []).length + ' modell</div>' +
        '<div style="font-size:11px;font-family:monospace;opacity:.8;word-break:break-word;flex:1">' + (preview || '—') + '</div>' +
        errHtml +
        '<div style="display:flex;gap:4px;margin-top:2px">' +
        '<input type="' + (meta.secret ? 'password' : 'text') + '" class="input" data-cat-key="' + esc(meta.key) + '" placeholder="' + esc(meta.placeholder) + '" autocomplete="off" style="flex:1;min-width:0;padding:4px 6px;font-size:11px">' +
        '<button type="button" class="btn-secondary btn-compact" data-cat-save="' + esc(p) + '" data-cat-env="' + esc(meta.key) + '" style="padding:4px 8px;font-size:11px">Mentés</button>' +
        '<button type="button" class="btn-secondary btn-compact" data-api-test="' + esc(p) + '" style="padding:4px 8px;font-size:11px"' + (info.configured ? '' : ' disabled') + '>Teszt</button>' +
        '</div>' +
        '<div data-api-test-result="' + esc(p) + '" hidden style="font-size:11px;padding:5px 7px;border-radius:6px;line-height:1.35;word-break:break-word"></div>' +
        '</div>'
      )
    }).join('')

    grid.querySelectorAll('[data-api-test]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const prov = btn.getAttribute('data-api-test')
        const outEl = grid.querySelector('[data-api-test-result="' + prov + '"]')
        if (!prov || !outEl) return
        btn.disabled = true
        outEl.hidden = false
        outEl.style.background = 'var(--surface)'
        outEl.style.border = '1px solid var(--border)'
        outEl.style.color = 'inherit'
        outEl.textContent = 'Kapcsolat tesztelése...'
        try {
          const res = await fetch('/api/admin/providers/' + encodeURIComponent(prov) + '/test', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
          const data = await res.json().catch(function () { return {} })
          if (res.ok && data.ok) {
            outEl.style.background = 'rgba(22,163,74,0.12)'
            outEl.style.border = '1px solid #16a34a'
            outEl.style.color = '#15803d'
            outEl.textContent = '✓ OK (' + data.latencyMs + ' ms) · ' + (data.model || '') + ' · válasz: ' + (data.reply || 'OK')
          } else {
            outEl.style.background = 'rgba(220,38,38,0.12)'
            outEl.style.border = '1px solid #dc2626'
            outEl.style.color = '#dc2626'
            outEl.textContent = '✕ Hiba' + (data.latencyMs ? ' (' + data.latencyMs + ' ms)' : '') + ': ' + (data.error || ('HTTP ' + res.status))
          }
        } catch (err) {
          outEl.style.background = 'rgba(220,38,38,0.12)'
          outEl.style.border = '1px solid #dc2626'
          outEl.style.color = '#dc2626'
          outEl.textContent = '✕ Hiba: ' + err.message
        } finally {
          btn.disabled = false
        }
      })
    })

    grid.querySelectorAll('[data-cat-save]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const prov = btn.getAttribute('data-cat-save')
        const envKey = btn.getAttribute('data-cat-env')
        const inp = grid.querySelector('[data-cat-key="' + envKey + '"]')
        const val = inp ? inp.value.trim() : ''
        if (!envKey || !val) {
          if (statusEl) statusEl.textContent = 'Adj meg egy kulcsot a(z) ' + prov + ' mezőben!'
          return
        }
        btn.disabled = true
        if (statusEl) statusEl.textContent = prov + ' kulcs mentése és modellek szinkronizálása...'
        try {
          const payload = {}
          payload[envKey] = val
          await apiJson('/api/onboarding/providers', {
            method: 'POST',
            body: JSON.stringify({ providers: payload }),
          })
          const synced = await apiJson('/api/vps/models/sync', { method: 'POST', body: '{}' })
          vpsModelCatalogCache = synced.providers || null
          vpsModelSyncedAt = synced.syncedAt || null
          renderModelCatalog()
          if (statusEl) statusEl.textContent = prov + ' kulcs elmentve és modellek frissítve!'
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
        } finally {
          btn.disabled = false
        }
      })
    })
  }

  async function ensureModelCatalog(force) {
    if (!force && vpsModelCatalogCache) {
      renderModelCatalog()
      return
    }
    try {
      const data = await apiJson('/api/vps/models')
      vpsModelCatalogCache = data.providers || null
      vpsModelSyncedAt = data.syncedAt || null
      renderModelCatalog()
    } catch { /* fallback to defaults */ }
  }

  function updateInheritedRoleText() {
    const roleSel = document.getElementById('agentCoreRoleSel')
    const txtEl = document.getElementById('agentCoreInheritedText')
    if (!roleSel || !txtEl) return
    const r = vpsRolesCache.find(function (item) { return item.id === roleSel.value })
    txtEl.textContent = r ? ('Örökölt modell: ' + r.provider + ' / ' + r.model) : ''
  }

  function populateCoreModelSelect(provider, currentModel) {
    const modelSel = document.getElementById('agentCoreModelSel')
    const modelInp = document.getElementById('agentCoreModelInp')
    if (!modelSel || !modelInp) return
    const list = getModelsForProvider(provider)
    modelSel.innerHTML =
      list.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>' }).join('') +
      '<option value="__custom__">Egyéni modell...</option>'
    if (currentModel && list.indexOf(currentModel) >= 0) {
      modelSel.value = currentModel
      modelInp.hidden = true
      modelInp.value = currentModel
    } else if (currentModel) {
      modelSel.value = '__custom__'
      modelInp.hidden = false
      modelInp.value = currentModel
    } else if (list.length > 0) {
      modelSel.value = list[0]
      modelInp.hidden = true
      modelInp.value = list[0]
    } else {
      modelSel.value = '__custom__'
      modelInp.hidden = false
      modelInp.value = ''
    }
  }

  function applyCoreOverview(ag) {
    const titleEl = document.getElementById('agentDetailTitle')
    const nameEl = document.getElementById('agentDetailName')
    const descEl = document.getElementById('agentDetailDesc')
    const modelEl = document.getElementById('agentDetailModel')
    const chEl = document.getElementById('agentDetailChStatus')
    const ctxEl = document.getElementById('agentDetailContext')
    const coreBar = document.getElementById('agentCoreStatusBar')
    const coreTxt = document.getElementById('agentCoreStatusText')
    const procBar = document.getElementById('agentProcessControl')
    const shownName = ag.displayName || ag.id
    if (titleEl) titleEl.textContent = shownName
    if (nameEl) nameEl.textContent = shownName
    if (descEl && ag.displayName && ag.displayName !== ag.id) descEl.textContent = ag.id
    if (modelEl) {
      modelEl.textContent = ag.provider + ' / ' + ag.model + (ag.hasOverride ? ' (egyedi)' : ' (munkakör)')
    }
    if (chEl) {
      chEl.innerHTML = '<span class="tg-status"><span class="tg-dot connected"></span>' + esc(ag.channelName || '—') + '</span>'
    }
    if (ctxEl) {
      ctxEl.textContent = '$' + Number(ag.dailyBudgetUsd || 0).toFixed(2) + ' / nap · ' + (ag.tools ? ag.tools.length : 0) + ' eszköz'
    }
    const skillCntEl = document.getElementById('agentDetailSkillCount')
    if (skillCntEl) {
      skillCntEl.textContent = String(Array.isArray(ag.skills) ? ag.skills.length : 0)
    }
    if (coreBar) {
      coreBar.hidden = false
      coreBar.style.display = 'flex'
    }
    if (coreTxt) {
      const r = vpsRolesCache.find(function (item) { return item.id === ag.role })
      coreTxt.textContent = 'Alfred Core aktív · ' + (r ? r.label : (ag.role || '—'))
    }
    if (procBar) { procBar.hidden = true; procBar.style.display = 'none' }
  }

  function restoreLegacyModal() {
    const box = document.getElementById('agentCoreOverrideBox')
    const metaBox = document.getElementById('agentCoreMetaBox')
    const legacyWrap = document.getElementById('legacyAgentSettingsWrap')
    const saveBar = document.getElementById('agentSettingsSaveBar')
    const coreBar = document.getElementById('agentCoreStatusBar')
    const procBar = document.getElementById('agentProcessControl')
    const coreCh = document.getElementById('agentCoreChannelBox')
    const coreSkills = document.getElementById('agentCoreSkillsBox')
    const legacySkills = document.getElementById('legacySkillsWrap')
    if (box) { box.hidden = true; box.style.display = 'none' }
    if (metaBox) { metaBox.hidden = true; metaBox.style.display = 'none' }
    if (legacyWrap) legacyWrap.hidden = false
    if (saveBar) { saveBar.hidden = true; saveBar.style.display = 'none' }
    if (coreBar) { coreBar.hidden = true; coreBar.style.display = 'none' }
    if (procBar) { procBar.hidden = false; procBar.style.display = '' }
    if (coreCh) { coreCh.hidden = true; coreCh.style.display = 'none' }
    if (coreSkills) { coreSkills.hidden = true; coreSkills.style.display = 'none' }
    if (legacySkills) legacySkills.hidden = false
      ;['saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'agentClaudeMdDetails', 'agentMcpJsonDetails'].forEach(function (id) {
        const b = document.getElementById(id)
        if (b) b.hidden = false
      })
  }

  window.syncAgentCoreOverride = async function (agentName) {
    const box = document.getElementById('agentCoreOverrideBox')
    const metaBox = document.getElementById('agentCoreMetaBox')
    const legacyWrap = document.getElementById('legacyAgentSettingsWrap')
    const saveBar = document.getElementById('agentSettingsSaveBar')
    const chk = document.getElementById('agentCoreOverrideChk')
    const ovRow = document.getElementById('agentCoreOverrideRow')
    const roleSel = document.getElementById('agentCoreRoleSel')
    const provSel = document.getElementById('agentCoreProvSel')
    const budgetInp = document.getElementById('agentCoreBudgetInp')
    const displayNameInp = document.getElementById('agentCoreDisplayNameInp')
    const personaBox = document.getElementById('agentCorePersonaSuggestions')
    const toolsList = document.getElementById('agentCoreToolsList')
    const statusEl = document.getElementById('agentSettingsSaveStatus')
    const coreCh = document.getElementById('agentCoreChannelBox')
    const coreChCur = document.getElementById('agentCoreChannelCurrent')
    const dcChanInp = document.getElementById('agentDcChanName')
    if (!box || !chk || !ovRow || !roleSel || !provSel) return
    try {
      await Promise.all([ensureVpsRolesData(false), ensureModelCatalog(false)])
    } catch {
      restoreLegacyModal()
      return
    }
    const ag = vpsAgentsCache.find(function (a) { return a.id === agentName })
    if (!ag) {
      restoreLegacyModal()
      currentModalAgentId = null
      return
    }
    currentModalAgentId = ag.id
    coreFileDirty.claude = false
    coreFileDirty.soul = false
    coreFileDirty.mcp = false

    box.hidden = false
    box.style.display = 'flex'
    if (metaBox) { metaBox.hidden = false; metaBox.style.display = 'flex' }
    if (legacyWrap) legacyWrap.hidden = true
    if (saveBar) { saveBar.hidden = false; saveBar.style.display = 'flex' }
    if (statusEl) statusEl.textContent = ''
      ;['saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'agentClaudeMdDetails', 'agentMcpJsonDetails'].forEach(function (id) {
        const b = document.getElementById(id)
        if (b) b.hidden = true
      })

    roleSel.innerHTML = vpsRolesCache
      .map(function (r) {
        return '<option value="' + esc(r.id) + '"' + (r.id === ag.role ? ' selected' : '') + '>' + esc(r.label) + '</option>'
      })
      .join('')
    updateInheritedRoleText()
    provSel.innerHTML = PROVIDER_OPTIONS.map(function (p) {
      return '<option value="' + p + '"' + (p === ag.provider ? ' selected' : '') + '>' + p + '</option>'
    }).join('')
    populateCoreModelSelect(ag.provider, ag.model || '')
    chk.checked = Boolean(ag.hasOverride)
    ovRow.hidden = !chk.checked
    ovRow.style.display = chk.checked ? 'flex' : 'none'

    if (budgetInp) budgetInp.value = String(ag.dailyBudgetUsd ?? 2)
    const voiceSel = document.getElementById('agentCoreVoiceSel')
    if (voiceSel) voiceSel.value = ag.voice || 'Kore'
    if (displayNameInp) displayNameInp.value = ag.displayName || ag.id
    if (personaBox) { personaBox.hidden = true; personaBox.style.display = 'none'; personaBox.innerHTML = '' }
    if (toolsList) {
      const activeTools = new Set(Array.isArray(ag.tools) ? ag.tools : [])
      const allTools = [
        { id: 'fs_read', label: 'Fájl olvasás', hint: 'Fájlok olvasása a workspace-ben (fs_read)' },
        { id: 'fs_write', label: 'Fájl írás', hint: 'Fájlok létrehozása és módosítása (fs_write)' },
        { id: 'bash', label: 'Terminál (bash)', hint: 'Parancssori parancsok futtatása (bash)' },
        { id: 'git', label: 'Git', hint: 'Git műveletek: branch, commit stb. (git)' },
        { id: 'memory', label: 'Memória', hint: 'Hosszú távú memória olvasása és mentése (memory)' },
      ]
      toolsList.innerHTML = allTools.map(function (t) {
        const checked = activeTools.has(t.id) ? ' checked' : ''
        return (
          '<label title="' + esc(t.hint) + '" style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:12px;border:1px solid var(--border);background:var(--surface);cursor:pointer;user-select:none;margin:0">' +
          '<input type="checkbox" data-core-tool-chk="' + esc(t.id) + '"' + checked + ' style="margin:0">' +
          '<span>' + esc(t.label) + '</span>' +
          '</label>'
        )
      }).join('')
    }
    const sysPromptInp = document.getElementById('agentCoreSystemPromptInp')
    const wsInp = document.getElementById('agentCoreWorkspaceInp')
    const memNsInp = document.getElementById('agentCoreMemNsInp')
    const maxIterInp = document.getElementById('agentCoreMaxIterInp')
    const bashToInp = document.getElementById('agentCoreBashTimeoutInp')
    const allowedUsersInp = document.getElementById('agentCoreAllowedUsersInp')
    const protPathsInp = document.getElementById('agentCoreProtectedPathsInp')
    const allowedBashInp = document.getElementById('agentCoreAllowedBashInp')
    if (sysPromptInp) sysPromptInp.value = ag.systemPrompt || ''
    if (wsInp) wsInp.value = ag.workspace || ''
    if (memNsInp) memNsInp.value = ag.memoryNamespace || ''
    if (maxIterInp) maxIterInp.value = ag.maxToolIterations != null ? String(ag.maxToolIterations) : ''
    if (bashToInp) bashToInp.value = ag.bashTimeoutMs != null ? String(ag.bashTimeoutMs) : ''
    if (allowedUsersInp) allowedUsersInp.value = Array.isArray(ag.allowedUserIds) ? ag.allowedUserIds.join(', ') : ''
    if (protPathsInp) protPathsInp.value = Array.isArray(ag.protectedPaths) ? ag.protectedPaths.join('\n') : ''
    if (allowedBashInp) allowedBashInp.value = Array.isArray(ag.allowedBashCommands) ? ag.allowedBashCommands.join('\n') : ''

    if (coreCh) {
      coreCh.hidden = false
      coreCh.style.display = 'flex'
    }
    if (coreChCur) {
      coreChCur.textContent = 'Aktuális csatorna: ' + (ag.channelName || 'nincs hozzárendelve')
    }
    if (dcChanInp) {
      dcChanInp.value = ag.id.toLowerCase().replace(/[^a-z0-9-_]+/g, '-')
    }

    // Apply overview immediately and once more after app.js finishes its async agent fetch
    applyCoreOverview(ag)
    loadCoreSkillsForModal(ag.id)
    markAgentModalClean()
    setTimeout(function () {
      if (currentModalAgentId === ag.id) {
        applyCoreOverview(ag)
        markAgentModalClean()
      }
    }, 350)
  }

  function markAgentModalClean() {
    const ov = document.getElementById('agentDetailOverlay')
    if (!ov || !ov._openValues) return
    ov.querySelectorAll('input, textarea').forEach(function (el) {
      ov._openValues.set(el, el.value)
    })
  }

  let coreSkillsCache = []

  async function loadCoreSkillsForModal(agentId) {
    const coreSkills = document.getElementById('agentCoreSkillsBox')
    const legacySkills = document.getElementById('legacySkillsWrap')
    const listEl = document.getElementById('coreSkillsList')
    const statusEl = document.getElementById('coreSkillsStatus')
    if (!coreSkills || !listEl) return
    coreSkills.hidden = false
    coreSkills.style.display = 'flex'
    if (legacySkills) legacySkills.hidden = true
    if (statusEl) statusEl.textContent = ''
    try {
      const data = await apiJson('/api/vps/skills?agentId=' + encodeURIComponent(agentId))
      coreSkillsCache = data.skills || []
      if (coreSkillsCache.length === 0) {
        listEl.innerHTML = '<div style="font-size:12px;opacity:.65">Még nincs globális skill. Hozz létre egyet lent az AI varázslóval!</div>'
        return
      }
      listEl.innerHTML = coreSkillsCache
        .map(function (s) {
          const usageBadge = s.usageCount > 0
            ? '<span style="font-size:11px;opacity:.7;margin-left:6px">(' + s.usageCount + '× használva)</span>'
            : ''
          return (
            '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
            '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;margin:0">' +
            '<input type="checkbox" data-core-skill-chk="' + esc(s.id) + '"' + (s.enabled ? ' checked' : '') + ' style="margin-top:3px">' +
            '<div><div style="font-size:13px;font-weight:600">' + esc(s.id) + usageBadge + '</div>' +
            '<div style="font-size:12px;opacity:.8;margin-top:2px">' + esc(s.description || '—') + '</div></div>' +
            '</label>' +
            '<div style="display:flex;gap:4px;flex-shrink:0">' +
            '<button type="button" class="btn-secondary btn-compact" data-core-skill-edit="' + esc(s.id) + '" style="font-size:11px;padding:3px 7px">Szerkeszt</button>' +
            '<button type="button" class="btn-secondary btn-compact" data-core-skill-del="' + esc(s.id) + '" style="font-size:11px;padding:3px 7px;color:#dc2626">×</button>' +
            '</div>' +
            '</div>'
          )
        })
        .join('')

      listEl.querySelectorAll('[data-core-skill-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const id = btn.getAttribute('data-core-skill-edit')
          const sk = coreSkillsCache.find(function (x) { return x.id === id })
          if (!sk) return
          const det = document.getElementById('coreSkillEditorDetails')
          if (det) det.open = true
          const idInp = document.getElementById('coreSkillIdInp')
          const descInp = document.getElementById('coreSkillDescInp')
          const contInp = document.getElementById('coreSkillContentInp')
          if (idInp) idInp.value = sk.id
          if (descInp) descInp.value = sk.description || ''
          if (contInp) contInp.value = sk.content || ''
        })
      })

      listEl.querySelectorAll('[data-core-skill-del]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const id = btn.getAttribute('data-core-skill-del')
          if (!id || !confirm('Biztosan törlöd a "' + id + '" skillt?')) return
          try {
            await apiJson('/api/vps/skills?id=' + encodeURIComponent(id), { method: 'DELETE' })
            if (statusEl) statusEl.textContent = 'Törölve: ' + id
            await ensureVpsRolesData(true)
            if (currentModalAgentId) loadCoreSkillsForModal(currentModalAgentId)
          } catch (err) {
            if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
          }
        })
      })
    } catch (err) {
      listEl.innerHTML = '<div style="font-size:12px;color:#dc2626">Hiba: ' + esc(err.message) + '</div>'
    }
  }

  const PROVIDER_OPTIONS = [
    'claude-cli',
    'codex-cli',
    'agy-cli',
    'gemini-cli',
    'deepseek',
    'vertex-eu',
    'gemini',
    'xai',
    'openai',
  ]

  function renderRolesGrid(roles, agents) {
    const grid = document.getElementById('vpsRolesGrid')
    const statusEl = document.getElementById('vpsRolesStatus')
    if (!grid) return
    grid.innerHTML = roles
      .map(function (r) {
        const assigned = agents
          .filter(function (a) { return a.role === r.id })
          .map(function (a) { return a.id })
          .join(', ')
        const opts = PROVIDER_OPTIONS.map(function (p) {
          return '<option value="' + p + '"' + (p === r.provider ? ' selected' : '') + '>' + p + '</option>'
        }).join('')
        const modelList = getModelsForProvider(r.provider)
        const allModels = modelList.indexOf(r.model) >= 0 ? modelList : [r.model].concat(modelList)
        const modelOpts = allModels.filter(Boolean).map(function (m) {
          return '<option value="' + esc(m) + '"' + (m === r.model ? ' selected' : '') + '>' + esc(m) + '</option>'
        }).join('')
        return (
          '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);display:flex;flex-direction:column;gap:6px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + esc(r.label) + '</strong><span style="font-size:11px;opacity:.6">' + esc(r.id) + '</span></div>' +
          '<div style="font-size:11px;opacity:.75">' + esc(r.description) + '</div>' +
          '<div style="font-size:11px;opacity:.8"><b>Ágensek:</b> ' + esc(assigned || '—') + '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<select class="input" data-role-provider="' + esc(r.id) + '" style="padding:4px 6px;font-size:12px">' + opts + '</select>' +
          '<select class="input" data-role-model="' + esc(r.id) + '" style="flex:1;min-width:120px;padding:4px 6px;font-size:12px">' + modelOpts + '</select>' +
          '<button class="btn-primary btn-compact" data-role-save="' + esc(r.id) + '">Mentés</button>' +
          '</div>' +
          '</div>'
        )
      })
      .join('')

    grid.querySelectorAll('[data-role-provider]').forEach(function (provEl) {
      provEl.addEventListener('change', function () {
        const roleId = provEl.getAttribute('data-role-provider')
        const modEl = grid.querySelector('[data-role-model="' + roleId + '"]')
        if (!modEl) return
        const models = getModelsForProvider(provEl.value)
        modEl.innerHTML = models.map(function (m) {
          return '<option value="' + esc(m) + '">' + esc(m) + '</option>'
        }).join('')
      })
    })

    grid.querySelectorAll('[data-role-save]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const roleId = btn.getAttribute('data-role-save')
        const provEl = grid.querySelector('[data-role-provider="' + roleId + '"]')
        const modEl = grid.querySelector('[data-role-model="' + roleId + '"]')
        if (!provEl || !modEl) return
        btn.disabled = true
        if (statusEl) statusEl.textContent = 'Mentés...'
        try {
          await apiJson('/api/vps/roles', {
            method: 'POST',
            body: JSON.stringify({ role: roleId, provider: provEl.value, model: modEl.value.trim() }),
          })
          if (statusEl) statusEl.textContent = roleId + ' frissítve (' + provEl.value + ' / ' + modEl.value.trim() + ')'
          refreshVpsStatus()
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
        } finally {
          btn.disabled = false
        }
      })
    })
  }

  async function refreshVpsLogs() {
    const unitEl = document.getElementById('vpsLogUnit')
    const outEl = document.getElementById('vpsLogOutput')
    if (!unitEl || !outEl) return
    outEl.textContent = 'Betöltés...'
    try {
      const data = await apiJson('/api/vps/logs?unit=' + encodeURIComponent(unitEl.value) + '&lines=60')
      outEl.textContent = data.output || '(üres)'
    } catch (err) {
      outEl.textContent = 'Hiba: ' + err.message
    }
  }

  async function refreshConversations() {
    const envEl = document.getElementById('vpsConvEnv')
    const listEl = document.getElementById('vpsChatHistory')
    if (!envEl || !listEl) return
    try {
      const data = await apiJson('/api/vps/conversations?env=' + encodeURIComponent(envEl.value) + '&limit=30')
      const msgs = data.messages || []
      if (msgs.length === 0) {
        listEl.innerHTML = '<div style="opacity:.6;font-size:13px">Még nincs naplózott beszélgetés ebben a környezetben.</div>'
        return
      }
      listEl.innerHTML = msgs
        .map(function (m) {
          const isIn = m.direction === 'in'
          return (
            '<div style="padding:8px 10px;border-radius:8px;margin-bottom:8px;border:1px solid var(--border);background:' +
            (isIn ? 'var(--bg)' : 'var(--surface)') + '">' +
            '<div style="font-size:11px;opacity:.7;margin-bottom:4px">' +
            '<b>' + esc(isIn ? (m.sender_name || 'Felhasználó') : m.agent_id) + '</b>' +
            ' · ' + esc(m.source || '') + ' · ' + esc((m.ts || '').slice(0, 19).replace('T', ' ')) +
            '</div>' +
            '<div style="white-space:pre-wrap;font-size:13px;word-break:break-word">' + esc(m.text) + '</div>' +
            '</div>'
          )
        })
        .join('')
      listEl.scrollTop = listEl.scrollHeight
    } catch (err) {
      listEl.textContent = 'Hiba: ' + err.message
    }
  }

  async function sendVpsChat() {
    const agentEl = document.getElementById('vpsChatAgent')
    const inputEl = document.getElementById('vpsChatInput')
    const sendBtn = document.getElementById('vpsChatSend')
    const statusEl = document.getElementById('vpsChatStatus')
    if (!agentEl || !inputEl || !sendBtn) return
    const text = inputEl.value.trim()
    if (!text) return
    sendBtn.disabled = true
    if (statusEl) statusEl.textContent = 'Válasz generálása...'
    try {
      const res = await apiJson('/api/vps/chat', {
        method: 'POST',
        body: JSON.stringify({ agentId: agentEl.value, message: text }),
      })
      inputEl.value = ''
      if (statusEl) statusEl.textContent = res.model + ' · kész'
      await refreshConversations()
      if (vpsChatTtsEnabled && res.replyText) {
        speakAgentText(res.replyText, agentEl.value)
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
    } finally {
      sendBtn.disabled = false
    }
  }

  async function openModelApiWizard() {
    const overlay = document.getElementById('onboardingOverlay')
    const body = document.getElementById('onboardingBody')
    const steps = document.getElementById('onboardingSteps')
    const note = document.getElementById('onbFlowNote')
    if (!overlay || !body) return
    if (steps) { steps.hidden = true; steps.style.display = 'none' }
    if (note) note.textContent = 'Add meg vagy frissítsd a használt Model API kulcsokat (üresen hagyva a meglévő érték megmarad).'
    body.innerHTML = '<div style="padding:12px 0">Betöltés...</div>'
    overlay.hidden = false
    overlay.classList.add('active')
    document.body.style.overflow = 'hidden'
    try {
      const data = await apiJson('/api/onboarding/providers')
      const rows = (data.providers || [])
        .map(function (p) {
          const badge = p.configured
            ? '<span style="color:#22c55e;font-size:12px;font-weight:600">✓ Beállítva (' + esc(p.hint || '') + ')</span>'
            : '<span style="opacity:.6;font-size:12px">Nincs beállítva</span>'
          const link = p.url
            ? ' <a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" style="font-size:11px;text-decoration:underline;opacity:.85">Kulcs beszerzése ↗</a>'
            : ''
          return (
            '<div style="margin-bottom:10px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">' +
            '<div><label class="form-label-sm" style="margin:0">' + esc(p.label) + '</label>' + link + '</div>' +
            badge +
            '</div>' +
            '<input type="' + (p.secret ? 'password' : 'text') + '" class="onb-input" data-provider-key="' + esc(p.key) + '" placeholder="' + esc(p.placeholder) + '" autocomplete="off" style="margin-bottom:0">' +
            '</div>'
          )
        })
        .join('')
      body.innerHTML =
        '<div style="max-height:55vh;overflow:auto;padding-right:4px">' + rows + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;align-items:center">' +
        '<button class="btn-primary btn-compact" id="vpsSaveProvidersBtn">Kulcsok mentése</button>' +
        '<button class="btn-secondary btn-compact" id="vpsCloseProvidersBtn">Bezárás</button>' +
        '</div>' +
        '<div id="vpsProvidersMsg" class="onb-msg" style="margin-top:8px"></div>'

      const closeModal = function () {
        overlay.classList.remove('active')
        overlay.hidden = true
        if (steps) { steps.hidden = false; steps.style.display = '' }
        document.body.style.overflow = ''
      }
      document.getElementById('vpsCloseProvidersBtn')?.addEventListener('click', closeModal)
      document.getElementById('onboardingClose')?.addEventListener('click', closeModal, { once: true })
      document.getElementById('vpsSaveProvidersBtn')?.addEventListener('click', async function () {
        const btn = document.getElementById('vpsSaveProvidersBtn')
        const msgEl = document.getElementById('vpsProvidersMsg')
        const payload = {}
        body.querySelectorAll('[data-provider-key]').forEach(function (inp) {
          const val = inp.value.trim()
          if (val) payload[inp.getAttribute('data-provider-key')] = val
        })
        if (Object.keys(payload).length === 0) {
          if (msgEl) { msgEl.textContent = 'Adj meg legalább egy új vagy frissítendő értéket.'; msgEl.className = 'onb-msg err' }
          return
        }
        btn.disabled = true
        if (msgEl) { msgEl.textContent = 'Mentés...'; msgEl.className = 'onb-msg' }
        try {
          const res = await apiJson('/api/onboarding/providers', {
            method: 'POST',
            body: JSON.stringify({ providers: payload }),
          })
          await openModelApiWizard()
          const nextMsg = document.getElementById('vpsProvidersMsg')
          if (nextMsg) {
            nextMsg.textContent = 'Mentve: ' + (res.updated || []).join(', ') + ' (újraindítás után lép életbe a többi szolgáltatásban).'
            nextMsg.className = 'onb-msg ok'
          }
          ensureModelCatalog(true)
        } catch (err) {
          if (msgEl) { msgEl.textContent = 'Hiba: ' + err.message; msgEl.className = 'onb-msg err' }
        } finally {
          btn.disabled = false
        }
      })
    } catch (err) {
      body.innerHTML = '<div class="onb-msg err">Hiba: ' + esc(err.message) + '</div>'
    }
  }

  const cliLoginPollers = {}
  const cliLoginLastFingerprint = {}

  function stopCliLoginPoller(cliId) {
    if (cliLoginPollers[cliId]) {
      clearInterval(cliLoginPollers[cliId])
      delete cliLoginPollers[cliId]
    }
  }

  function renderCliLoginState(cliId, session) {
    const box = document.querySelector('[data-cli-login-box="' + cliId + '"]')
    if (!box) return
    if (!session || session.phase === 'cancelled') {
      delete cliLoginLastFingerprint[cliId]
      box.innerHTML = ''
      box.hidden = true
      return
    }
    const fp = JSON.stringify({
      active: Boolean(session.active),
      phase: session.phase || '',
      authUrl: session.authUrl || '',
      deviceCode: session.deviceCode || '',
      needsCodeInput: Boolean(session.needsCodeInput),
      message: session.message || '',
      error: session.error || '',
      outputTail: session.outputTail || '',
    })
    if (cliLoginLastFingerprint[cliId] === fp && !box.hidden) {
      return
    }
    const existingCodeVal = box.querySelector('[data-cli-login-code-inp="' + cliId + '"]')?.value || ''
    cliLoginLastFingerprint[cliId] = fp
    box.hidden = false
    let html = '<div style="font-size:11px;margin-bottom:6px;font-weight:600">' + esc(session.message || session.phase) + '</div>'
    if (session.authUrl) {
      html +=
        '<div style="margin-bottom:6px">' +
        '<a href="' + esc(session.authUrl) + '" target="_blank" rel="noopener noreferrer" class="btn-primary btn-compact" style="display:inline-block;padding:4px 10px;font-size:11px;text-decoration:none">OAuth oldal megnyitása ↗</a>' +
        '</div>'
    }
    if (session.deviceCode) {
      html +=
        '<div style="margin-bottom:6px;padding:6px 8px;border:1px dashed var(--border);border-radius:6px;background:var(--surface);font-family:monospace;font-size:13px;font-weight:700;letter-spacing:1px">' +
        'Eszközkód: ' + esc(session.deviceCode) +
        '</div>'
    }
    if (session.active && session.needsCodeInput && session.authUrl) {
      html +=
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">' +
        '<input type="text" class="input" data-cli-login-code-inp="' + esc(cliId) + '" placeholder="Illeszd be a kódot VAGY a teljes localhost callback URL-t..." style="flex:1;min-width:160px;padding:4px 6px;font-size:11px">' +
        '<button type="button" class="btn-primary btn-compact" data-cli-login-code-send="' + esc(cliId) + '" style="padding:4px 8px;font-size:11px">Kód beküldése</button>' +
        '</div>'
    }
    if (session.error) {
      html += '<div style="font-size:11px;color:#dc2626;margin-bottom:6px">' + esc(session.error) + '</div>'
    }
    if (session.outputTail) {
      html +=
        '<pre style="margin:0 0 6px 0;padding:6px;border-radius:4px;background:var(--surface);border:1px solid var(--border);font-size:10px;line-height:1.35;max-height:110px;overflow:auto;white-space:pre-wrap;word-break:break-word;opacity:.85">' +
        esc(session.outputTail) +
        '</pre>'
    }
    if (session.active) {
      html += '<button type="button" class="btn-secondary btn-compact" data-cli-login-cancel="' + esc(cliId) + '" style="padding:3px 8px;font-size:11px">Mégse</button>'
    }
    box.innerHTML = html

    const restoredInp = box.querySelector('[data-cli-login-code-inp="' + cliId + '"]')
    if (restoredInp && existingCodeVal) {
      restoredInp.value = existingCodeVal
    }

    const sendBtn = box.querySelector('[data-cli-login-code-send="' + cliId + '"]')
    if (sendBtn) {
      sendBtn.addEventListener('click', async function () {
        const inp = box.querySelector('[data-cli-login-code-inp="' + cliId + '"]')
        const code = inp ? inp.value.trim() : ''
        if (!code) return
        sendBtn.disabled = true
        try {
          const res = await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/login/code', {
            method: 'POST',
            body: JSON.stringify({ code: code }),
          })
          renderCliLoginState(cliId, res.session)
        } catch (err) {
          const statusEl = document.getElementById('vpsCliProvidersStatus')
          if (statusEl) statusEl.textContent = 'Kód beküldési hiba (' + cliId + '): ' + err.message
          sendBtn.disabled = false
        }
      })
    }

    const cancelBtn = box.querySelector('[data-cli-login-cancel="' + cliId + '"]')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async function () {
        stopCliLoginPoller(cliId)
        try {
          await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/login/cancel', {
            method: 'POST',
            body: '{}',
          })
        } catch { /* ignore */ }
        renderCliLoginState(cliId, null)
      })
    }
  }

  function startCliLoginPoller(cliId) {
    stopCliLoginPoller(cliId)
    cliLoginPollers[cliId] = setInterval(async function () {
      try {
        const data = await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/login/status')
        const session = data.session
        renderCliLoginState(cliId, session)
        if (!session || !session.active) {
          stopCliLoginPoller(cliId)
          if (session && session.phase === 'succeeded') {
            const statusEl = document.getElementById('vpsCliProvidersStatus')
            if (statusEl) statusEl.textContent = session.message || (cliId + ' OAuth belépés sikeres!')
            await refreshCliProviders()
          }
        }
      } catch {
        stopCliLoginPoller(cliId)
      }
    }, 1500)
  }

  function formatResetTime(iso) {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return d.toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }

  async function refreshCliQuota(cliId, boxEl, btnEl) {
    if (!boxEl) return
    if (btnEl) btnEl.disabled = true
    boxEl.hidden = false
    boxEl.innerHTML = '<div style="font-size:11px;opacity:.75">Kvóta lekérdezése...</div>'
    try {
      const data = await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/quota')
      if (!data.ok) {
        boxEl.innerHTML = '<div style="font-size:11px;color:#dc2626">Kvóta hiba: ' + esc(data.error || 'ismeretlen hiba') + '</div>'
        return
      }
      const wins = Array.isArray(data.windows) ? data.windows : []
      if (wins.length === 0) {
        boxEl.innerHTML = '<div style="font-size:11px;opacity:.75">' + esc(data.message || 'Nincs elérhető kvóta-adat.') + '</div>'
        return
      }
      boxEl.innerHTML = wins
        .map(function (w) {
          const used = Math.max(0, Math.min(100, Number(w.usedPercent || 0)))
          const rem = Math.max(0, Math.min(100, Number(w.remainingPercent != null ? w.remainingPercent : (100 - used))))
          const barColor = used >= 90 ? '#dc2626' : used >= 70 ? '#d97706' : '#16a34a'
          const resetStr = formatResetTime(w.resetsAt)
          return (
            '<div style="display:flex;flex-direction:column;gap:2px;margin-bottom:4px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;gap:6px">' +
            '<span><b>' + esc(w.label) + ':</b> ' + esc(rem.toFixed(0)) + '% szabad (' + esc(used.toFixed(0)) + '% használt)</span>' +
            (resetStr ? '<span style="opacity:.7;font-size:10px">reset: ' + esc(resetStr) + '</span>' : '') +
            '</div>' +
            '<div style="height:6px;border-radius:999px;background:rgba(128,128,128,0.2);overflow:hidden">' +
            '<div style="height:100%;width:' + used + '%;background:' + barColor + ';border-radius:999px;transition:width .25s ease"></div>' +
            '</div>' +
            '</div>'
          )
        })
        .join('')
    } catch (err) {
      boxEl.innerHTML = '<div style="font-size:11px;color:#dc2626">Kvóta hiba: ' + esc(err.message) + '</div>'
    } finally {
      if (btnEl) btnEl.disabled = false
    }
  }

  async function refreshCliProviders() {
    const grid = document.getElementById('vpsCliProvidersGrid')
    const statusEl = document.getElementById('vpsCliProvidersStatus')
    if (!grid) return
    try {
      const data = await apiJson('/api/admin/clis')
      const clis = data.clis || []
      grid.innerHTML = clis
        .map(function (c) {
          const instBadge = c.installed
            ? '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:#16a34a">' + esc(c.version || 'telepítve') + '</span>'
            : '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:#6b7280">nincs telepítve</span>'
          let authBadge
          if (c.authMethod === 'oauth') {
            authBadge = '<span title="' + esc(c.authDetail || 'OAuth') + '" style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:#2563eb">OAuth előfizetés OK</span>'
          } else if (c.authMethod === 'api_key') {
            authBadge = '<span title="' + esc(c.authDetail || 'API kulcs') + '" style="padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#fff;background:#dc2626;box-shadow:0 0 0 2px rgba(220,38,38,0.28)">⚠ API kulcs (FIZETŐS!)</span>'
          } else {
            authBadge = '<span style="padding:1px 6px;border-radius:999px;font-size:11px;color:#fff;background:#d97706">nincs belépve</span>'
          }
          const apiKeyWarnBox = c.authMethod === 'api_key'
            ? '<div style="padding:6px 8px;border-radius:6px;background:rgba(220,38,38,0.12);border:1px solid #dc2626;color:#dc2626;font-size:11px;font-weight:600;line-height:1.35">⚠ FIZETŐS API MÓD: tokenenként számláz (' + esc(c.authDetail || '.env') + ')! Lépj be OAuth előfizetéssel a „Belépés / Token” gombbal.</div>'
            : ''
          const cliNoteBox =
            c.id === 'gemini'
              ? '<div style="padding:5px 7px;border-radius:6px;background:rgba(217,119,6,0.10);border:1px solid rgba(217,119,6,0.45);font-size:11px;line-height:1.35">ℹ OAuth módban csak <b>Enterprise / céges</b> Google Code Assist előfizetéssel működik. Egyéni (Individual) Google előfizetéshez használd az <b>agy-cli</b>-t!</div>'
              : c.id === 'agy'
                ? '<div style="padding:5px 7px;border-radius:6px;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.35);font-size:11px;line-height:1.35">ℹ Egyéni (Individual) Google AI előfizetéshez ajánlott (Antigravity CLI).</div>'
                : ''
          const authDetailLine = c.authDetail && c.authMethod !== 'api_key'
            ? '<div style="font-size:11px;opacity:.75">Auth forrás: <code>' + esc(c.authDetail) + '</code></div>'
            : ''
          const cardBorderStyle = c.authMethod === 'api_key'
            ? 'border:2px solid #dc2626;background:rgba(220,38,38,0.04)'
            : 'border:1px solid var(--border);background:var(--bg)'
          const tokenPlaceholder =
            c.id === 'claude'
              ? 'sk-ant-oat01-... vagy ANTHROPIC_API_KEY vagy ~/.claude/.credentials.json'
              : c.id === 'codex'
                ? 'OPENAI_API_KEY (sk-...) vagy ~/.codex/auth.json'
                : c.id === 'agy'
                  ? 'GEMINI_API_KEY (AIza...) vagy ~/.gemini/antigravity-cli/credentials.json'
                  : 'GEMINI_API_KEY (AIza...) vagy ~/.gemini/oauth_creds.json'
          return (
            '<div style="padding:10px;' + cardBorderStyle + ';border-radius:8px;display:flex;flex-direction:column;gap:6px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">' +
            '<strong>' + esc(c.provider) + '</strong>' +
            '<div style="display:flex;gap:4px;flex-wrap:wrap">' + instBadge + authBadge + '</div>' +
            '</div>' +
            '<div style="font-size:11px;font-family:monospace;opacity:.8;word-break:break-word">' + esc(c.packageName) + '</div>' +
            '<div style="font-size:11px;opacity:.7;word-break:break-all">' + esc(c.resolvedPath || c.prefix || '') + '</div>' +
            cliNoteBox +
            apiKeyWarnBox +
            authDetailLine +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">' +
            '<button type="button" class="btn-primary btn-compact" data-cli-action="install" data-cli-id="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px">' + (c.installed ? 'Frissítés' : 'Telepítés') + '</button>' +
            '<button type="button" class="btn-secondary btn-compact" data-cli-test="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px"' + (c.installed ? '' : ' disabled') + '>Teszt</button>' +
              ((c.id === 'claude' || c.id === 'codex' || c.id === 'agy')
                ? '<button type="button" class="btn-secondary btn-compact" data-cli-quota-btn="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px">Kvóta</button>'
                : '') +
              '<button type="button" class="btn-secondary btn-compact" data-cli-auth-toggle="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px">Belépés / Token</button>' +
              (c.authMethod === 'oauth'
                ? '<button type="button" class="btn-secondary btn-compact" data-cli-logout="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px">Kilépés</button>'
                : '') +
              '<button type="button" class="btn-secondary btn-compact" data-cli-action="remove" data-cli-id="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px"' + (c.installed ? '' : ' disabled') + '>Eltávolítás</button>' +
              '</div>' +
                ((c.id === 'claude' || c.id === 'codex' || c.id === 'agy')
                  ? '<div data-cli-quota-box="' + esc(c.id) + '" hidden style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface)"></div>'
                  : '') +
                '<div data-cli-test-result="' + esc(c.id) + '" hidden style="font-size:11px;padding:5px 7px;border-radius:6px;line-height:1.35;word-break:break-word"></div>' +
                '<div data-cli-auth-drawer="' + esc(c.id) + '" hidden style="margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);display:none;flex-direction:column;gap:8px">' +
                '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
                '<button type="button" class="btn-primary btn-compact" data-cli-oauth-start="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px"' + (c.installed ? '' : ' disabled') + '>Böngészős OAuth indítása</button>' +
                (!c.installed ? '<span style="font-size:11px;opacity:.7">Előbb telepítsd a CLI-t.</span>' : '') +
                '</div>' +
                '<div data-cli-login-box="' + esc(c.id) + '" hidden style="padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg)"></div>' +
                '<details data-cli-manual-details="' + esc(c.id) + '" style="border-top:1px solid var(--border);padding-top:6px">' +
                '<summary style="font-size:11px;opacity:.8;cursor:pointer;user-select:none">Haladó: kézi API kulcs / OAuth JSON mentése</summary>' +
                '<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">' +
                '<textarea class="input" rows="2" data-cli-auth-input="' + esc(c.id) + '" placeholder="' + esc(tokenPlaceholder) + '" style="font-size:11px;font-family:monospace;padding:5px 6px"></textarea>' +
                '<div style="display:flex;gap:6px;align-items:center">' +
                '<button type="button" class="btn-secondary btn-compact" data-cli-auth-save="' + esc(c.id) + '" style="padding:4px 8px;font-size:11px">Mentés</button>' +
                '<span data-cli-auth-msg="' + esc(c.id) + '" style="font-size:11px;opacity:.8"></span>' +
                '</div>' +
                '</div>' +
                '</details>' +
                '</div>' +
                '</div>'
              )
        })
        .join('')

      grid.querySelectorAll('[data-cli-quota-btn]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const cliId = btn.getAttribute('data-cli-quota-btn')
          const box = grid.querySelector('[data-cli-quota-box="' + cliId + '"]')
          if (cliId && box) refreshCliQuota(cliId, box, btn)
        })
      })

      // Auto-load live quota strip for OAuth-authenticated claude / codex / agy cards
      clis.forEach(function (c) {
          if ((c.id === 'claude' || c.id === 'codex' || c.id === 'agy') && c.authMethod === 'oauth') {
            const box = grid.querySelector('[data-cli-quota-box="' + c.id + '"]')
            const btn = grid.querySelector('[data-cli-quota-btn="' + c.id + '"]')
            if (box) refreshCliQuota(c.id, box, btn)
          }
        })

      grid.querySelectorAll('[data-cli-test]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const cliId = btn.getAttribute('data-cli-test')
          const outEl = grid.querySelector('[data-cli-test-result="' + cliId + '"]')
          if (!cliId || !outEl) return
          btn.disabled = true
          outEl.hidden = false
          outEl.style.background = 'var(--surface)'
          outEl.style.border = '1px solid var(--border)'
          outEl.style.color = 'inherit'
          outEl.textContent = 'CLI kapcsolat tesztelése (ping)...'
          try {
            const res = await fetch('/api/admin/clis/' + encodeURIComponent(cliId) + '/test', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            })
            const data = await res.json().catch(function () { return {} })
            if (res.ok && data.ok) {
              outEl.style.background = 'rgba(22,163,74,0.12)'
              outEl.style.border = '1px solid #16a34a'
              outEl.style.color = '#15803d'
              outEl.textContent =
                '✓ Kapcsolat OK (' + data.latencyMs + ' ms) · auth: ' + (data.authMethod || '?') +
                (data.model ? ' · ' + data.model : '') +
                ' · válasz: ' + (data.reply || 'OK')
            } else {
              outEl.style.background = 'rgba(220,38,38,0.12)'
              outEl.style.border = '1px solid #dc2626'
              outEl.style.color = '#dc2626'
              outEl.textContent =
                '✕ Hiba' + (data.latencyMs ? ' (' + data.latencyMs + ' ms)' : '') +
                (data.errorKind ? ' [' + data.errorKind + ']' : '') + ': ' +
                (data.error || ('HTTP ' + res.status))
            }
          } catch (err) {
            outEl.style.background = 'rgba(220,38,38,0.12)'
            outEl.style.border = '1px solid #dc2626'
            outEl.style.color = '#dc2626'
            outEl.textContent = '✕ Hiba: ' + err.message
          } finally {
            btn.disabled = false
          }
        })
      })

      grid.querySelectorAll('[data-cli-action]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const action = btn.getAttribute('data-cli-action')
          const cliId = btn.getAttribute('data-cli-id')
          if (!action || !cliId) return
          btn.disabled = true
          if (statusEl) statusEl.textContent = (action === 'install' ? 'Telepítés / frissítés: ' : 'Eltávolítás: ') + cliId + '...'
          try {
            await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/' + action, {
              method: 'POST',
              body: '{}',
            })
            if (statusEl) statusEl.textContent = cliId + ' ' + (action === 'install' ? 'telepítve / frissítve.' : 'eltávolítva.')
            await refreshCliProviders()
          } catch (err) {
            if (statusEl) statusEl.textContent = 'Hiba (' + cliId + '): ' + err.message
            btn.disabled = false
          }
        })
      })

      grid.querySelectorAll('[data-cli-auth-toggle]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const cliId = btn.getAttribute('data-cli-auth-toggle')
          const drawer = grid.querySelector('[data-cli-auth-drawer="' + cliId + '"]')
          if (!drawer) return
          const opening = drawer.hidden || drawer.style.display === 'none'
          drawer.hidden = !opening
          drawer.style.display = opening ? 'flex' : 'none'
        })
      })

      grid.querySelectorAll('[data-cli-oauth-start]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const cliId = btn.getAttribute('data-cli-oauth-start')
          if (!cliId) return
          btn.disabled = true
          if (statusEl) statusEl.textContent = cliId + ' böngészős OAuth indítása...'
          try {
            const data = await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/login/start', {
              method: 'POST',
              body: '{}',
            })
            renderCliLoginState(cliId, data.session)
            if (data.session && data.session.active) {
              startCliLoginPoller(cliId)
            }
            if (statusEl) statusEl.textContent = ''
          } catch (err) {
            if (statusEl) statusEl.textContent = 'OAuth indítási hiba (' + cliId + '): ' + err.message
          } finally {
            btn.disabled = false
          }
        })
      })

      grid.querySelectorAll('[data-cli-auth-save]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const cliId = btn.getAttribute('data-cli-auth-save')
          const inp = grid.querySelector('[data-cli-auth-input="' + cliId + '"]')
          const msgEl = grid.querySelector('[data-cli-auth-msg="' + cliId + '"]')
          const raw = inp ? inp.value.trim() : ''
          if (!cliId || !raw) {
            if (msgEl) msgEl.textContent = 'Adj meg tokent vagy JSON-t.'
            return
          }
          btn.disabled = true
          if (msgEl) msgEl.textContent = 'Mentés...'
          try {
            const payload = raw.startsWith('{') ? { authJson: raw } : { token: raw }
            const res = await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/auth', {
              method: 'POST',
              body: JSON.stringify(payload),
            })
            if (inp) inp.value = ''
            if (statusEl) statusEl.textContent = cliId + ' hitelesítés mentve (' + (res.result && res.result.target ? res.result.target : 'OK') + ').'
            await refreshCliProviders()
          } catch (err) {
            if (msgEl) msgEl.textContent = 'Hiba: ' + err.message
            btn.disabled = false
          }
        })
      })

      grid.querySelectorAll('[data-cli-logout]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const cliId = btn.getAttribute('data-cli-logout')
          if (!cliId || !confirm('Biztosan törlöd a ' + cliId + ' OAuth belépését?')) return
          btn.disabled = true
          try {
            await apiJson('/api/admin/clis/' + encodeURIComponent(cliId) + '/logout', {
              method: 'POST',
              body: '{}',
            })
            if (statusEl) statusEl.textContent = cliId + ' OAuth belépés törölve.'
            await refreshCliProviders()
          } catch (err) {
            if (statusEl) statusEl.textContent = 'Kilépési hiba (' + cliId + '): ' + err.message
            btn.disabled = false
          }
        })
      })
    } catch (err) {
      if (statusEl) statusEl.textContent = 'CLI állapot lekérdezési hiba: ' + err.message
    }
  }

  let wired = false
  function wireEvents() {
    if (wired) return
    wired = true
    document.getElementById('vpsOpenApiWizardBtn')?.addEventListener('click', openModelApiWizard)
    document.getElementById('vpsRefreshClisBtn')?.addEventListener('click', refreshCliProviders)
    document.getElementById('providersRefreshAllBtn')?.addEventListener('click', function () {
      ensureModelCatalog(true)
      refreshCliProviders()
    })
    document.getElementById('vpsRefreshBtn')?.addEventListener('click', function () {
      refreshVpsStatus()
      refreshVpsLogs()
    })
    document.getElementById('vpsRunCleanupBtn')?.addEventListener('click', runVpsSystemCleanup)
    document.getElementById('vpsLogUnit')?.addEventListener('change', refreshVpsLogs)
    document.getElementById('vpsConvEnv')?.addEventListener('change', refreshConversations)
    document.getElementById('vpsChatSend')?.addEventListener('click', sendVpsChat)
    document.getElementById('vpsChatInput')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendVpsChat()
      }
    })
    document.querySelectorAll('[data-vps-ops]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runOpsAction(btn.getAttribute('data-vps-ops'), null, btn)
      })
    })
    document.getElementById('vpsSpinupBranchBtn')?.addEventListener('click', function () {
      const inp = document.getElementById('vpsSpinupBranch')
      const branch = inp ? inp.value.trim() : ''
      if (!branch) return
      runOpsAction('spinup-test', branch, document.getElementById('vpsSpinupBranchBtn'))
    })

    // Help-desk chat widget toggle
    const hdBtn = document.getElementById('alfredHelpdeskBtn')
    const hdBox = document.getElementById('alfredHelpdeskBox')
    const hdClose = document.getElementById('alfredHelpdeskClose')
    if (hdBox) hdBox.style.display = 'none'
    if (hdBtn && hdBox) {
      hdBtn.addEventListener('click', async function () {
        const opening = hdBox.hidden || hdBox.style.display === 'none'
        hdBox.hidden = !opening
        hdBox.style.display = opening ? 'flex' : 'none'
        if (opening) {
          try { await ensureVpsRolesData(false) } catch { /* ignore */ }
          refreshConversations()
        }
      })
    }
    if (hdClose && hdBox) {
      hdClose.addEventListener('click', function () {
        hdBox.hidden = true
        hdBox.style.display = 'none'
      })
    }

    // Model Catalog sync button
    const syncModelsBtn = document.getElementById('vpsSyncModelsBtn')
    if (syncModelsBtn) {
      syncModelsBtn.addEventListener('click', async function () {
        const statusEl = document.getElementById('vpsModelCatalogStatus')
        syncModelsBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Modellek lekérdezése a beregisztrált API-któl...'
        try {
          const data = await apiJson('/api/vps/models/sync', { method: 'POST', body: '{}' })
          vpsModelCatalogCache = data.providers || null
          vpsModelSyncedAt = data.syncedAt || null
          renderModelCatalog()
          if (statusEl) statusEl.textContent = 'Modell katalógus frissítve!'
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
        } finally {
          syncModelsBtn.disabled = false
        }
      })
    }

    // Track dirty state for CLAUDE.md / SOUL.md / .mcp.json
    document.getElementById('editClaudeMd')?.addEventListener('input', function () { coreFileDirty.claude = true })
    document.getElementById('editSoulMd')?.addEventListener('input', function () { coreFileDirty.soul = true })
    document.getElementById('editMcpJson')?.addEventListener('input', function () { coreFileDirty.mcp = true })

    // Agent modal override & unified save controls
    const ovChk = document.getElementById('agentCoreOverrideChk')
    const ovRow = document.getElementById('agentCoreOverrideRow')
    const ovRole = document.getElementById('agentCoreRoleSel')
    const ovProv = document.getElementById('agentCoreProvSel')
    const ovModelSel = document.getElementById('agentCoreModelSel')
    const ovModelInp = document.getElementById('agentCoreModelInp')
    const saveAllBtn = document.getElementById('saveAllAgentSettingsBtn')
    if (ovRole) {
      ovRole.addEventListener('change', updateInheritedRoleText)
    }
    if (ovChk && ovRow) {
      ovChk.addEventListener('change', function () {
        ovRow.hidden = !ovChk.checked
        ovRow.style.display = ovChk.checked ? 'flex' : 'none'
      })
    }
    if (ovProv) {
      ovProv.addEventListener('change', function () {
        populateCoreModelSelect(ovProv.value, '')
      })
    }
    if (ovModelSel && ovModelInp) {
      ovModelSel.addEventListener('change', function () {
        const isCustom = ovModelSel.value === '__custom__'
        ovModelInp.hidden = !isCustom
        if (!isCustom) ovModelInp.value = ovModelSel.value
      })
    }
    if (saveAllBtn) {
      saveAllBtn.addEventListener('click', async function () {
        if (!currentModalAgentId) return
        const roleSel = document.getElementById('agentCoreRoleSel')
        const provSel = document.getElementById('agentCoreProvSel')
        const modelSel = document.getElementById('agentCoreModelSel')
        const modelInp = document.getElementById('agentCoreModelInp')
        const budgetInp = document.getElementById('agentCoreBudgetInp')
        const statusEl = document.getElementById('agentSettingsSaveStatus')
        if (!roleSel || !provSel || !modelSel || !modelInp) return
        const useOverride = Boolean(ovChk && ovChk.checked)
        const chosenModel = modelSel.value === '__custom__' ? modelInp.value.trim() : modelSel.value
        const budgetVal = budgetInp ? Number(budgetInp.value) : NaN
        saveAllBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Mentés...'
        try {
          const dispNameVal = document.getElementById('agentCoreDisplayNameInp')?.value.trim() || ''
          const voiceVal = document.getElementById('agentCoreVoiceSel')?.value || 'Kore'
          const selectedTools = Array.from(document.querySelectorAll('[data-core-tool-chk]:checked'))
            .map(function (el) { return el.getAttribute('data-core-tool-chk') })
            .filter(Boolean)
          const sysPromptVal = document.getElementById('agentCoreSystemPromptInp')?.value ?? ''
          const wsVal = document.getElementById('agentCoreWorkspaceInp')?.value.trim() || null
          const memNsVal = document.getElementById('agentCoreMemNsInp')?.value.trim() || null
          const maxIterRaw = document.getElementById('agentCoreMaxIterInp')?.value.trim() || ''
          const maxIterVal = maxIterRaw ? Number(maxIterRaw) : null
          const bashToRaw = document.getElementById('agentCoreBashTimeoutInp')?.value.trim() || ''
          const bashToVal = bashToRaw ? Number(bashToRaw) : null
          const allowedUsersRaw = document.getElementById('agentCoreAllowedUsersInp')?.value || ''
          const allowedUsersVal = allowedUsersRaw.split(/[\s,]+/).map(function (s) { return s.trim() }).filter(Boolean)
          const protPathsRaw = document.getElementById('agentCoreProtectedPathsInp')?.value || ''
          const protPathsVal = protPathsRaw.split(/\r?\n/).map(function (s) { return s.trim() }).filter(Boolean)
          const allowedBashRaw = document.getElementById('agentCoreAllowedBashInp')?.value || ''
          const allowedBashVal = allowedBashRaw.split(/\r?\n/).map(function (s) { return s.trim() }).filter(Boolean)
          const res = await apiJson('/api/vps/agent-override', {
            method: 'POST',
            body: JSON.stringify({
              agentId: currentModalAgentId,
              displayName: dispNameVal || null,
              role: roleSel.value,
              provider: useOverride ? provSel.value : null,
              model: useOverride ? (chosenModel || null) : null,
              dailyBudgetUsd: Number.isFinite(budgetVal) && budgetVal >= 0.05 ? budgetVal : null,
              voice: voiceVal,
              tools: selectedTools,
              systemPrompt: sysPromptVal,
              workspace: wsVal,
              memoryNamespace: memNsVal,
              maxToolIterations: Number.isFinite(maxIterVal) ? maxIterVal : null,
              bashTimeoutMs: Number.isFinite(bashToVal) ? bashToVal : null,
              allowedUserIds: allowedUsersVal,
              protectedPaths: protPathsVal,
              allowedBashCommands: allowedBashVal,
              restartServices: true,
            }),
          })
          const filePatch = {}
          if (coreFileDirty.claude) filePatch.claudeMd = document.getElementById('editClaudeMd')?.value ?? ''
          if (coreFileDirty.soul) filePatch.soulMd = document.getElementById('editSoulMd')?.value ?? ''
          if (coreFileDirty.mcp) filePatch.mcpJson = document.getElementById('editMcpJson')?.value ?? ''
          if (Object.keys(filePatch).length > 0) {
            await apiJson('/api/agents/' + encodeURIComponent(currentModalAgentId), {
              method: 'PUT',
              body: JSON.stringify(filePatch),
            })
            coreFileDirty.claude = false
            coreFileDirty.soul = false
            coreFileDirty.mcp = false
          }
          const extra = res.restarted && res.restarted.length ? ' · újraindítva: ' + res.restarted.join(', ') : ''
          if (statusEl) statusEl.textContent = 'Minden beállítás mentve' + extra
          markAgentModalClean()
          await ensureVpsRolesData(true)
          const updated = vpsAgentsCache.find(function (a) { return a.id === currentModalAgentId })
          if (updated) applyCoreOverview(updated)
          if (typeof window.loadAgents === 'function') window.loadAgents()
          setTimeout(applyDisplayNamesToCards, 300)
          updateInheritedRoleText()
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
        } finally {
          saveAllBtn.disabled = false
        }
      })
    }

    // Discord Bot server/channel creator
    const dcLoadBtn = document.getElementById('agentDcLoadGuildsBtn')
    const dcGuildSel = document.getElementById('agentDcGuildSel')
    const dcCatSel = document.getElementById('agentDcCategorySel')
    const dcCreateBtn = document.getElementById('agentDcCreateChanBtn')
    function syncDcCategories() {
      if (!dcGuildSel || !dcCatSel) return
      const g = vpsDiscordGuildsCache.find(function (item) { return item.id === dcGuildSel.value })
      const cats = g ? (g.categories || []) : []
      dcCatSel.innerHTML = '<option value="">(Nincs kategória)</option>' +
        cats.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>' }).join('')
    }
    if (dcGuildSel) dcGuildSel.addEventListener('change', syncDcCategories)
    if (dcLoadBtn && dcGuildSel) {
      dcLoadBtn.addEventListener('click', async function () {
        const statusEl = document.getElementById('agentDcCreateStatus')
        dcLoadBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Discord szerverek betöltése...'
        try {
          const data = await apiJson('/api/vps/discord/guilds')
          vpsDiscordGuildsCache = data.guilds || []
          dcGuildSel.innerHTML = vpsDiscordGuildsCache.length
            ? vpsDiscordGuildsCache.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>' }).join('')
            : '<option value="">(Nincs elérhető szerver)</option>'
          syncDcCategories()
          if (statusEl) statusEl.textContent = vpsDiscordGuildsCache.length + ' szerver betöltve.'
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
        } finally {
          dcLoadBtn.disabled = false
        }
      })
    }
    if (dcCreateBtn) {
      dcCreateBtn.addEventListener('click', async function () {
        if (!currentModalAgentId || !dcGuildSel) return
        const guildId = dcGuildSel.value
        const categoryId = dcCatSel ? dcCatSel.value : ''
        const channelName = document.getElementById('agentDcChanName')?.value.trim() || ''
        const statusEl = document.getElementById('agentDcCreateStatus')
        if (!guildId || !channelName) {
          if (statusEl) statusEl.textContent = 'Előbb töltsd be a szervereket és adj meg egy csatornanevet!'
          return
        }
        dcCreateBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Discord szoba létrehozása...'
        try {
          const res = await apiJson('/api/vps/discord/create-channel', {
            method: 'POST',
            body: JSON.stringify({ agentId: currentModalAgentId, guildId, categoryId: categoryId || null, channelName }),
          })
          if (statusEl) statusEl.textContent = 'Létrehozva és bekötve: ' + res.channel.name + ' (ID: ' + res.channel.id + ')'
          await ensureVpsRolesData(true)
          const updated = vpsAgentsCache.find(function (a) { return a.id === currentModalAgentId })
          if (updated) {
            applyCoreOverview(updated)
            const cur = document.getElementById('agentCoreChannelCurrent')
            if (cur) cur.textContent = 'Aktuális csatorna: ' + (updated.channelName || res.channel.name)
          }
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
        } finally {
          dcCreateBtn.disabled = false
        }
      })
    }

    // Simulated Live Agent Terminal modal
    let coreTermTimer = null
    let coreTermAgentId = null
    const termOverlay = document.getElementById('agentCoreTerminalOverlay')
    const termOut = document.getElementById('agentCoreTermOutput')
    const termTitle = document.getElementById('agentCoreTermTitle')
    const termAuto = document.getElementById('agentCoreTermAutoChk')
    const termInp = document.getElementById('agentCoreTermInput')
    const termSend = document.getElementById('agentCoreTermSendBtn')

    const TERM_COLORS = {
      user: '#58a6ff',
      tool: '#d29922',
      llm: '#bc8cff',
      assistant: '#3fb950',
      error: '#f85149',
    }

    async function refreshCoreTerminal() {
      if (!coreTermAgentId || !termOut) return
      try {
        const data = await apiJson('/api/vps/agent-terminal?agentId=' + encodeURIComponent(coreTermAgentId) + '&limit=80')
        const events = data.events || []
        if (events.length === 0) {
          termOut.innerHTML = '<div style="opacity:.6">Még nincs rögzített esemény ehhez az ügynökhöz. Írj egy üzenetet lent a kipróbáláshoz!</div>'
          return
        }
        const atBottom = termOut.scrollHeight - termOut.scrollTop - termOut.clientHeight < 40
        termOut.innerHTML = events
          .map(function (ev) {
            const color = TERM_COLORS[ev.kind] || '#e6edf3'
            const t = (ev.ts || '').slice(11, 19) || '--:--:--'
            return (
              '<div style="margin-bottom:6px">' +
              '<span style="color:#8b949e">[' + esc(t) + ']</span> ' +
              '<strong style="color:' + color + '">' + esc(ev.title) + '</strong>' +
              (ev.detail ? '\n<span style="color:#c9d1d9">' + esc(ev.detail) + '</span>' : '') +
              '</div>'
            )
          })
          .join('')
        if (atBottom) termOut.scrollTop = termOut.scrollHeight
      } catch (err) {
        termOut.innerHTML = '<div style="color:#f85149">Hiba: ' + esc(err.message) + '</div>'
      }
    }

    function stopCoreTermPolling() {
      if (coreTermTimer) { clearInterval(coreTermTimer); coreTermTimer = null }
    }

    function startCoreTermPolling() {
      stopCoreTermPolling()
      if (termAuto && termAuto.checked && coreTermAgentId && termOverlay && !termOverlay.hidden) {
        coreTermTimer = setInterval(refreshCoreTerminal, 2000)
      }
    }

    function openCoreTerminal(agentId) {
      if (!termOverlay || !agentId) return
      coreTermAgentId = agentId
      if (termTitle) termTitle.textContent = 'Terminál — ' + agentId
      termOverlay.hidden = false
      termOverlay.classList.add('active')
      refreshCoreTerminal()
      startCoreTermPolling()
    }

    function closeCoreTerminal() {
      stopCoreTermPolling()
      coreTermAgentId = null
      if (termOverlay) {
        termOverlay.classList.remove('active')
        termOverlay.hidden = true
      }
    }

    document.getElementById('agentCoreTerminalBtn')?.addEventListener('click', function () {
      if (currentModalAgentId) openCoreTerminal(currentModalAgentId)
    })
    document.getElementById('agentCoreTermCloseBtn')?.addEventListener('click', closeCoreTerminal)
    document.getElementById('agentCoreTermRefreshBtn')?.addEventListener('click', refreshCoreTerminal)
    termAuto?.addEventListener('change', startCoreTermPolling)

    async function sendCoreTermMessage() {
      if (!coreTermAgentId || !termInp || !termSend) return
      const text = termInp.value.trim()
      if (!text) return
      termSend.disabled = true
      termInp.disabled = true
      try {
        if (document.getElementById('alfredTestBanner')) {
          await apiJson('/api/test-sim/send', {
            method: 'POST',
            body: JSON.stringify({ agentId: coreTermAgentId, content: text }),
          })
        } else {
          await apiJson('/api/vps/chat', {
            method: 'POST',
            body: JSON.stringify({ agentId: coreTermAgentId, message: text }),
          })
        }
        termInp.value = ''
        await refreshCoreTerminal()
      } catch (err) {
        if (termOut) termOut.innerHTML += '<div style="color:#f85149">Küldési hiba: ' + esc(err.message) + '</div>'
      } finally {
        termSend.disabled = false
        termInp.disabled = false
        termInp.focus()
      }
    }

    termSend?.addEventListener('click', sendCoreTermMessage)
    termInp?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendCoreTermMessage()
      }
    })

    // Alfred Core Skills tab wiring
    document.getElementById('coreSkillNewBtn')?.addEventListener('click', function () {
      const det = document.getElementById('coreSkillEditorDetails')
      if (det) det.open = true
      const idInp = document.getElementById('coreSkillIdInp')
      const descInp = document.getElementById('coreSkillDescInp')
      const contInp = document.getElementById('coreSkillContentInp')
      if (idInp) { idInp.value = ''; idInp.focus() }
      if (descInp) descInp.value = ''
      if (contInp) contInp.value = ''
    })

    document.getElementById('coreSkillAssignSaveBtn')?.addEventListener('click', async function () {
      if (!currentModalAgentId) return
      const btn = document.getElementById('coreSkillAssignSaveBtn')
      const statusEl = document.getElementById('coreSkillsStatus')
      const selected = []
      document.querySelectorAll('[data-core-skill-chk]:checked').forEach(function (chk) {
        const id = chk.getAttribute('data-core-skill-chk')
        if (id) selected.push(id)
      })
      if (btn) btn.disabled = true
      if (statusEl) statusEl.textContent = 'Mentés...'
      try {
        await apiJson('/api/vps/skills/assign', {
          method: 'POST',
          body: JSON.stringify({ agentId: currentModalAgentId, skills: selected }),
        })
        if (statusEl) statusEl.textContent = 'Skillek elmentve (' + selected.length + ' aktív).'
        await ensureVpsRolesData(true)
        const ag = vpsAgentsCache.find(function (a) { return a.id === currentModalAgentId })
        if (ag) applyCoreOverview(ag)
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
      } finally {
        if (btn) btn.disabled = false
      }
    })

    document.getElementById('coreSkillAiGenBtn')?.addEventListener('click', async function () {
      const btn = document.getElementById('coreSkillAiGenBtn')
      const promptInp = document.getElementById('coreSkillAiPrompt')
      const statusEl = document.getElementById('coreSkillEditorStatus')
      const promptText = promptInp ? promptInp.value.trim() : ''
      if (!promptText) {
        if (statusEl) statusEl.textContent = 'Írj be egy rövid leírást a generáláshoz!'
        return
      }
      if (btn) btn.disabled = true
      if (statusEl) statusEl.textContent = '✨ AI generálás folyamatban...'
      try {
        const res = await apiJson('/api/vps/skills/generate', {
          method: 'POST',
          body: JSON.stringify({ prompt: promptText, agentId: currentModalAgentId || undefined }),
        })
        const d = res.draft || {}
        const idInp = document.getElementById('coreSkillIdInp')
        const descInp = document.getElementById('coreSkillDescInp')
        const contInp = document.getElementById('coreSkillContentInp')
        if (idInp) idInp.value = d.id || ''
        if (descInp) descInp.value = d.description || ''
        if (contInp) contInp.value = d.content || ''
        if (statusEl) statusEl.textContent = 'Javaslat elkészült! Nézd át és kattints a Mentés gombra.'
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
      } finally {
        if (btn) btn.disabled = false
      }
    })

    function renderSimpleLineDiff(beforeText, afterText) {
      const a = String(beforeText || '').split(/\r?\n/)
      const b = String(afterText || '').split(/\r?\n/)
      const aSet = new Set(a.map(function (l) { return l.trim() }).filter(Boolean))
      const bSet = new Set(b.map(function (l) { return l.trim() }).filter(Boolean))
      const rows = []
      a.forEach(function (line) {
        if (line.trim() && !bSet.has(line.trim())) {
          rows.push('<div style="background:rgba(220,38,38,.12);color:#dc2626;padding:1px 6px;border-radius:3px">- ' + esc(line) + '</div>')
        }
      })
      b.forEach(function (line) {
        if (line.trim() && !aSet.has(line.trim())) {
          rows.push('<div style="background:rgba(22,163,74,.12);color:#15803d;padding:1px 6px;border-radius:3px">+ ' + esc(line) + '</div>')
        }
      })
      if (rows.length === 0) return '<div style="opacity:.7;margin-top:6px">Nincs szöveges különbség.</div>'
      return (
        '<details open style="margin-top:8px">' +
        '<summary style="cursor:pointer;font-weight:600;font-size:11px;user-select:none">Változások (diff: ' + rows.length + ' sor)</summary>' +
        '<div style="margin-top:6px;max-height:180px;overflow:auto;font-family:monospace;font-size:11px;display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">' +
        rows.join('') +
        '</div></details>'
      )
    }

    function showOptimizeResult(msgEl, beforeText, opt, restoreFn) {
      if (!msgEl) return
      const stats = opt.tokensBeforeEst
        ? ' (~' + opt.tokensBeforeEst + ' → ~' + opt.tokensAfterEst + ' token, ' + (opt.savedPct >= 0 ? '-' + opt.savedPct : '+' + Math.abs(opt.savedPct)) + '%)'
        : ''
      msgEl.hidden = false
      msgEl.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span>⚡ Optimalizálva' + esc(stats) + ': ' + esc(opt.summary || '') + '</span>' +
        '<button type="button" class="btn-secondary btn-compact" data-opt-restore style="font-size:11px;padding:2px 8px">Eredeti visszaállítása</button>' +
        '</div>' +
        renderSimpleLineDiff(beforeText, opt.content || '')
      msgEl.querySelector('[data-opt-restore]')?.addEventListener('click', function () {
        restoreFn()
        msgEl.textContent = 'Eredeti tartalom visszaállítva.'
      })
    }

    document.getElementById('coreSkillAiOptBtn')?.addEventListener('click', async function () {
      const btn = document.getElementById('coreSkillAiOptBtn')
      const idInp = document.getElementById('coreSkillIdInp')
      const contInp = document.getElementById('coreSkillContentInp')
      const statusEl = document.getElementById('coreSkillEditorStatus')
      const beforeText = contInp ? contInp.value : ''
      const content = beforeText.trim()
      if (!content) {
        if (statusEl) statusEl.textContent = 'Nincs mit optimalizálni — előbb nyiss meg vagy generálj egy skillt!'
        return
      }
      if (btn) btn.disabled = true
      if (statusEl) statusEl.textContent = '⚡ Skill Optimalizáló Agent dolgozik...'
      try {
        const res = await apiJson('/api/vps/skills/optimize', {
          method: 'POST',
          body: JSON.stringify({ content, id: idInp ? idInp.value.trim() : undefined, agentId: currentModalAgentId || undefined }),
        })
        const opt = res.optimized || {}
        if (contInp && opt.content) contInp.value = opt.content
        showOptimizeResult(statusEl, beforeText, opt, function () { if (contInp) contInp.value = beforeText })
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
      } finally {
        if (btn) btn.disabled = false
      }
    })

    // Global #skills page AI Skill Wizard & Optimizer
    const gGenBtn = document.getElementById('globalSkillAiGenBtn')
    const gOptBtn = document.getElementById('globalSkillAiOptBtn')
    const gSaveBtn = document.getElementById('globalSkillSaveBtn')
    const gPrevWrap = document.getElementById('globalSkillPreviewWrap')
    const gContent = document.getElementById('globalSkillContent')
    const gStatus = document.getElementById('globalSkillStatus')
    if (gGenBtn) {
      gGenBtn.addEventListener('click', async function () {
        const nameInp = document.getElementById('skillName')
        const descInp = document.getElementById('skillDescription')
        const promptText = [nameInp?.value.trim(), descInp?.value.trim()].filter(Boolean).join(': ')
        if (!promptText) {
          if (gStatus) gStatus.textContent = 'Írd le röviden, mit csináljon a skill!'
          return
        }
        gGenBtn.disabled = true
        if (gStatus) gStatus.textContent = '✨ AI Skill Varázsló generál...'
        try {
          const res = await apiJson('/api/vps/skills/generate', {
            method: 'POST',
            body: JSON.stringify({ prompt: promptText }),
          })
          const d = res.draft || {}
          if (nameInp && !nameInp.value.trim() && d.id) nameInp.value = d.id
          if (gContent) gContent.value = d.content || ''
          if (gPrevWrap) { gPrevWrap.hidden = false; gPrevWrap.style.display = 'flex' }
          if (gOptBtn) gOptBtn.hidden = false
          if (gStatus) gStatus.textContent = 'Elkészült! Szerkesztheted, optimalizálhatod vagy elmentheted.'
        } catch (err) {
          if (gStatus) gStatus.textContent = 'Hiba: ' + err.message
        } finally {
          gGenBtn.disabled = false
        }
      })
    }
    if (gOptBtn) {
      gOptBtn.addEventListener('click', async function () {
        const nameInp = document.getElementById('skillName')
        const beforeText = gContent ? gContent.value : ''
        const content = beforeText.trim()
        if (!content) return
        gOptBtn.disabled = true
        if (gStatus) gStatus.textContent = '⚡ Skill Optimalizáló Agent dolgozik...'
        try {
          const res = await apiJson('/api/vps/skills/optimize', {
            method: 'POST',
            body: JSON.stringify({ content, id: nameInp?.value.trim() || undefined }),
          })
          const opt = res.optimized || {}
          if (gContent && opt.content) gContent.value = opt.content
          showOptimizeResult(gStatus, beforeText, opt, function () { if (gContent) gContent.value = beforeText })
        } catch (err) {
          if (gStatus) gStatus.textContent = 'Hiba: ' + err.message
        } finally {
          gOptBtn.disabled = false
        }
      })
    }
    if (gSaveBtn) {
      gSaveBtn.addEventListener('click', async function () {
        const nameInp = document.getElementById('skillName')
        const descInp = document.getElementById('skillDescription')
        const id = nameInp ? nameInp.value.trim() : ''
        const content = gContent ? gContent.value.trim() : ''
        if (!id || !content) {
          if (gStatus) gStatus.textContent = 'Add meg a skill nevét és tartalmát!'
          return
        }
        gSaveBtn.disabled = true
        if (gStatus) gStatus.textContent = 'Mentés a Skill Könyvtárba...'
        try {
          const res = await apiJson('/api/vps/skills/save', {
            method: 'POST',
            body: JSON.stringify({ id, description: descInp?.value.trim() || id, content }),
          })
          if (gStatus) gStatus.textContent = 'Elmentve: ' + res.id
          const overlay = document.getElementById('skillModalOverlay')
          if (overlay) { overlay.classList.remove('active'); overlay.hidden = true }
          if (typeof window.loadSkillsPage === 'function') window.loadSkillsPage()
          else location.reload()
        } catch (err) {
          if (gStatus) gStatus.textContent = 'Hiba: ' + err.message
        } finally {
          gSaveBtn.disabled = false
        }
      })
    }

    // Skill Detail modal AI Optimizer button
    document.getElementById('skillDetailOptimizeBtn')?.addEventListener('click', async function () {
      const btn = document.getElementById('skillDetailOptimizeBtn')
      const editor = document.getElementById('skillDetailEditor')
      const editBtn = document.getElementById('skillDetailEditBtn')
      const msgEl = document.getElementById('skillDetailOptimizeMsg')
      const titleEl = document.getElementById('skillDetailTitle')
      if (!editor) return
      if (editor.hidden && editBtn) editBtn.click()
      const beforeText = editor.value
      const content = beforeText.trim()
      if (!content) return
      if (btn) btn.disabled = true
      if (msgEl) { msgEl.hidden = false; msgEl.textContent = '⚡ Skill Optimalizáló Agent elemzi és tömöríti a SKILL.md fájlt...' }
      try {
        const res = await apiJson('/api/vps/skills/optimize', {
          method: 'POST',
          body: JSON.stringify({ content, id: titleEl?.textContent?.trim() || undefined }),
        })
        const opt = res.optimized || {}
        if (opt.content) editor.value = opt.content
        showOptimizeResult(msgEl, beforeText, opt, function () { editor.value = beforeText })
      } catch (err) {
        if (msgEl) { msgEl.hidden = false; msgEl.textContent = 'Hiba: ' + err.message }
      } finally {
        if (btn) btn.disabled = false
      }
    })

    // Phase 3: Pictogram Studio, AI Avatar & AI Persona Suggestions
    const pictoCanvas = document.getElementById('agentPictoCanvas')
    const pictoIcon = document.getElementById('agentPictoIconSel')
    const pictoC1 = document.getElementById('agentPictoColor1')
    const pictoC2 = document.getElementById('agentPictoColor2')
    const pictoStatus = document.getElementById('agentPictoStatus')

    function drawPictogramCanvas() {
      if (!pictoCanvas) return
      const ctx = pictoCanvas.getContext('2d')
      if (!ctx) return
      const w = pictoCanvas.width
      const h = pictoCanvas.height
      const grad = ctx.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, pictoC1 ? pictoC1.value : '#2563eb')
      grad.addColorStop(1, pictoC2 ? pictoC2.value : '#7c3aed')
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = Math.round(w * 0.48) + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(pictoIcon ? pictoIcon.value : '🤖', w / 2, h / 2 + 4)
    }

    drawPictogramCanvas()
    pictoIcon?.addEventListener('change', drawPictogramCanvas)
    pictoC1?.addEventListener('input', drawPictogramCanvas)
    pictoC2?.addEventListener('input', drawPictogramCanvas)

    function refreshModalAvatarUrl(url) {
      const avEl = document.getElementById('agentDetailAvatar')
      if (avEl && url) {
        avEl.innerHTML = '<img src="' + esc(url) + '" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
      }
      if (currentModalAgentId && url) {
        document.querySelectorAll('#agentsGridView img[src*="/api/agents/' + currentModalAgentId + '/avatar"]').forEach(function (img) {
          img.src = url
        })
      }
      if (typeof window.loadAgents === 'function') window.loadAgents()
    }

    document.getElementById('agentPictoSaveBtn')?.addEventListener('click', async function () {
      if (!currentModalAgentId || !pictoCanvas) return
      const btn = document.getElementById('agentPictoSaveBtn')
      drawPictogramCanvas()
      const dataUrl = pictoCanvas.toDataURL('image/png')
      if (btn) btn.disabled = true
      if (pictoStatus) pictoStatus.textContent = 'Mentés...'
      try {
        const res = await apiJson('/api/vps/agents/personalize', {
          method: 'POST',
          body: JSON.stringify({ agentId: currentModalAgentId, avatarDataUrl: dataUrl }),
        })
        if (res.avatarUrl) refreshModalAvatarUrl(res.avatarUrl)
        if (pictoStatus) pictoStatus.textContent = '✓ Piktogram avatar elmentve!'
      } catch (err) {
        if (pictoStatus) pictoStatus.textContent = 'Hiba: ' + err.message
      } finally {
        if (btn) btn.disabled = false
      }
    })

    let selectedAiAvatarDataUrl = null
    const aiPicker = document.getElementById('agentAiAvatarPicker')
    const aiCandidatesEl = document.getElementById('agentAiAvatarCandidates')
    const aiApplyBtn = document.getElementById('agentAiAvatarApplyBtn')
    const aiDiscardBtn = document.getElementById('agentAiAvatarDiscardBtn')

    function clearAiAvatarPicker() {
      selectedAiAvatarDataUrl = null
      if (aiCandidatesEl) aiCandidatesEl.innerHTML = ''
      if (aiPicker) { aiPicker.hidden = true; aiPicker.style.display = 'none' }
      if (aiApplyBtn) aiApplyBtn.disabled = true
    }

    document.getElementById('agentAiAvatarGenBtn')?.addEventListener('click', async function () {
      if (!currentModalAgentId) return
      const btn = document.getElementById('agentAiAvatarGenBtn')
      const dispName = document.getElementById('agentCoreDisplayNameInp')?.value.trim() || currentModalAgentId
      const roleVal = document.getElementById('agentCoreRoleSel')?.value || ''
      if (btn) btn.disabled = true
      clearAiAvatarPicker()
      if (pictoStatus) pictoStatus.textContent = '✨ 3 Chibi avatar variáció generálása (név + SOUL.md + skillek alapján)...'
      try {
        const res = await apiJson('/api/vps/agents/generate-avatar', {
          method: 'POST',
          body: JSON.stringify({
            agentId: currentModalAgentId,
            displayName: dispName,
            role: roleVal,
            count: 3,
          }),
        })
        const list = res.candidates || []
        if (list.length === 0) {
          if (pictoStatus) pictoStatus.textContent = 'Nem érkezett kép.'
          return
        }
        if (aiPicker) { aiPicker.hidden = false; aiPicker.style.display = 'flex' }
        if (aiCandidatesEl) {
          aiCandidatesEl.innerHTML = list
            .map(function (url, idx) {
              return (
                '<button type="button" data-ai-cand="' + idx + '" style="padding:3px;border-radius:50%;border:3px solid transparent;background:none;cursor:pointer">' +
                '<img src="' + url + '" alt="Chibi ' + (idx + 1) + '" style="width:78px;height:78px;border-radius:50%;object-fit:cover;display:block">' +
                '</button>'
              )
            })
            .join('')
          aiCandidatesEl.querySelectorAll('[data-ai-cand]').forEach(function (candBtn) {
            candBtn.addEventListener('click', function () {
              const idx = Number(candBtn.getAttribute('data-ai-cand'))
              selectedAiAvatarDataUrl = list[idx] || null
              aiCandidatesEl.querySelectorAll('[data-ai-cand]').forEach(function (other) {
                other.style.borderColor = other === candBtn ? '#d97706' : 'transparent'
              })
              if (aiApplyBtn) aiApplyBtn.disabled = !selectedAiAvatarDataUrl
            })
          })
        }
        if (pictoStatus) pictoStatus.textContent = 'Kattints a kedvenc Chibi avatarodra, majd a "Kiválasztott mentése" gombra!'
      } catch (err) {
        if (pictoStatus) pictoStatus.textContent = err.message
      } finally {
        if (btn) btn.disabled = false
      }
    })

    function resizeDataUrlToPng256(dataUrl) {
      return new Promise(function (resolve) {
        const img = new Image()
        img.onload = function () {
          try {
            const c = document.createElement('canvas')
            c.width = 256
            c.height = 256
            const ctx = c.getContext('2d')
            if (ctx) {
              ctx.drawImage(img, 0, 0, 256, 256)
              resolve(c.toDataURL('image/png'))
              return
            }
          } catch { /* fallback */ }
          resolve(dataUrl)
        }
        img.onerror = function () { resolve(dataUrl) }
        img.src = dataUrl
      })
    }

    aiApplyBtn?.addEventListener('click', async function () {
      if (!currentModalAgentId || !selectedAiAvatarDataUrl) return
      aiApplyBtn.disabled = true
      if (pictoStatus) pictoStatus.textContent = 'Avatar mentése...'
      try {
        const compactPng = await resizeDataUrlToPng256(selectedAiAvatarDataUrl)
        const res = await apiJson('/api/vps/agents/personalize', {
          method: 'POST',
          body: JSON.stringify({ agentId: currentModalAgentId, avatarDataUrl: compactPng }),
        })
        if (res.avatarUrl) refreshModalAvatarUrl(res.avatarUrl)
        clearAiAvatarPicker()
        if (pictoStatus) pictoStatus.textContent = '✓ Kiválasztott Chibi avatar elmentve!'
      } catch (err) {
        if (pictoStatus) pictoStatus.textContent = 'Hiba: ' + err.message
        aiApplyBtn.disabled = false
      }
    })

    aiDiscardBtn?.addEventListener('click', function () {
      clearAiAvatarPicker()
      if (pictoStatus) pictoStatus.textContent = 'Generált variációk elvetve (az eredeti avatar maradt).'
    })

    document.getElementById('agentCoreSuggestPersonaBtn')?.addEventListener('click', async function () {
      if (!currentModalAgentId) return
      const btn = document.getElementById('agentCoreSuggestPersonaBtn')
      const box = document.getElementById('agentCorePersonaSuggestions')
      const roleSel = document.getElementById('agentCoreRoleSel')
      if (!box) return
      if (btn) btn.disabled = true
      box.hidden = false
      box.style.display = 'flex'
      box.innerHTML = '<div style="font-size:12px;opacity:.8">✨ Név- és személyiség-javaslatok generálása...</div>'
      try {
        const res = await apiJson('/api/vps/agents/suggest-persona', {
          method: 'POST',
          body: JSON.stringify({ agentId: currentModalAgentId, role: roleSel ? roleSel.value : undefined }),
        })
        const items = res.suggestions || []
        const soulDraft = res.soulDraft || ''
        const chips = items
          .map(function (s, idx) {
            return (
              '<button type="button" class="btn-secondary btn-compact" data-persona-pick="' + idx + '" style="text-align:left;padding:5px 8px;font-size:12px">' +
              esc((s.emoji || '🤖') + ' ' + (s.displayName || '')) +
              (s.tagline ? ' <span style="opacity:.7">— ' + esc(s.tagline) + '</span>' : '') +
              '</button>'
            )
          })
          .join('')
        box.innerHTML =
          '<div style="font-size:11px;font-weight:600;opacity:.75">Kattints egy névre az alkalmazáshoz:</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' + (chips || '<span>Nincs javaslat</span>') + '</div>' +
          (soulDraft ? '<div style="margin-top:4px"><button type="button" class="btn-secondary btn-compact" id="applyPersonaSoulBtn" style="font-size:11px">SOUL.md vázlat beillesztése</button></div>' : '')

        box.querySelectorAll('[data-persona-pick]').forEach(function (pickBtn) {
          pickBtn.addEventListener('click', function () {
            const s = items[Number(pickBtn.getAttribute('data-persona-pick'))]
            if (!s) return
            const nameInp = document.getElementById('agentCoreDisplayNameInp')
            if (nameInp && s.displayName) nameInp.value = s.displayName
            if (s.emoji && pictoIcon) {
              const hasOpt = Array.from(pictoIcon.options).some(function (o) { return o.value === s.emoji })
              if (hasOpt) pictoIcon.value = s.emoji
            }
            if (s.color && /^#[0-9a-f]{6}$/i.test(s.color) && pictoC1) pictoC1.value = s.color
            drawPictogramCanvas()
          })
        })
        document.getElementById('applyPersonaSoulBtn')?.addEventListener('click', function () {
          const soulArea = document.getElementById('editSoulMd')
          if (soulArea && soulDraft) {
            const chosenName = document.getElementById('agentCoreDisplayNameInp')?.value.trim() || ''
            let finalSoul = soulDraft
            if (chosenName) {
              const firstSug = items[0] && items[0].displayName ? String(items[0].displayName).trim() : ''
              if (firstSug && firstSug !== chosenName) {
                finalSoul = finalSoul.split(firstSug).join(chosenName)
              }
              finalSoul = finalSoul.replace(/^#\s+.+$/m, '# ' + chosenName)
            }
            soulArea.value = finalSoul
            coreFileDirty.soul = true
            const det = soulArea.closest('details')
            if (det) det.open = true
          }
        })
      } catch (err) {
        box.innerHTML = '<div style="font-size:12px;color:#dc2626">Hiba: ' + esc(err.message) + '</div>'
      } finally {
        if (btn) btn.disabled = false
      }
    })

    document.getElementById('coreSkillSaveFileBtn')?.addEventListener('click', async function () {
      const btn = document.getElementById('coreSkillSaveFileBtn')
      const statusEl = document.getElementById('coreSkillEditorStatus')
      const id = document.getElementById('coreSkillIdInp')?.value.trim() || ''
      const description = document.getElementById('coreSkillDescInp')?.value.trim() || ''
      const content = document.getElementById('coreSkillContentInp')?.value.trim() || ''
      if (!id || !content) {
        if (statusEl) statusEl.textContent = 'A skill ID és a tartalom kötelező!'
        return
      }
      if (btn) btn.disabled = true
      if (statusEl) statusEl.textContent = 'Mentés...'
      try {
        const res = await apiJson('/api/vps/skills/save', {
          method: 'POST',
          body: JSON.stringify({ id, description, content, agentId: currentModalAgentId || undefined }),
        })
        if (statusEl) statusEl.textContent = 'Skill elmentve és csatolva: ' + res.id
        await ensureVpsRolesData(true)
        if (currentModalAgentId) {
          await loadCoreSkillsForModal(currentModalAgentId)
          const ag = vpsAgentsCache.find(function (a) { return a.id === currentModalAgentId })
          if (ag) applyCoreOverview(ag)
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Hiba: ' + err.message
      } finally {
        if (btn) btn.disabled = false
      }
    })
  }

  window.loadVpsPage = function () {
    wireEvents()
    refreshVpsStatus()
    refreshVpsLogs()
  }

  window.loadProvidersPage = function () {
    wireEvents()
    ensureModelCatalog(false)
    refreshCliProviders()
  }

  wireEvents()
  if (document.getElementById('vpsPage') && !document.getElementById('vpsPage').hidden) {
    window.loadVpsPage()
  }
  if (document.getElementById('providersPage') && !document.getElementById('providersPage').hidden) {
    window.loadProvidersPage()
  }

  // === Phase 4: Voice Communication (Browser STT + AI/Browser TTS) ===
  let vpsChatTtsEnabled = false
  let simTtsEnabled = false
  let activeAudioEl = null
  let activeRecognition = null

  function speakBrowserFallback(text) {
    if (!window.speechSynthesis) return
    try {
      window.speechSynthesis.cancel()
      const clean = String(text || '').replace(/```[\s\S]*?```/g, ' kódblokk ').replace(/[`*_#>~]+/g, ' ').slice(0, 800)
      const u = new SpeechSynthesisUtterance(clean)
      u.lang = 'hu-HU'
      u.rate = 1.02
      window.speechSynthesis.speak(u)
    } catch { /* ignore */ }
  }

  async function speakAgentText(text, agentId, voiceOverride) {
    if (!text) return
    if (activeAudioEl) {
      try { activeAudioEl.pause() } catch { /* ignore */ }
      activeAudioEl = null
    }
    try {
      const res = await apiJson('/api/vps/tts', {
        method: 'POST',
        body: JSON.stringify({ text, agentId: agentId || undefined, voice: voiceOverride || undefined }),
      })
      if (res.audioDataUrl) {
        activeAudioEl = new Audio(res.audioDataUrl)
        await activeAudioEl.play()
        return
      }
    } catch { /* fallback to browser TTS */ }
    speakBrowserFallback(text)
  }

  function toggleVoiceDictation(inputEl, btnEl, statusEl) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      if (statusEl) statusEl.textContent = 'A böngésződ nem támogatja a beszédfelismerést (Chrome / Edge ajánlott).'
      return
    }
    if (activeRecognition) {
      try { activeRecognition.stop() } catch { /* ignore */ }
      activeRecognition = null
      if (btnEl) { btnEl.textContent = '🎤'; btnEl.style.background = ''; btnEl.style.color = '' }
      return
    }
    const rec = new SR()
    rec.lang = 'hu-HU'
    rec.interimResults = true
    rec.continuous = false
    const baseText = inputEl ? inputEl.value.trim() : ''
    activeRecognition = rec
    if (btnEl) { btnEl.textContent = '⏹️'; btnEl.style.background = '#dc2626'; btnEl.style.color = '#fff' }
    if (statusEl) statusEl.textContent = '🎤 Hallgatlak (beszélj magyarul)...'
    rec.onresult = function (event) {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      if (inputEl) inputEl.value = (baseText ? baseText + ' ' : '') + transcript.trim()
    }
    rec.onerror = function (ev) {
      if (statusEl) statusEl.textContent = 'Mikrofon hiba: ' + (ev.error || 'ismeretlen')
    }
    rec.onend = function () {
      activeRecognition = null
      if (btnEl) { btnEl.textContent = '🎤'; btnEl.style.background = ''; btnEl.style.color = '' }
      if (statusEl && statusEl.textContent.indexOf('Hallgatlak') >= 0) {
        statusEl.textContent = 'Diktálás kész — nyomj Entert a küldéshez.'
      }
      if (inputEl) inputEl.focus()
    }
    rec.start()
  }

  document.getElementById('vpsChatTtsToggle')?.addEventListener('click', function () {
    vpsChatTtsEnabled = !vpsChatTtsEnabled
    const btn = document.getElementById('vpsChatTtsToggle')
    if (btn) btn.textContent = vpsChatTtsEnabled ? '🔊' : '🔇'
  })
  document.getElementById('vpsChatMicBtn')?.addEventListener('click', function () {
    toggleVoiceDictation(
      document.getElementById('vpsChatInput'),
      document.getElementById('vpsChatMicBtn'),
      document.getElementById('vpsChatStatus'),
    )
  })
  document.getElementById('agentCoreVoiceTestBtn')?.addEventListener('click', async function () {
    const btn = document.getElementById('agentCoreVoiceTestBtn')
    const voice = document.getElementById('agentCoreVoiceSel')?.value || 'Kore'
    const name = document.getElementById('agentCoreDisplayNameInp')?.value.trim() || currentModalAgentId || 'Alfréd'
    if (btn) btn.disabled = true
    try {
      await speakAgentText('Szia! ' + name + ' vagyok, készen állok a közös munkára!', currentModalAgentId, voice)
    } finally {
      if (btn) btn.disabled = false
    }
  })

  // === Simulated Discord Test Sandbox ===
  let simActiveAgentId = null
  let simAgentsCache = []
  let simWired = false

  function renderSimMessages(messages) {
    const box = document.getElementById('simMessagesBox')
    if (!box) return
    if (!messages || messages.length === 0) {
      box.innerHTML = '<div style="opacity:.6;font-size:13px">Üres szimulált csatorna. Írj egy üzenetet lent!</div>'
      return
    }
    box.innerHTML = messages
      .map(function (m) {
        const isIn = m.direction === 'in'
        return (
          '<div style="padding:8px 10px;border-radius:8px;margin-bottom:8px;border:1px solid var(--border);background:' +
          (isIn ? 'var(--bg)' : 'var(--surface)') + '">' +
          '<div style="font-size:11px;opacity:.7;margin-bottom:4px">' +
          '<b>' + esc(isIn ? (m.sender_name || 'Tester') : m.agent_id) + '</b>' +
          ' · ' + esc((m.ts || '').slice(0, 19).replace('T', ' ')) +
          '</div>' +
          '<div style="white-space:pre-wrap;font-size:13px;word-break:break-word">' + esc(m.text) + '</div>' +
          '</div>'
        )
      })
      .join('')
    box.scrollTop = box.scrollHeight
  }

  async function refreshSimMessages() {
    if (!simActiveAgentId) return
    try {
      const data = await apiJson('/api/test-sim/messages?agentId=' + encodeURIComponent(simActiveAgentId) + '&limit=50')
      renderSimMessages(data.messages || [])
    } catch { /* ignore */ }
  }

  function renderSimChannelHeader() {
    const hdr = document.getElementById('simChannelHeader')
    const ag = simAgentsCache.find(function (a) { return a.id === simActiveAgentId })
    if (!hdr || !ag) return
    hdr.innerHTML =
      '<div><strong>' + esc(ag.channelName) + '</strong> <span style="font-size:12px;opacity:.75">(' + esc(ag.id) + ')</span></div>' +
      '<div style="font-size:12px;opacity:.85">' +
      'Munkakör: <b>' + esc(ag.role || '—') + '</b> · ' +
      'Modell: <code>' + esc(ag.provider + ' / ' + ag.model) + '</code> · ' +
      'Költés: $' + Number(ag.spendUsd || 0).toFixed(4) + ' / $' + Number(ag.dailyBudgetUsd || 0).toFixed(2) +
      '</div>'
  }

  async function refreshTestSim() {
    const offlineEl = document.getElementById('simOfflineBanner')
    const mainEl = document.getElementById('simMainGrid')
    const listEl = document.getElementById('simChannelsList')
    const budgetEl = document.getElementById('simBudgetBox')
    if (!listEl) return
    try {
      const data = await apiJson('/api/test-sim/status')
      if (offlineEl) offlineEl.hidden = true
      if (mainEl) mainEl.style.display = 'grid'
      simAgentsCache = data.agents || []
      if (!simActiveAgentId && simAgentsCache.length > 0) {
        simActiveAgentId = simAgentsCache[0].id
      }
      listEl.innerHTML = simAgentsCache
        .map(function (a) {
          const active = a.id === simActiveAgentId
          return (
            '<button type="button" data-sim-ch="' + esc(a.id) + '" style="text-align:left;padding:8px 10px;border-radius:8px;border:1px solid var(--border);cursor:pointer;background:' +
            (active ? 'var(--accent, #2563eb)' : 'var(--bg)') + ';color:' + (active ? '#fff' : 'inherit') + '">' +
            '<div style="font-weight:600;font-size:13px">' + esc(a.channelName) + '</div>' +
            '<div style="font-size:11px;opacity:.8">' + esc(a.role || a.id) + ' · ' + esc(a.model) + '</div>' +
            '</button>'
          )
        })
        .join('')
      listEl.querySelectorAll('[data-sim-ch]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          simActiveAgentId = btn.getAttribute('data-sim-ch')
          refreshTestSim()
        })
      })
      if (budgetEl) {
        budgetEl.innerHTML = '<b>Teszt napi keret:</b> $' + Number(data.globalSpendUsd || 0).toFixed(4) + ' / $' + Number(data.globalBudgetUsd || 0).toFixed(2)
      }
      renderSimChannelHeader()
      await refreshSimMessages()
    } catch {
      if (offlineEl) offlineEl.hidden = false
      if (mainEl) mainEl.style.display = 'none'
    }
  }

  async function sendSimMessage() {
    const input = document.getElementById('simInput')
    const btn = document.getElementById('simSendBtn')
    const status = document.getElementById('simSendStatus')
    if (!input || !btn || !simActiveAgentId) return
    const text = input.value.trim()
    if (!text) return
    btn.disabled = true
    if (status) status.textContent = '🧪 [TEST] végrehajtás folyamatban...'
    try {
      const res = await apiJson('/api/test-sim/send', {
        method: 'POST',
        body: JSON.stringify({ agentId: simActiveAgentId, content: text }),
      })
      input.value = ''
      if (status) status.textContent = 'Kész (' + (res.status || 'ok') + ')'
      await refreshSimMessages()
      await refreshTestSim()
      if (simTtsEnabled && res.replyText) {
        speakAgentText(res.replyText, simActiveAgentId)
      }
    } catch (err) {
      if (status) status.textContent = 'Hiba: ' + err.message
    } finally {
      btn.disabled = false
    }
  }

  function wireSimEvents() {
    if (simWired) return
    simWired = true
    document.getElementById('simReloadBtn')?.addEventListener('click', refreshTestSim)
    document.getElementById('simSendBtn')?.addEventListener('click', sendSimMessage)
    document.getElementById('simTtsToggle')?.addEventListener('click', function () {
      simTtsEnabled = !simTtsEnabled
      const btn = document.getElementById('simTtsToggle')
      if (btn) btn.textContent = simTtsEnabled ? '🔊 Felolvasás BE' : '🔇 Felolvasás KI'
    })
    document.getElementById('simMicBtn')?.addEventListener('click', function () {
      toggleVoiceDictation(
        document.getElementById('simInput'),
        document.getElementById('simMicBtn'),
        document.getElementById('simSendStatus'),
      )
    })
    document.getElementById('simInput')?.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendSimMessage()
      }
    })
    document.getElementById('simSpinupBtn')?.addEventListener('click', async function () {
      const btn = document.getElementById('simSpinupBtn')
      const out = document.getElementById('simSpinupOut')
      if (!btn || !out) return
      btn.disabled = true
      out.hidden = false
      out.textContent = 'Indítás (reload-test)...'
      try {
        const res = await apiJson('/api/vps/ops', { method: 'POST', body: JSON.stringify({ action: 'reload-test' }) })
        out.textContent = res.output || 'Elindítva.'
        refreshTestSim()
      } catch (err) {
        out.textContent = 'Hiba: ' + err.message
      } finally {
        btn.disabled = false
      }
    })
  }

  window.loadTestSimPage = function () {
    wireSimEvents()
    refreshTestSim()
  }

  const isTestEnv = Boolean(document.getElementById('alfredTestBanner'))
  const simNav = document.getElementById('sbTestSim')
  if (simNav) simNav.hidden = !isTestEnv

  wireSimEvents()
  if (!location.hash && isTestEnv) {
    location.hash = 'testsim'
  }
  if (isTestEnv && (location.hash === '#testsim' || !document.getElementById('testsimPage')?.hidden)) {
    window.loadTestSimPage()
  }
})()
