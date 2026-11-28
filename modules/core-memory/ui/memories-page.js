// Core Memory sidebar page module (#memories) — zero-build ES6, XSS-safe DOM rendering.

const mountedCleanups = new WeakMap();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return String(isoStr);
  return dt.toLocaleString();
}

export function mount(container, ctx = {}) {
  if (!container) return { unmount() {} };
  unmount(container);

  const controller = new AbortController();
  const { signal } = controller;

  const fetchImpl =
    ctx && typeof ctx.fetch === 'function'
      ? ctx.fetch.bind(ctx)
      : globalThis.fetch.bind(globalThis);

  async function apiJson(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && ctx && ctx.csrfToken) {
      headers.set('X-CSRF-Token', String(ctx.csrfToken));
    }
    const res = await fetchImpl(url, {
      credentials: 'same-origin',
      ...options,
      method,
      headers,
      signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = payload.message || payload.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return payload;
  }

  let currentNamespace = (ctx && ctx.defaultNamespace) || 'default';
  let editingId = null;
  let searchTimer = null;

  const root = el('div', 'core-memory-page');
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.gap = '14px';

  // Header
  const header = el('div', 'page-header');
  const headerRow = el('div', 'page-header-row');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.flexWrap = 'wrap';
  headerRow.style.gap = '10px';

  const titleBox = el('div');
  titleBox.append(
    el('h1', null, 'Memories'),
    el('p', 'subtitle', 'Namespace-isolated FTS5 knowledge store with version history')
  );

  const addBtn = el('button', 'btn-primary btn-compact', '+ New Memory');
  addBtn.type = 'button';
  headerRow.append(titleBox, addBtn);
  header.append(headerRow);

  // Status banner
  const statusEl = el('div', 'core-memory-status');
  statusEl.setAttribute('role', 'status');
  statusEl.hidden = true;
  statusEl.style.padding = '8px 12px';
  statusEl.style.borderRadius = '8px';
  statusEl.style.border = '1px solid var(--border, #d1cfc5)';
  statusEl.style.background = 'var(--bg-card, #ffffff)';
  statusEl.style.fontSize = '13px';

  // Toolbar
  const toolbar = el('div', 'mem-toolbar');
  toolbar.style.display = 'flex';
  toolbar.style.gap = '8px';
  toolbar.style.flexWrap = 'wrap';
  toolbar.style.alignItems = 'center';

  const nsSelect = el('select', 'mem-agent-filter');
  nsSelect.setAttribute('aria-label', 'Namespace');
  const defaultOpt = el('option', null, 'default');
  defaultOpt.value = 'default';
  nsSelect.append(defaultOpt);

  const nsInput = el('input', 'mem-search');
  nsInput.type = 'text';
  nsInput.placeholder = 'Namespace (e.g. alfred-architect)';
  nsInput.value = currentNamespace;
  nsInput.setAttribute('aria-label', 'Custom namespace');
  nsInput.style.maxWidth = '210px';

  const searchInput = el('input', 'mem-search');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search memories (FTS5 / fallback)...';
  searchInput.setAttribute('aria-label', 'Search memories');
  searchInput.style.flex = '1 1 220px';

  const catSelect = el('select', 'mem-search-mode');
  catSelect.setAttribute('aria-label', 'Category filter');
  for (const [val, label] of [
    ['', 'All categories'],
    ['general', 'general'],
    ['hot', 'hot'],
    ['warm', 'warm'],
    ['cold', 'cold'],
    ['shared', 'shared'],
  ]) {
    const opt = el('option', null, label);
    opt.value = val;
    catSelect.append(opt);
  }

  const refreshBtn = el('button', 'btn-secondary btn-compact', 'Refresh');
  refreshBtn.type = 'button';

  toolbar.append(nsSelect, nsInput, searchInput, catSelect, refreshBtn);

  // Editor form card
  const formCard = el('form', 'card');
  formCard.hidden = true;
  formCard.style.padding = '14px';
  formCard.style.border = '1px solid var(--border, #d1cfc5)';
  formCard.style.borderRadius = '10px';
  formCard.style.background = 'var(--bg-card, #ffffff)';
  formCard.style.display = 'flex';
  formCard.style.flexDirection = 'column';
  formCard.style.gap = '10px';

  const formHeading = el('h3', null, 'New Memory');
  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Title (optional — derived from content if blank)';
  titleInput.style.padding = '8px 10px';
  titleInput.style.border = '1px solid var(--border, #d1cfc5)';
  titleInput.style.borderRadius = '8px';

  const contentInput = el('textarea');
  contentInput.rows = 4;
  contentInput.required = true;
  contentInput.placeholder = 'Memory content...';
  contentInput.style.padding = '8px 10px';
  contentInput.style.border = '1px solid var(--border, #d1cfc5)';
  contentInput.style.borderRadius = '8px';

  const metaRow = el('div');
  metaRow.style.display = 'flex';
  metaRow.style.gap = '8px';
  metaRow.style.flexWrap = 'wrap';

  const keywordsInput = el('input');
  keywordsInput.type = 'text';
  keywordsInput.placeholder = 'Keywords (comma-separated)';
  keywordsInput.style.flex = '1 1 200px';
  keywordsInput.style.padding = '8px 10px';
  keywordsInput.style.border = '1px solid var(--border, #d1cfc5)';
  keywordsInput.style.borderRadius = '8px';

  const formCategoryInput = el('input');
  formCategoryInput.type = 'text';
  formCategoryInput.value = 'general';
  formCategoryInput.placeholder = 'Category';
  formCategoryInput.style.width = '120px';
  formCategoryInput.style.padding = '8px 10px';
  formCategoryInput.style.border = '1px solid var(--border, #d1cfc5)';
  formCategoryInput.style.borderRadius = '8px';

  const importanceInput = el('input');
  importanceInput.type = 'number';
  importanceInput.min = '1';
  importanceInput.max = '10';
  importanceInput.value = '5';
  importanceInput.setAttribute('aria-label', 'Importance (1-10)');
  importanceInput.style.width = '80px';
  importanceInput.style.padding = '8px 10px';
  importanceInput.style.border = '1px solid var(--border, #d1cfc5)';
  importanceInput.style.borderRadius = '8px';

  metaRow.append(keywordsInput, formCategoryInput, importanceInput);

  const formActions = el('div');
  formActions.style.display = 'flex';
  formActions.style.gap = '8px';
  const saveBtn = el('button', 'btn-primary btn-compact', 'Save');
  saveBtn.type = 'submit';
  const cancelBtn = el('button', 'btn-secondary btn-compact', 'Cancel');
  cancelBtn.type = 'button';
  formActions.append(saveBtn, cancelBtn);

  formCard.append(formHeading, titleInput, contentInput, metaRow, formActions);

  // List & empty state
  const summaryBar = el('div', 'mem-search-label');
  summaryBar.style.fontSize = '12px';
  summaryBar.style.opacity = '0.8';

  const listEl = el('div', 'mem-list');
  const emptyEl = el('div', 'mem-empty');
  emptyEl.hidden = true;
  emptyEl.append(el('p', null, 'No memories found in this namespace.'));

  root.append(header, statusEl, toolbar, formCard, summaryBar, listEl, emptyEl);
  container.replaceChildren(root);

  function showStatus(message, isError = false) {
    statusEl.hidden = !message;
    statusEl.textContent = message || '';
    statusEl.style.borderColor = isError
      ? 'var(--danger, #bf4d43)'
      : 'var(--border, #d1cfc5)';
    statusEl.style.color = isError ? 'var(--danger, #bf4d43)' : 'inherit';
  }

  function openForm(mem = null) {
    editingId = mem ? mem.id : null;
    formHeading.textContent = mem ? `Edit Memory (${mem.id})` : 'New Memory';
    titleInput.value = mem ? mem.title || '' : '';
    contentInput.value = mem ? mem.content || '' : '';
    keywordsInput.value = mem ? mem.keywords || '' : '';
    formCategoryInput.value = mem ? mem.category || 'general' : 'general';
    importanceInput.value = mem ? String(mem.importance ?? 5) : '5';
    formCard.hidden = false;
    contentInput.focus();
  }

  function closeForm() {
    editingId = null;
    formCard.hidden = true;
  }

  async function loadNamespaces() {
    try {
      const data = await apiJson('/api/agents');
      const agents = Array.isArray(data.agents) ? data.agents : [];
      const seen = new Set(['default']);
      for (const a of agents) {
        if (a && a.id) seen.add(String(a.id));
      }
      nsSelect.replaceChildren();
      for (const ns of seen) {
        const opt = el('option', null, ns);
        opt.value = ns;
        nsSelect.append(opt);
      }
      if (seen.has(currentNamespace)) {
        nsSelect.value = currentNamespace;
      }
    } catch {
      // Optional enrichment; page works cleanly with manual namespace input.
    }
  }

  function renderVersionsPanel(panel, versions) {
    panel.replaceChildren();
    if (!versions || versions.length === 0) {
      panel.append(el('div', null, 'No version history available.'));
      return;
    }
    for (const v of versions) {
      const row = el('div');
      row.style.padding = '6px 8px';
      row.style.borderTop = '1px solid var(--border, #d1cfc5)';
      row.style.fontSize = '12px';

      const head = el(
        'div',
        null,
        `v${v.version} · ${v.title} · ${formatDate(v.created_at)}`
      );
      head.style.fontWeight = '600';
      const body = el('div', null, v.content);
      body.style.whiteSpace = 'pre-wrap';
      body.style.marginTop = '2px';
      row.append(head, body);
      panel.append(row);
    }
  }

  function renderMemories(data) {
    const items = Array.isArray(data.memories) ? data.memories : [];
    summaryBar.textContent = `Namespace: ${data.namespace || currentNamespace} · Showing ${items.length} of ${data.total ?? items.length} (${data.search_mode || 'list'})`;
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;

    for (const mem of items) {
      const card = el('div', 'mem-item');

      const cardHead = el('div', 'mem-item-header');
      cardHead.append(
        el('span', 'badge', mem.category || 'general'),
        el('span', 'mem-agent-badge', mem.namespace),
        el('span', 'mem-date', `v${mem.version} · imp ${mem.importance}`),
        el('span', 'mem-use-badge', `uses: ${mem.use_count ?? 0}`)
      );

      const cardTitle = el('div', 'mem-title', mem.title);
      const cardBody = el('div', 'mem-content-short', mem.content);
      cardBody.style.whiteSpace = 'pre-wrap';

      const kwWrap = el('div', 'mem-keywords');
      if (mem.keywords) {
        for (const kw of String(mem.keywords)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          kwWrap.append(el('span', 'mem-keyword-tag', kw));
        }
      }

      const versionsPanel = el('div', 'mem-ref-preview');
      versionsPanel.hidden = true;

      const footer = el('div', 'mem-item-footer');
      footer.style.display = 'flex';
      footer.style.gap = '6px';
      footer.style.flexWrap = 'wrap';

      const readBtn = el('button', 'btn-secondary btn-compact', 'Read');
      readBtn.type = 'button';
      readBtn.addEventListener(
        'click',
        async () => {
          try {
            const ns = encodeURIComponent(currentNamespace);
            const detail = await apiJson(
              `/api/memories/${encodeURIComponent(mem.id)}?namespace=${ns}`
            );
            showStatus(
              `Read ${detail.id} (v${detail.version}, uses=${detail.use_count}, last_used=${formatDate(detail.last_used_at)})`
            );
            await refreshList();
          } catch (err) {
            showStatus(err.message, true);
          }
        },
        { signal }
      );

      const versionsBtn = el('button', 'btn-secondary btn-compact', 'Versions');
      versionsBtn.type = 'button';
      versionsBtn.addEventListener(
        'click',
        async () => {
          if (!versionsPanel.hidden) {
            versionsPanel.hidden = true;
            return;
          }
          try {
            const ns = encodeURIComponent(currentNamespace);
            const res = await apiJson(
              `/api/memories/${encodeURIComponent(mem.id)}/versions?namespace=${ns}`
            );
            renderVersionsPanel(versionsPanel, res.versions);
            versionsPanel.hidden = false;
          } catch (err) {
            showStatus(err.message, true);
          }
        },
        { signal }
      );

      const editBtn = el('button', 'btn-secondary btn-compact', 'Edit');
      editBtn.type = 'button';
      editBtn.addEventListener('click', () => openForm(mem), { signal });

      const delBtn = el('button', 'btn-danger btn-compact', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener(
        'click',
        async () => {
          try {
            const ns = encodeURIComponent(currentNamespace);
            await apiJson(
              `/api/memories/${encodeURIComponent(mem.id)}?namespace=${ns}`,
              { method: 'DELETE' }
            );
            showStatus(`Deleted memory ${mem.id}`);
            await refreshList();
          } catch (err) {
            showStatus(err.message, true);
          }
        },
        { signal }
      );

      footer.append(readBtn, versionsBtn, editBtn, delBtn);
      card.append(cardHead, cardTitle, cardBody);
      if (kwWrap.childElementCount > 0) card.append(kwWrap);
      card.append(versionsPanel, footer);
      listEl.append(card);
    }
  }

  async function refreshList() {
    currentNamespace = nsInput.value.trim() || 'default';
    const params = new URLSearchParams();
    params.set('namespace', currentNamespace);
    params.set('limit', '50');
    const q = searchInput.value.trim();
    if (q) params.set('q', q);
    const cat = catSelect.value.trim();
    if (cat) params.set('category', cat);

    try {
      const data = await apiJson(`/api/memories?${params.toString()}`);
      renderMemories(data);
    } catch (err) {
      if (err.name !== 'AbortError') {
        showStatus(err.message, true);
      }
    }
  }

  addBtn.addEventListener('click', () => openForm(null), { signal });
  cancelBtn.addEventListener('click', closeForm, { signal });
  refreshBtn.addEventListener('click', () => void refreshList(), { signal });

  nsSelect.addEventListener(
    'change',
    () => {
      nsInput.value = nsSelect.value;
      void refreshList();
    },
    { signal }
  );

  nsInput.addEventListener(
    'change',
    () => {
      void refreshList();
    },
    { signal }
  );

  catSelect.addEventListener('change', () => void refreshList(), { signal });

  searchInput.addEventListener(
    'input',
    () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void refreshList(), 250);
    },
    { signal }
  );

  formCard.addEventListener(
    'submit',
    async (evt) => {
      evt.preventDefault();
      const ns = nsInput.value.trim() || 'default';
      const content = contentInput.value.trim();
      if (!content) {
        showStatus('Content is required.', true);
        return;
      }
      const importanceVal = Number(importanceInput.value || 5);
      const bodyPayload = {
        namespace: ns,
        content,
        keywords: keywordsInput.value.trim(),
        category: formCategoryInput.value.trim() || 'general',
        importance: Number.isFinite(importanceVal) ? importanceVal : 5,
      };
      const titleText = titleInput.value.trim();
      if (titleText) bodyPayload.title = titleText;

      try {
        if (editingId) {
          await apiJson(
            `/api/memories/${encodeURIComponent(editingId)}?namespace=${encodeURIComponent(ns)}`,
            {
              method: 'PATCH',
              body: JSON.stringify(bodyPayload),
            }
          );
          showStatus(`Updated memory ${editingId}`);
        } else {
          const created = await apiJson('/api/memories', {
            method: 'POST',
            body: JSON.stringify(bodyPayload),
          });
          showStatus(`Saved memory ${created.id} (v${created.version})`);
        }
        closeForm();
        await refreshList();
      } catch (err) {
        showStatus(err.message, true);
      }
    },
    { signal }
  );

  function cleanup() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    controller.abort();
    container.replaceChildren();
    mountedCleanups.delete(container);
  }

  mountedCleanups.set(container, cleanup);
  void loadNamespaces();
  void refreshList();

  return {
    unmount() {
      cleanup();
    },
  };
}

export function unmount(container) {
  if (!container) return;
  const cleanup = mountedCleanups.get(container);
  if (typeof cleanup === 'function') {
    cleanup();
    return;
  }
  container.replaceChildren();
}
