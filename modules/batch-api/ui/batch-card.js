/**
 * Alfred `batch-api` UI card (`vpsBatchCard`).
 * Build-free ES6 module rendering strictly via safe DOM APIs (`textContent` / `createElement`).
 */

const mountedInstances = new WeakMap();

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  gemini: "Gemini",
  "vertex-eu": "Vertex EU",
  openai: "OpenAI",
};

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

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function statusBadgeColor(status) {
  if (status === "completed") return "#16a34a";
  if (status === "running" || status === "submitted" || status === "downloading") return "#2563eb";
  if (status === "queued") return "#d97706";
  if (status === "cancelled") return "#64748b";
  return "#dc2626";
}

function isCancelable(status) {
  return status === "queued" || status === "submitted" || status === "running";
}

async function requestJson(url, options, ctx, signal) {
  if (ctx && typeof ctx.apiJson === "function") {
    return ctx.apiJson(url, { ...options, signal });
  }
  const fetchFn = ctx && typeof ctx.fetch === "function" ? ctx.fetch : globalThis.fetch;
  const headers = {
    ...(options && options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(ctx && ctx.headers ? ctx.headers : {}),
    ...(options && options.headers ? options.headers : {}),
  };
  const csrf =
    typeof ctx?.getCsrfToken === "function" ? ctx.getCsrfToken() : ctx?.csrfToken;
  if (csrf && !headers["X-CSRF-Token"]) {
    headers["X-CSRF-Token"] = csrf;
  }
  const response = await fetchFn(url, {
    credentials: "same-origin",
    ...options,
    headers,
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.message || data.error || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

export function unmount(container) {
  if (!container) {
    return;
  }
  const state = mountedInstances.get(container);
  if (state) {
    state.disposed = true;
    state.abortController.abort();
    mountedInstances.delete(container);
  }
  clearElement(container);
}

export function mount(container, ctx = {}) {
  if (!container) {
    return { unmount() {} };
  }
  unmount(container);

  const abortController = new AbortController();
  const state = { disposed: false, abortController };
  mountedInstances.set(container, state);

  const card = el("section", "alfred-card");
  card.id = "vpsBatchCard";
  card.setAttribute("data-module-card", "batch-api");
  card.style.border = "1px solid var(--border, #334155)";
  card.style.borderRadius = "10px";
  card.style.padding = "14px";
  card.style.display = "flex";
  card.style.flexDirection = "column";
  card.style.gap = "10px";

  const header = el("div", "alfred-card-header");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.flexWrap = "wrap";

  const title = el("h3", "alfred-card-title", "Batch API (-50% CostOps)");
  title.style.margin = "0";
  const refreshBtn = el("button", "btn-secondary", "Refresh");
  refreshBtn.type = "button";
  refreshBtn.id = "vpsBatchRefreshBtn";
  refreshBtn.setAttribute("data-batch-refresh", "1");

  header.appendChild(title);
  header.appendChild(refreshBtn);

  const kpiBar = el("div", "alfred-batch-kpi-bar");
  kpiBar.id = "vpsBatchKpiBar";
  kpiBar.style.display = "grid";
  kpiBar.style.gridTemplateColumns = "repeat(auto-fit, minmax(170px, 1fr))";
  kpiBar.style.gap = "8px";

  const providersGrid = el("div", "alfred-batch-providers-grid");
  providersGrid.id = "vpsBatchProvidersGrid";
  providersGrid.style.display = "grid";
  providersGrid.style.gridTemplateColumns = "repeat(auto-fit, minmax(160px, 1fr))";
  providersGrid.style.gap = "8px";

  const statusMsg = el("div", "alfred-batch-status-msg", "Loading batch telemetry...");
  statusMsg.id = "vpsBatchStatusMsg";
  statusMsg.style.fontSize = "12px";

  const jobsList = el("div", "alfred-batch-jobs-list");
  jobsList.id = "vpsBatchJobsList";
  jobsList.style.display = "flex";
  jobsList.style.flexDirection = "column";
  jobsList.style.gap = "8px";

  card.appendChild(header);
  card.appendChild(kpiBar);
  card.appendChild(providersGrid);
  card.appendChild(statusMsg);
  card.appendChild(jobsList);
  container.appendChild(card);

  function buildKpiTile(label, valueText, subText, highlightBorder) {
    const tile = el("div", "alfred-batch-kpi-tile");
    tile.style.padding = "10px 12px";
    tile.style.border = highlightBorder
      ? "1px solid #16a34a"
      : "1px solid var(--border, #334155)";
    tile.style.borderRadius = "8px";
    if (highlightBorder) {
      tile.style.background = "rgba(22, 163, 74, 0.08)";
    }
    const lbl = el("div", null, label);
    lbl.style.fontSize = "11px";
    lbl.style.opacity = "0.8";
    const val = el("div", null, valueText);
    val.style.fontSize = "18px";
    val.style.fontWeight = "700";
    val.style.marginTop = "2px";
    const sub = el("div", null, subText);
    sub.style.fontSize = "11px";
    sub.style.opacity = "0.75";
    tile.appendChild(lbl);
    tile.appendChild(val);
    tile.appendChild(sub);
    return tile;
  }

  function renderOverview(data) {
    if (state.disposed) {
      return;
    }
    const s = data.summary || {};
    const spent = Number(s.total_spent_usd || 0);
    const saved = Number(s.total_saved_usd || 0);
    const baseline = Number(s.total_baseline_usd || 0);
    const activeCount = Number(s.active_batches || 0);
    const totalCount = Number(s.total_batches || 0);
    const totalItems = Number(s.total_items || 0);

    clearElement(kpiBar);
    kpiBar.appendChild(
      buildKpiTile(
        "Spent (50% Batch)",
        `$${spent.toFixed(4)}`,
        `Real-time baseline: $${baseline.toFixed(4)}`,
        false,
      ),
    );
    kpiBar.appendChild(
      buildKpiTile(
        "Total Saved (50%)",
        `$${saved.toFixed(4)}`,
        "Zero CLI quota used",
        true,
      ),
    );
    kpiBar.appendChild(
      buildKpiTile(
        "Active / Total Batches",
        `${activeCount} / ${totalCount}`,
        `Completed items: ${totalItems}`,
        false,
      ),
    );

    clearElement(providersGrid);
    const providers = Array.isArray(data.by_provider) ? data.by_provider : [];
    for (const p of providers) {
      const box = el("div", "alfred-batch-provider-card");
      box.setAttribute("data-batch-provider", p.provider);
      box.style.padding = "10px";
      box.style.border = "1px solid var(--border, #334155)";
      box.style.borderRadius = "8px";
      box.style.display = "flex";
      box.style.flexDirection = "column";
      box.style.gap = "4px";
      box.style.fontSize = "12px";

      const top = el("div");
      top.style.display = "flex";
      top.style.justifyContent = "space-between";
      top.style.alignItems = "center";
      top.style.gap = "6px";

      const label = PROVIDER_LABELS[p.provider] || p.provider;
      top.appendChild(el("strong", null, label));

      const cfgBadge = el("span", "alfred-badge", p.configured ? "Configured" : "No Key");
      cfgBadge.style.padding = "1px 7px";
      cfgBadge.style.borderRadius = "999px";
      cfgBadge.style.fontSize = "10px";
      cfgBadge.style.fontWeight = "600";
      cfgBadge.style.color = "#fff";
      cfgBadge.style.background = p.configured ? "#16a34a" : "#64748b";
      top.appendChild(cfgBadge);

      const countsLine = el(
        "div",
        null,
        `Batches: ${Number(p.batch_count || 0)} · Items: ${Number(p.completed_items || 0)}`,
      );
      const costLine = el(
        "div",
        null,
        `Spent: $${Number(p.spent_usd || 0).toFixed(4)} · Saved: $${Number(p.saved_usd || 0).toFixed(4)}`,
      );
      costLine.style.opacity = "0.8";

      box.appendChild(top);
      box.appendChild(countsLine);
      box.appendChild(costLine);
      providersGrid.appendChild(box);
    }

    clearElement(jobsList);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    if (jobs.length === 0) {
      statusMsg.textContent = "No batch jobs recorded yet.";
      return;
    }
    statusMsg.textContent = `Showing ${jobs.length} batch job(s).`;

    for (const job of jobs) {
      const row = el("div", "alfred-batch-job-row");
      row.setAttribute("data-batch-job", job.id);
      row.style.border = "1px solid var(--border, #334155)";
      row.style.borderRadius = "8px";
      row.style.padding = "10px";
      row.style.display = "flex";
      row.style.flexDirection = "column";
      row.style.gap = "6px";
      row.style.fontSize = "12px";

      const top = el("div");
      top.style.display = "flex";
      top.style.justifyContent = "space-between";
      top.style.alignItems = "center";
      top.style.gap = "8px";
      top.style.flexWrap = "wrap";

      const left = el("div");
      left.style.display = "flex";
      left.style.alignItems = "center";
      left.style.gap = "8px";
      left.appendChild(el("code", null, job.id));
      left.appendChild(el("span", null, `${job.provider} · ${job.model}`));

      const badge = el("span", "alfred-badge", job.status);
      badge.style.padding = "2px 8px";
      badge.style.borderRadius = "999px";
      badge.style.fontSize = "11px";
      badge.style.fontWeight = "600";
      badge.style.color = "#fff";
      badge.style.background = statusBadgeColor(job.status);
      left.appendChild(badge);

      if (job.qa_status) {
        const qaBadge = el("span", "alfred-badge", `QA: ${job.qa_status}`);
        qaBadge.style.padding = "2px 8px";
        qaBadge.style.borderRadius = "999px";
        qaBadge.style.fontSize = "10px";
        qaBadge.style.border = "1px solid var(--border, #334155)";
        left.appendChild(qaBadge);
      }

      top.appendChild(left);

      if (isCancelable(job.status)) {
        const cancelBtn = el("button", "btn-secondary", "Cancel");
        cancelBtn.type = "button";
        cancelBtn.setAttribute("data-batch-cancel", job.id);
        cancelBtn.addEventListener("click", async () => {
          cancelBtn.disabled = true;
          statusMsg.textContent = `Cancelling batch ${job.id}...`;
          try {
            await requestJson(
              `/api/batch/jobs/${encodeURIComponent(job.id)}/cancel`,
              { method: "POST", body: JSON.stringify({}) },
              ctx,
              abortController.signal,
            );
            if (!state.disposed) {
              statusMsg.textContent = `Cancelled batch ${job.id}.`;
              await refresh();
            }
          } catch (err) {
            if (!state.disposed && err?.name !== "AbortError") {
              statusMsg.textContent = `Cancel error: ${err?.message || "unknown error"}`;
              cancelBtn.disabled = false;
            }
          }
        });
        top.appendChild(cancelBtn);
      }

      const reqCount = Math.max(0, Number(job.request_count || 0));
      const compCount = Math.max(0, Number(job.completed_count || 0));
      const pct = reqCount > 0 ? Math.min(100, Math.round((compCount / reqCount) * 100)) : 0;

      const progWrap = el("div");
      progWrap.style.display = "flex";
      progWrap.style.alignItems = "center";
      progWrap.style.gap = "8px";

      const track = el("div");
      track.style.flex = "1";
      track.style.height = "6px";
      track.style.borderRadius = "999px";
      track.style.background = "rgba(128, 128, 128, 0.22)";
      track.style.overflow = "hidden";

      const fill = el("div");
      fill.style.height = "100%";
      fill.style.width = `${pct}%`;
      fill.style.background = statusBadgeColor(job.status);
      fill.style.borderRadius = "999px";
      track.appendChild(fill);

      const progLabel = el(
        "span",
        null,
        `${compCount} / ${reqCount} (${pct}%) · $${Number(job.cost_usd || 0).toFixed(4)}`,
      );
      progLabel.style.fontSize = "11px";
      progLabel.style.opacity = "0.85";

      progWrap.appendChild(track);
      progWrap.appendChild(progLabel);

      row.appendChild(top);
      row.appendChild(progWrap);
      if (job.error_message) {
        const errLine = el("div", null, `Error: ${job.error_message}`);
        errLine.style.color = "#dc2626";
        errLine.style.fontSize = "11px";
        row.appendChild(errLine);
      }
      jobsList.appendChild(row);
    }
  }

  async function refresh() {
    if (state.disposed) {
      return;
    }
    try {
      const data = await requestJson(
        "/api/batch/jobs",
        { method: "GET" },
        ctx,
        abortController.signal,
      );
      renderOverview(data);
    } catch (err) {
      if (!state.disposed && err?.name !== "AbortError") {
        statusMsg.textContent = `Error loading batch jobs: ${err?.message || "unknown error"}`;
      }
    }
  }

  refreshBtn.addEventListener("click", () => {
    void refresh();
  });

  void refresh();

  return {
    unmount() {
      unmount(container);
    },
  };
}
