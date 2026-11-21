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
          opt.textContent = a.id + ' (' + a.model + ')'
          chatSelect.appendChild(opt)
        })
      }
    } catch (err) {
      sysEl.textContent = 'Hiba: ' + err.message
    }
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

  async function runOpsAction(action) {
    const outEl = document.getElementById('vpsOpsOutput')
    if (!outEl) return
    outEl.hidden = false
    outEl.textContent = 'Futtatás: ' + action + ' ...'
    try {
      const data = await apiJson('/api/vps/ops', {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      outEl.textContent = data.output || 'Kész.'
      refreshVpsStatus()
    } catch (err) {
      outEl.textContent = 'Hiba: ' + err.message
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
          return (
            '<div style="margin-bottom:10px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">' +
            '<label class="form-label-sm" style="margin:0">' + esc(p.label) + '</label>' +
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
          if (msgEl) {
            msgEl.textContent = 'Mentve: ' + (res.updated || []).join(', ') + ' (újraindítás után lép életbe a többi szolgáltatásban).'
            msgEl.className = 'onb-msg ok'
          }
          body.querySelectorAll('[data-provider-key]').forEach(function (inp) { inp.value = '' })
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

  let wired = false
  function wireEvents() {
    if (wired) return
    wired = true
    document.getElementById('vpsOpenApiWizardBtn')?.addEventListener('click', openModelApiWizard)
    document.getElementById('vpsRefreshBtn')?.addEventListener('click', function () {
      refreshVpsStatus()
      refreshVpsLogs()
      refreshConversations()
    })
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
        runOpsAction(btn.getAttribute('data-vps-ops'))
      })
    })
  }

  window.loadVpsPage = function () {
    wireEvents()
    refreshVpsStatus()
    refreshVpsLogs()
    refreshConversations()
  }

  wireEvents()
  if (location.hash === '#vps' || !document.getElementById('vpsPage')?.hidden) {
    window.loadVpsPage()
  }
})()
