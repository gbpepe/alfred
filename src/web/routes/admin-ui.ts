/**
 * Self-contained, zero-dependency dark-themed Admin Dashboard HTML page served at `/admin`.
 * Authenticates all API requests against `/api/admin/*` with `DASHBOARD_TOKEN` stored in `sessionStorage`.
 */
export function renderAdminDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Alfred Admin — CLI &amp; Ügynök Felügyelet</title>
  <style>
    :root {
      --bg: #0b0f17;
      --surface: #131a26;
      --surface-2: #1a2333;
      --border: #263248;
      --text: #e6edf7;
      --muted: #93a4bd;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --green: #16a34a;
      --amber: #d97706;
      --red: #dc2626;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
    header {
      display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
      gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--border); margin-bottom: 18px;
    }
    h1 { font-size: 20px; margin: 0; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .muted { color: var(--muted); font-size: 13px; }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px; margin-bottom: 16px;
    }
    .grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;
    }
    .subcard {
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600; color: #fff; background: #475569;
    }
    .badge.ok { background: var(--green); }
    .badge.warn { background: var(--amber); }
    .badge.err { background: var(--red); }
    .badge.info { background: var(--primary); }
    .mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
    input[type="password"], input[type="text"] {
      width: 100%; max-width: 380px; padding: 8px 10px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 13px;
    }
    button {
      border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px;
      font-size: 12px; font-weight: 600; cursor: pointer; background: var(--surface-2); color: var(--text);
    }
    button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
    button.primary:hover:not(:disabled) { background: var(--primary-hover); }
    button.danger { background: rgba(220, 38, 38, 0.16); border-color: rgba(220, 38, 38, 0.5); color: #fca5a5; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .metrics { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    .table-wrap { overflow-x: auto; }
    .status-line { margin-top: 10px; font-size: 12px; color: var(--muted); min-height: 18px; }
    .status-line.err { color: #fca5a5; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Alfred Admin</h1>
        <div class="muted">CLI Szolgáltatók, Ügynökök &amp; CostOps Felügyelet</div>
      </div>
      <div class="row" id="headerActions" hidden>
        <button id="refreshAllBtn" class="primary">Frissítés</button>
        <button id="logoutBtn">Kijelentkezés</button>
      </div>
    </header>

    <section class="card" id="loginSection">
      <h2>Bejelentkezés (DASHBOARD_TOKEN)</h2>
      <p class="muted" style="margin-top:0">A token kizárólag a böngésző <code>sessionStorage</code> tárhelyén marad, és <code>Authorization: Bearer</code> fejléccel kerül elküldésre.</p>
      <form id="loginForm" class="row" style="justify-content:flex-start">
        <input type="password" id="tokenInput" placeholder="DASHBOARD_TOKEN..." autocomplete="current-password" required />
        <button type="submit" class="primary">Belépés</button>
      </form>
      <div id="loginError" class="status-line err"></div>
    </section>

    <main id="dashboardMain" hidden>
      <section class="card">
        <div class="row" style="margin-bottom:8px">
          <h2 style="margin:0">VPS &amp; CLI Várólista</h2>
          <span id="globalBudgetBadge" class="badge info">Költés: —</span>
        </div>
        <div id="systemMetrics" class="metrics muted">Betöltés...</div>
      </section>

      <section class="card">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">CLI Szolgáltatók</h2>
          <button id="refreshClisBtn">Állapot ellenőrzése</button>
        </div>
        <div id="cliGrid" class="grid"></div>
        <div id="cliStatus" class="status-line"></div>
      </section>

      <section class="card">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">Ügynökök &amp; Költségkeret</h2>
          <span class="muted" id="agentCountLabel"></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ügynök</th>
                <th>Motor &amp; Modell</th>
                <th>Fallback</th>
                <th>Napi költés / Keret</th>
                <th>Eszközök</th>
              </tr>
            </thead>
            <tbody id="agentsTableBody"></tbody>
          </table>
        </div>
      </section>
    </main>
  </div>

  <script>
    (function () {
      var STORAGE_KEY = 'alfred_admin_token';
      var loginSection = document.getElementById('loginSection');
      var dashboardMain = document.getElementById('dashboardMain');
      var headerActions = document.getElementById('headerActions');
      var loginForm = document.getElementById('loginForm');
      var tokenInput = document.getElementById('tokenInput');
      var loginError = document.getElementById('loginError');

      function esc(val) {
        return String(val == null ? '' : val)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function getToken() {
        return sessionStorage.getItem(STORAGE_KEY) || '';
      }

      function setToken(tok) {
        if (tok) sessionStorage.setItem(STORAGE_KEY, tok);
        else sessionStorage.removeItem(STORAGE_KEY);
      }

      function showLogin(msg) {
        loginSection.hidden = false;
        dashboardMain.hidden = true;
        headerActions.hidden = true;
        loginError.textContent = msg || '';
      }

      function showDashboard() {
        loginSection.hidden = true;
        dashboardMain.hidden = false;
        headerActions.hidden = false;
        loginError.textContent = '';
      }

      async function adminFetch(url, opts) {
        var tok = getToken();
        var headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
        var res = await fetch(url, Object.assign({}, opts || {}, { headers: headers, credentials: 'same-origin' }));
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 401 || res.status === 403) {
          setToken('');
          showLogin(data.error || 'Érvénytelen vagy hiányzó DASHBOARD_TOKEN.');
          throw new Error(data.error || 'HTTP ' + res.status);
        }
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        return data;
      }

      function renderClis(clis) {
        var grid = document.getElementById('cliGrid');
        grid.innerHTML = (clis || []).map(function (c) {
          var instBadge = c.installed
            ? '<span class="badge ok">' + esc(c.version || 'telepítve') + '</span>'
            : '<span class="badge">nincs telepítve</span>';
          var authBadge = c.authConfigured
            ? '<span class="badge info">auth OK</span>'
            : '<span class="badge warn">nincs belépve</span>';
          return (
            '<div class="subcard">' +
              '<div class="row"><strong>' + esc(c.provider) + '</strong><div class="badges">' + instBadge + authBadge + '</div></div>' +
              '<div class="mono muted">' + esc(c.packageName) + '</div>' +
              '<div class="mono muted">' + esc(c.resolvedPath || c.prefix || '—') + '</div>' +
              '<div class="row" style="justify-content:flex-start;margin-top:4px">' +
                '<button class="primary" data-cli-act="install" data-cli-id="' + esc(c.id) + '">' + (c.installed ? 'Frissítés' : 'Telepítés') + '</button>' +
                '<button class="danger" data-cli-act="remove" data-cli-id="' + esc(c.id) + '"' + (c.installed ? '' : ' disabled') + '>Eltávolítás</button>' +
              '</div>' +
            '</div>'
          );
        }).join('');

        grid.querySelectorAll('[data-cli-act]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var act = btn.getAttribute('data-cli-act');
            var id = btn.getAttribute('data-cli-id');
            var st = document.getElementById('cliStatus');
            btn.disabled = true;
            st.className = 'status-line';
            st.textContent = (act === 'install' ? 'Telepítés / frissítés folyamatban: ' : 'Eltávolítás folyamatban: ') + id + '...';
            try {
              var resp = await adminFetch('/api/admin/clis/' + encodeURIComponent(id) + '/' + act, { method: 'POST', body: '{}' });
              renderClis(resp.clis || []);
              st.textContent = id + (act === 'install' ? ' sikeresen telepítve / frissítve.' : ' eltávolítva.');
            } catch (err) {
              st.className = 'status-line err';
              st.textContent = 'Hiba (' + id + '): ' + err.message;
              btn.disabled = false;
            }
          });
        });
      }

      function renderOverview(data) {
        var sys = data.system || {};
        var q = data.cliQueue || {};
        var costs = data.costs || {};
        var g = data.global || {};
        var spendUsd = typeof costs.globalSpendUsd === 'number' ? costs.globalSpendUsd : 0;
        var limitUsd = typeof costs.globalBudgetUsd === 'number' ? costs.globalBudgetUsd : (g.dailyBudgetUsd || 0);
        document.getElementById('globalBudgetBadge').textContent = 'Napi globális: $' + spendUsd.toFixed(4) + ' / $' + Number(limitUsd).toFixed(2);
        document.getElementById('systemMetrics').innerHTML =
          '<span><b>Host:</b> ' + esc(sys.hostname || '—') + '</span>' +
          '<span><b>RAM:</b> ' + esc(sys.memUsedMb) + ' / ' + esc(sys.memTotalMb) + ' MB (' + esc(sys.memAvailMb) + ' MB szabad)</span>' +
          '<span><b>Uptime:</b> ' + esc(Math.round((sys.uptimeSec || 0) / 60)) + ' perc</span>' +
          (sys.diskSummary ? '<span><b>Lemez:</b> ' + esc(sys.diskSummary) + '</span>' : '') +
          '<span><b>CLI mutex:</b> aktív ' + esc(q.active || 0) + '/' + esc(q.maxConcurrency || 1) + ', várakozik ' + esc(q.queued || 0) + '</span>';

        var agents = data.agents || [];
        document.getElementById('agentCountLabel').textContent = agents.length + ' konfigurált ágens';
        document.getElementById('agentsTableBody').innerHTML = agents.map(function (a) {
          var fb = a.fallback ? (esc(a.fallback.provider) + ' / ' + esc(a.fallback.model)) : '<span class="muted">fail-closed</span>';
          var spend = typeof a.spendUsd === 'number' ? a.spendUsd : 0;
          var budget = typeof a.dailyBudgetUsd === 'number' ? a.dailyBudgetUsd : 0;
          return (
            '<tr>' +
              '<td><strong>' + esc(a.id) + '</strong><div class="muted">' + esc(a.channelName) + (a.role ? ' · ' + esc(a.role) : '') + '</div></td>' +
              '<td class="mono">' + esc(a.provider) + '<br>' + esc(a.model) + '</td>' +
              '<td class="mono">' + fb + '</td>' +
              '<td class="mono">$' + spend.toFixed(4) + ' / $' + budget.toFixed(2) + '</td>' +
              '<td class="mono">' + esc((a.tools || []).join(', ') || '—') + '</td>' +
            '</tr>'
          );
        }).join('');
      }

      async function loadAll() {
        var results = await Promise.all([
          adminFetch('/api/admin/overview'),
          adminFetch('/api/admin/clis')
        ]);
        showDashboard();
        renderOverview(results[0]);
        renderClis(results[1].clis || []);
      }

      loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var tok = (tokenInput.value || '').trim();
        if (!tok) return;
        setToken(tok);
        loginError.textContent = 'Ellenőrzés...';
        try {
          await loadAll();
          tokenInput.value = '';
        } catch (err) {
          loginError.textContent = err.message || 'Sikertelen belépés';
        }
      });

      document.getElementById('logoutBtn').addEventListener('click', function () {
        setToken('');
        showLogin('');
      });

      document.getElementById('refreshAllBtn').addEventListener('click', function () {
        loadAll().catch(function () {});
      });

      document.getElementById('refreshClisBtn').addEventListener('click', async function () {
        var st = document.getElementById('cliStatus');
        st.className = 'status-line';
        st.textContent = 'Állapot frissítése...';
        try {
          var data = await adminFetch('/api/admin/clis');
          renderClis(data.clis || []);
          st.textContent = 'Frissítve.';
        } catch (err) {
          st.className = 'status-line err';
          st.textContent = err.message;
        }
      });

      if (getToken()) {
        loadAll().catch(function () {});
      } else {
        showLogin('');
      }
    })();
  </script>
</body>
</html>
`
}
