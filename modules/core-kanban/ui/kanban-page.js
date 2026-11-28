// Build-free ES6 Dashboard module UI for `core-kanban`.
// Uses safe DOM APIs only (`createElement` / `textContent`, zero raw HTML injection).

const COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

const PRIORITIES = ["low", "medium", "high", "urgent"];
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const STYLE_ELEMENT_ID = "alfred-core-kanban-styles";

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    .ck-root { display: flex; flex-direction: column; gap: 16px; color: var(--text, #141413); }
    .ck-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 14px; background: var(--bg-card, #fff); border: 1px solid var(--border, #d1cfc5); border-radius: 10px; }
    .ck-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .ck-grow { flex: 1 1 auto; }
    .ck-input, .ck-select, .ck-textarea { padding: 6px 10px; border: 1px solid var(--border, #d1cfc5); border-radius: 6px; background: var(--bg-input, #f0eee6); color: var(--text, #141413); font: inherit; font-size: 13px; }
    .ck-textarea { width: 100%; min-height: 54px; resize: vertical; }
    .ck-btn { padding: 6px 12px; border: 1px solid var(--border, #d1cfc5); border-radius: 6px; background: var(--bg-card, #fff); color: var(--text, #141413); font: inherit; font-size: 13px; cursor: pointer; }
    .ck-btn-primary { background: var(--accent, #d97757); border-color: var(--accent, #d97757); color: #fff; }
    .ck-btn-danger { color: var(--danger, #bf4d43); border-color: var(--danger, #bf4d43); }
    .ck-btn-sm { padding: 3px 8px; font-size: 12px; }
    .ck-status { font-size: 13px; color: var(--text-dim, #68675f); min-height: 18px; }
    .ck-status-error { color: var(--danger, #bf4d43); }
    .ck-labels-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; background: var(--bg-card, #fff); border: 1px solid var(--border, #d1cfc5); border-radius: 10px; }
    .ck-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; color: #fff; background: #64748b; }
    .ck-pill-btn { border: none; background: transparent; color: inherit; cursor: pointer; font-weight: 700; padding: 0 2px; }
    .ck-board { display: grid; grid-template-columns: repeat(5, minmax(220px, 1fr)); gap: 12px; overflow-x: auto; align-items: start; }
    .ck-col { display: flex; flex-direction: column; gap: 10px; padding: 10px; background: var(--bg-card, #fff); border: 1px solid var(--border, #d1cfc5); border-radius: 10px; min-height: 260px; }
    .ck-col-header { display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 14px; }
    .ck-count { font-size: 12px; padding: 1px 7px; border-radius: 999px; background: var(--bg-input, #f0eee6); color: var(--text-secondary, #30302e); }
    .ck-card { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border, #d1cfc5); border-radius: 8px; background: var(--bg, #faf9f5); }
    .ck-card-title { font-weight: 600; font-size: 14px; word-break: break-word; }
    .ck-card-desc { font-size: 13px; color: var(--text-secondary, #30302e); white-space: pre-wrap; word-break: break-word; }
    .ck-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
    .ck-prio { padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; background: var(--info-soft, rgba(106,155,204,0.14)); color: var(--text, #141413); }
    .ck-prio-urgent { background: var(--danger-soft, rgba(191,77,67,0.16)); color: var(--danger, #bf4d43); }
    .ck-prio-high { background: var(--accent-soft, rgba(217,119,87,0.16)); color: var(--accent-hover, #c46849); }
    .ck-comments { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border, #d1cfc5); }
    .ck-comment { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--bg-card, #fff); border: 1px solid var(--border, #d1cfc5); font-size: 12px; }
    .ck-form-box { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed var(--border, #d1cfc5); border-radius: 8px; }
    .ck-empty { font-size: 13px; color: var(--text-dim, #68675f); padding: 8px 0; }
  `;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = String(text);
  }
  return node;
}

function safeColor(color) {
  return typeof color === "string" && HEX_COLOR_RE.test(color.trim())
    ? color.trim()
    : "#64748b";
}

function resolveCsrfToken(ctx) {
  if (ctx && typeof ctx.getCsrfToken === "function") {
    return ctx.getCsrfToken() || "";
  }
  if (ctx && typeof ctx.csrfToken === "string") {
    return ctx.csrfToken;
  }
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) {
      return meta.getAttribute("content") || "";
    }
  }
  return "";
}

export function mount(container, ctx = {}) {
  if (!container) {
    return { unmount() {} };
  }
  ensureStyles();

  const abortController = new AbortController();
  let disposed = false;

  const state = {
    projects: [],
    activeProjectId: null,
    labels: [],
    cards: [],
    commentsByCard: new Map(),
    expandedComments: new Set(),
    openComposerColumn: null,
    showNewProjectForm: false,
    filterPriority: "",
    statusText: "",
    statusError: false,
  };

  async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const baseUrl = typeof ctx?.baseUrl === "string" ? ctx.baseUrl : "";
    const url = `${baseUrl}${path}`;

    if (ctx && typeof ctx.apiFetch === "function") {
      return ctx.apiFetch(url, { ...options, method, signal: abortController.signal });
    }

    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrf = resolveCsrfToken(ctx);
      if (csrf && !headers.has("X-CSRF-Token")) {
        headers.set("X-CSRF-Token", csrf);
      }
    }

    const fetchFn = ctx && typeof ctx.fetch === "function" ? ctx.fetch : fetch;
    const response = await fetchFn(url, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: abortController.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = typeof data?.message === "string" ? data.message : `HTTP ${response.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function setStatus(message, isError = false) {
    state.statusText = message;
    state.statusError = isError;
    if (!disposed) {
      render();
    }
  }

  async function loadBoardData(projectId) {
    if (!projectId) {
      state.labels = [];
      state.cards = [];
      state.commentsByCard.clear();
      if (!disposed) {
        render();
      }
      return;
    }
    const [labelsRes, cardsRes] = await Promise.all([
      api(`/api/kanban/projects/${encodeURIComponent(projectId)}/labels`),
      api(`/api/kanban/projects/${encodeURIComponent(projectId)}/cards`),
    ]);
    if (disposed || state.activeProjectId !== projectId) {
      return;
    }
    state.labels = Array.isArray(labelsRes?.labels) ? labelsRes.labels : [];
    state.cards = Array.isArray(cardsRes?.cards) ? cardsRes.cards : [];
    render();
  }

  async function loadProjects(preferredId = null) {
    try {
      const res = await api("/api/kanban/projects");
      if (disposed) {
        return;
      }
      state.projects = Array.isArray(res?.projects) ? res.projects : [];
      const targetId =
        preferredId && state.projects.some((p) => p.id === preferredId)
          ? preferredId
          : state.activeProjectId && state.projects.some((p) => p.id === state.activeProjectId)
            ? state.activeProjectId
            : state.projects[0]?.id || null;
      state.activeProjectId = targetId;
      await loadBoardData(targetId);
    } catch (err) {
      if (!disposed && err?.name !== "AbortError") {
        setStatus(err?.message || "Failed to load Kanban projects", true);
      }
    }
  }

  async function loadComments(cardId) {
    try {
      const res = await api(`/api/kanban/cards/${encodeURIComponent(cardId)}/comments`);
      if (disposed) {
        return;
      }
      state.commentsByCard.set(cardId, Array.isArray(res?.comments) ? res.comments : []);
      render();
    } catch (err) {
      if (!disposed && err?.name !== "AbortError") {
        setStatus(err?.message || "Failed to load comments", true);
      }
    }
  }

  function buildToolbar() {
    const bar = el("div", "ck-toolbar");
    const title = el("strong", "", "Kanban");
    bar.appendChild(title);

    const projectSelect = el("select", "ck-select");
    projectSelect.setAttribute("aria-label", "Project selector");
    if (state.projects.length === 0) {
      const opt = el("option", "", "No projects yet");
      opt.value = "";
      projectSelect.appendChild(opt);
    } else {
      for (const proj of state.projects) {
        const opt = el("option", "", proj.name);
        opt.value = proj.id;
        opt.selected = proj.id === state.activeProjectId;
        projectSelect.appendChild(opt);
      }
    }
    projectSelect.addEventListener("change", () => {
      state.activeProjectId = projectSelect.value || null;
      state.commentsByCard.clear();
      state.expandedComments.clear();
      void loadBoardData(state.activeProjectId).catch((err) => {
        if (!disposed) {
          setStatus(err?.message || "Failed to load project", true);
        }
      });
    });
    bar.appendChild(projectSelect);

    const prioFilter = el("select", "ck-select");
    prioFilter.setAttribute("aria-label", "Priority filter");
    const allOpt = el("option", "", "All priorities");
    allOpt.value = "";
    prioFilter.appendChild(allOpt);
    for (const prio of PRIORITIES) {
      const opt = el("option", "", prio);
      opt.value = prio;
      opt.selected = state.filterPriority === prio;
      prioFilter.appendChild(opt);
    }
    prioFilter.addEventListener("change", () => {
      state.filterPriority = prioFilter.value;
      render();
    });
    bar.appendChild(prioFilter);

    const newProjBtn = el("button", "ck-btn ck-btn-primary", "+ Project");
    newProjBtn.type = "button";
    newProjBtn.addEventListener("click", () => {
      state.showNewProjectForm = !state.showNewProjectForm;
      render();
    });
    bar.appendChild(newProjBtn);

    if (state.activeProjectId) {
      const delProjBtn = el("button", "ck-btn ck-btn-danger", "Delete Project");
      delProjBtn.type = "button";
      delProjBtn.addEventListener("click", async () => {
        const targetId = state.activeProjectId;
        if (!targetId) {
          return;
        }
        try {
          await api(`/api/kanban/projects/${encodeURIComponent(targetId)}`, { method: "DELETE" });
          state.activeProjectId = null;
          setStatus("Project deleted");
          await loadProjects();
        } catch (err) {
          setStatus(err?.message || "Delete failed", true);
        }
      });
      bar.appendChild(delProjBtn);
    }

    const refreshBtn = el("button", "ck-btn", "Refresh");
    refreshBtn.type = "button";
    refreshBtn.addEventListener("click", () => {
      void loadProjects(state.activeProjectId);
    });
    bar.appendChild(refreshBtn);

    const spacer = el("div", "ck-grow");
    bar.appendChild(spacer);

    return bar;
  }

  function buildNewProjectForm() {
    const form = el("form", "ck-toolbar");
    const nameInput = el("input", "ck-input");
    nameInput.type = "text";
    nameInput.placeholder = "Project name";
    nameInput.required = true;

    const descInput = el("input", "ck-input ck-grow");
    descInput.type = "text";
    descInput.placeholder = "Description (optional)";

    const submitBtn = el("button", "ck-btn ck-btn-primary", "Create");
    submitBtn.type = "submit";

    const cancelBtn = el("button", "ck-btn", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => {
      state.showNewProjectForm = false;
      render();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        return;
      }
      try {
        const created = await api("/api/kanban/projects", {
          method: "POST",
          body: { name, description: descInput.value.trim() },
        });
        state.showNewProjectForm = false;
        setStatus(`Created project "${name}"`);
        await loadProjects(created?.id || null);
      } catch (err) {
        setStatus(err?.message || "Failed to create project", true);
      }
    });

    form.append(nameInput, descInput, submitBtn, cancelBtn);
    return form;
  }

  function buildLabelsBar() {
    const bar = el("div", "ck-labels-bar");
    bar.appendChild(el("strong", "", "Labels:"));

    const labelList = el("div", "ck-row ck-grow");
    if (state.labels.length === 0) {
      labelList.appendChild(el("span", "ck-empty", "None"));
    } else {
      for (const label of state.labels) {
        const pill = el("span", "ck-pill");
        pill.style.backgroundColor = safeColor(label.color);
        pill.appendChild(el("span", "", label.name));

        const del = el("button", "ck-pill-btn", "x");
        del.type = "button";
        del.setAttribute("aria-label", `Delete label ${label.name}`);
        del.addEventListener("click", async () => {
          try {
            await api(`/api/kanban/labels/${encodeURIComponent(label.id)}`, {
              method: "DELETE",
            });
            setStatus(`Deleted label "${label.name}"`);
            await loadBoardData(state.activeProjectId);
          } catch (err) {
            setStatus(err?.message || "Failed to delete label", true);
          }
        });
        pill.appendChild(del);
        labelList.appendChild(pill);
      }
    }
    bar.appendChild(labelList);

    const addLabelForm = el("form", "ck-row");
    const nameInput = el("input", "ck-input");
    nameInput.type = "text";
    nameInput.placeholder = "New label";
    nameInput.required = true;

    const colorInput = el("input", "ck-input");
    colorInput.type = "color";
    colorInput.value = "#64748b";
    colorInput.setAttribute("aria-label", "Label color");

    const addBtn = el("button", "ck-btn ck-btn-sm", "+ Label");
    addBtn.type = "submit";

    addLabelForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.activeProjectId) {
        return;
      }
      const name = nameInput.value.trim();
      if (!name) {
        return;
      }
      try {
        await api(
          `/api/kanban/projects/${encodeURIComponent(state.activeProjectId)}/labels`,
          { method: "POST", body: { name, color: colorInput.value || "#64748b" } },
        );
        setStatus(`Added label "${name}"`);
        await loadBoardData(state.activeProjectId);
      } catch (err) {
        setStatus(err?.message || "Failed to create label", true);
      }
    });

    addLabelForm.append(nameInput, colorInput, addBtn);
    bar.appendChild(addLabelForm);
    return bar;
  }

  function resolveLabelView(labelRef) {
    const found = state.labels.find((l) => l.id === labelRef || l.name === labelRef);
    return found
      ? { name: found.name, color: safeColor(found.color) }
      : { name: labelRef, color: "#64748b" };
  }

  function buildCommentsSection(card) {
    const wrap = el("div", "ck-comments");
    const comments = state.commentsByCard.get(card.id) || [];

    if (comments.length === 0) {
      wrap.appendChild(el("div", "ck-empty", "No comments yet."));
    } else {
      for (const comment of comments) {
        const item = el("div", "ck-comment");
        const content = el("div");
        const authorEl = el("strong", "", `${comment.author}: `);
        const bodyEl = el("span", "", comment.body);
        content.append(authorEl, bodyEl);

        const delBtn = el("button", "ck-btn ck-btn-sm ck-btn-danger", "x");
        delBtn.type = "button";
        delBtn.setAttribute("aria-label", "Delete comment");
        delBtn.addEventListener("click", async () => {
          try {
            await api(`/api/kanban/comments/${encodeURIComponent(comment.id)}`, {
              method: "DELETE",
            });
            await loadComments(card.id);
          } catch (err) {
            setStatus(err?.message || "Failed to delete comment", true);
          }
        });

        item.append(content, delBtn);
        wrap.appendChild(item);
      }
    }

    const form = el("form", "ck-form-box");
    const authorInput = el("input", "ck-input");
    authorInput.type = "text";
    authorInput.placeholder = "Author";
    authorInput.value = "admin";
    authorInput.required = true;

    const bodyInput = el("input", "ck-input");
    bodyInput.type = "text";
    bodyInput.placeholder = "Add a comment...";
    bodyInput.required = true;

    const postBtn = el("button", "ck-btn ck-btn-sm ck-btn-primary", "Post");
    postBtn.type = "submit";

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const author = authorInput.value.trim();
      const body = bodyInput.value.trim();
      if (!author || !body) {
        return;
      }
      try {
        await api(`/api/kanban/cards/${encodeURIComponent(card.id)}/comments`, {
          method: "POST",
          body: { author, body },
        });
        bodyInput.value = "";
        await loadComments(card.id);
      } catch (err) {
        setStatus(err?.message || "Failed to post comment", true);
      }
    });

    form.append(authorInput, bodyInput, postBtn);
    wrap.appendChild(form);
    return wrap;
  }

  function buildCardElement(card) {
    const cardEl = el("article", "ck-card");
    cardEl.dataset.cardId = card.id;

    cardEl.appendChild(el("div", "ck-card-title", card.title));
    if (card.description) {
      cardEl.appendChild(el("div", "ck-card-desc", card.description));
    }

    const meta = el("div", "ck-meta");
    const prioClass =
      card.priority === "urgent"
        ? "ck-prio ck-prio-urgent"
        : card.priority === "high"
          ? "ck-prio ck-prio-high"
          : "ck-prio";
    meta.appendChild(el("span", prioClass, card.priority));
    if (card.assignee) {
      meta.appendChild(el("span", "ck-count", `@${card.assignee}`));
    }
    for (const ref of card.labels || []) {
      const view = resolveLabelView(ref);
      const pill = el("span", "ck-pill", view.name);
      pill.style.backgroundColor = view.color;
      meta.appendChild(pill);
    }
    cardEl.appendChild(meta);

    const actions = el("div", "ck-row");
    const moveSelect = el("select", "ck-select");
    moveSelect.setAttribute("aria-label", `Move card ${card.title}`);
    for (const col of COLUMNS) {
      const opt = el("option", "", col.label);
      opt.value = col.id;
      opt.selected = col.id === card.column_name;
      moveSelect.appendChild(opt);
    }
    moveSelect.addEventListener("change", async () => {
      try {
        await api(`/api/kanban/cards/${encodeURIComponent(card.id)}`, {
          method: "PATCH",
          body: { column_name: moveSelect.value },
        });
        await loadBoardData(state.activeProjectId);
      } catch (err) {
        setStatus(err?.message || "Failed to move card", true);
      }
    });
    actions.appendChild(moveSelect);

    const commentsOpen = state.expandedComments.has(card.id);
    const commentsBtn = el(
      "button",
      "ck-btn ck-btn-sm",
      commentsOpen ? "Hide Comments" : "Comments",
    );
    commentsBtn.type = "button";
    commentsBtn.addEventListener("click", async () => {
      if (state.expandedComments.has(card.id)) {
        state.expandedComments.delete(card.id);
        render();
        return;
      }
      state.expandedComments.add(card.id);
      if (!state.commentsByCard.has(card.id)) {
        await loadComments(card.id);
      } else {
        render();
      }
    });
    actions.appendChild(commentsBtn);

    const delBtn = el("button", "ck-btn ck-btn-sm ck-btn-danger", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", async () => {
      try {
        await api(`/api/kanban/cards/${encodeURIComponent(card.id)}`, { method: "DELETE" });
        state.commentsByCard.delete(card.id);
        state.expandedComments.delete(card.id);
        await loadBoardData(state.activeProjectId);
      } catch (err) {
        setStatus(err?.message || "Failed to delete card", true);
      }
    });
    actions.appendChild(delBtn);

    cardEl.appendChild(actions);
    if (commentsOpen) {
      cardEl.appendChild(buildCommentsSection(card));
    }
    return cardEl;
  }

  function buildNewCardForm(columnId) {
    const form = el("form", "ck-form-box");
    const titleInput = el("input", "ck-input");
    titleInput.type = "text";
    titleInput.placeholder = "Card title";
    titleInput.required = true;

    const descInput = el("textarea", "ck-textarea");
    descInput.placeholder = "Description (optional)";

    const prioSelect = el("select", "ck-select");
    for (const prio of PRIORITIES) {
      const opt = el("option", "", prio);
      opt.value = prio;
      opt.selected = prio === "medium";
      prioSelect.appendChild(opt);
    }

    const assigneeInput = el("input", "ck-input");
    assigneeInput.type = "text";
    assigneeInput.placeholder = "Assignee (optional)";

    const labelSelect = el("select", "ck-select");
    const noLabelOpt = el("option", "", "No label");
    noLabelOpt.value = "";
    labelSelect.appendChild(noLabelOpt);
    for (const lbl of state.labels) {
      const opt = el("option", "", lbl.name);
      opt.value = lbl.id;
      labelSelect.appendChild(opt);
    }

    const row = el("div", "ck-row");
    const submitBtn = el("button", "ck-btn ck-btn-sm ck-btn-primary", "Add Card");
    submitBtn.type = "submit";
    const cancelBtn = el("button", "ck-btn ck-btn-sm", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => {
      state.openComposerColumn = null;
      render();
    });
    row.append(submitBtn, cancelBtn);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.activeProjectId) {
        return;
      }
      const title = titleInput.value.trim();
      if (!title) {
        return;
      }
      const chosenLabels = labelSelect.value ? [labelSelect.value] : [];
      try {
        await api(
          `/api/kanban/projects/${encodeURIComponent(state.activeProjectId)}/cards`,
          {
            method: "POST",
            body: {
              title,
              description: descInput.value.trim(),
              column_name: columnId,
              priority: prioSelect.value,
              assignee: assigneeInput.value.trim() || null,
              labels: chosenLabels,
            },
          },
        );
        state.openComposerColumn = null;
        setStatus(`Created card "${title}"`);
        await loadBoardData(state.activeProjectId);
      } catch (err) {
        setStatus(err?.message || "Failed to create card", true);
      }
    });

    form.append(titleInput, descInput, prioSelect, assigneeInput, labelSelect, row);
    return form;
  }

  function buildBoard() {
    const board = el("div", "ck-board");
    const visibleCards = state.filterPriority
      ? state.cards.filter((c) => c.priority === state.filterPriority)
      : state.cards;

    for (const col of COLUMNS) {
      const colEl = el("section", "ck-col");
      colEl.dataset.column = col.id;

      const colCards = visibleCards
        .filter((c) => c.column_name === col.id)
        .sort((a, b) => a.position - b.position);

      const header = el("div", "ck-col-header");
      header.appendChild(el("span", "", col.label));
      header.appendChild(el("span", "ck-count", String(colCards.length)));
      colEl.appendChild(header);

      const addBtn = el("button", "ck-btn ck-btn-sm", "+ Add Card");
      addBtn.type = "button";
      addBtn.addEventListener("click", () => {
        state.openComposerColumn = state.openComposerColumn === col.id ? null : col.id;
        render();
      });
      colEl.appendChild(addBtn);

      if (state.openComposerColumn === col.id) {
        colEl.appendChild(buildNewCardForm(col.id));
      }

      if (colCards.length === 0) {
        colEl.appendChild(el("div", "ck-empty", "Empty"));
      } else {
        for (const card of colCards) {
          colEl.appendChild(buildCardElement(card));
        }
      }

      board.appendChild(colEl);
    }
    return board;
  }

  function render() {
    if (disposed) {
      return;
    }
    const root = el("div", "ck-root");
    root.appendChild(buildToolbar());

    if (state.showNewProjectForm) {
      root.appendChild(buildNewProjectForm());
    }
    if (state.statusText) {
      const status = el("div", state.statusError ? "ck-status ck-status-error" : "ck-status");
      status.textContent = state.statusText;
      root.appendChild(status);
    }

    if (state.activeProjectId) {
      root.appendChild(buildLabelsBar());
      root.appendChild(buildBoard());
    } else {
      root.appendChild(el("div", "ck-empty", "Create or select a Kanban project to begin."));
    }

    container.replaceChildren(root);
  }

  render();
  void loadProjects();

  return {
    unmount() {
      disposed = true;
      abortController.abort();
      unmount(container);
    },
  };
}

export function unmount(container) {
  if (container && typeof container.replaceChildren === "function") {
    container.replaceChildren();
  }
}
