/**
 * Alfred `core-cli` UI panel (`vpsCliProvidersCard`).
 * Build-free ES6 module rendering strictly via DOM APIs (`textContent` / `createElement`).
 */

const mountedInstances = new WeakMap();

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

async function requestJson(url, options, ctx, signal) {
  if (ctx && typeof ctx.apiJson === "function") {
    return ctx.apiJson(url, { ...options, signal });
  }
  const headers = {
    "Content-Type": "application/json",
    ...(ctx && ctx.headers ? ctx.headers : {}),
    ...(options && options.headers ? options.headers : {}),
  };
  if (ctx && ctx.csrfToken && !headers["X-CSRF-Token"]) {
    headers["X-CSRF-Token"] = ctx.csrfToken;
  }
  const response = await fetch(url, {
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

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function unmount(container) {
  if (!container) {
    return;
  }
  const state = mountedInstances.get(container);
  if (state) {
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
  const signal = abortController.signal;
  mountedInstances.set(container, { abortController });

  const card = el("section", "alfred-card");
  card.id = "vpsCliProvidersCard";
  card.setAttribute("data-module-card", "core-cli");

  const header = el("div", "alfred-card-header");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.gap = "8px";

  const title = el("h3", "alfred-card-title", "CLI Providers & Skills");
  const actions = el("div", "alfred-card-actions");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const refreshBtn = el("button", "btn-secondary", "Refresh");
  refreshBtn.type = "button";
  refreshBtn.setAttribute("data-cli-refresh", "1");

  const syncBtn = el("button", "btn-primary", "Sync Skills & MCP");
  syncBtn.type = "button";
  syncBtn.id = "vpsSkillsSyncBtn";

  actions.appendChild(refreshBtn);
  actions.appendChild(syncBtn);
  header.appendChild(title);
  header.appendChild(actions);

  const metaLine = el("div", "alfred-card-meta", "Loading CLI provider status...");
  metaLine.style.fontSize = "12px";
  metaLine.style.margin = "6px 0 10px 0";

  const grid = el("div", "alfred-cli-grid");
  grid.id = "vpsCliProvidersGrid";
  grid.style.display = "grid";
  grid.style.gap = "10px";

  const syncStatus = el("div", "alfred-cli-sync-status");
  syncStatus.id = "vpsSkillsCatalogStatus";
  syncStatus.style.marginTop = "10px";
  syncStatus.style.fontSize = "12px";

  card.appendChild(header);
  card.appendChild(metaLine);
  card.appendChild(grid);
  card.appendChild(syncStatus);
  container.appendChild(card);

  async function renderAll() {
    if (signal.aborted) {
      return;
    }
    try {
      const [statusData, profilesData] = await Promise.all([
        requestJson("/api/cli/status", { method: "GET" }, ctx, signal),
        requestJson("/api/cli/profiles", { method: "GET" }, ctx, signal),
      ]);
      if (signal.aborted) {
        return;
      }

      const totalCalls = Number(statusData.total_invocations || 0);
      metaLine.textContent = `Total CLI invocations: ${totalCalls}`;

      const profilesByProvider = new Map();
      const allProfiles = Array.isArray(profilesData.profiles) ? profilesData.profiles : [];
      for (const prof of allProfiles) {
        if (!profilesByProvider.has(prof.provider_id)) {
          profilesByProvider.set(prof.provider_id, []);
        }
        profilesByProvider.get(prof.provider_id).push(prof);
      }

      clearElement(grid);
      const providers = Array.isArray(statusData.providers) ? statusData.providers : [];
      for (const prov of providers) {
        const row = el("div", "alfred-cli-provider-row");
        row.setAttribute("data-cli-provider", prov.provider_id);
        row.style.border = "1px solid var(--border, #334155)";
        row.style.borderRadius = "8px";
        row.style.padding = "10px";
        row.style.display = "flex";
        row.style.flexDirection = "column";
        row.style.gap = "6px";

        const top = el("div");
        top.style.display = "flex";
        top.style.justifyContent = "space-between";
        top.style.alignItems = "center";
        top.style.gap = "8px";

        const nameWrap = el("div");
        const nameStrong = el("strong", null, prov.provider_id);
        const binCode = el("code", null, ` (${prov.binary || ""})`);
        nameWrap.appendChild(nameStrong);
        nameWrap.appendChild(binCode);

        const badgeText = prov.quota_limited
          ? "Quota Cooldown"
          : prov.available
            ? "Available"
            : "Missing Binary";
        const badge = el("span", "alfred-badge", badgeText);
        badge.style.fontSize = "11px";
        badge.style.fontWeight = "600";
        badge.style.padding = "2px 8px";
        badge.style.borderRadius = "999px";

        top.appendChild(nameWrap);
        top.appendChild(badge);
        row.appendChild(top);

        const detailText = prov.detail || "";
        row.appendChild(el("div", "alfred-cli-detail", detailText));

        const profileControls = el("div");
        profileControls.style.display = "flex";
        profileControls.style.alignItems = "center";
        profileControls.style.gap = "6px";

        const select = el("select");
        select.setAttribute("data-cli-profile-select", prov.provider_id);
        const provProfiles = profilesByProvider.get(prov.provider_id) || [];
        if (provProfiles.length === 0) {
          const fallbackOpt = el("option", null, prov.active_profile || "default");
          fallbackOpt.value = prov.active_profile || "default";
          select.appendChild(fallbackOpt);
        } else {
          for (const item of provProfiles) {
            const label = item.email_hint
              ? `${item.label} (${item.email_hint})`
              : item.label;
            const opt = el("option", null, label);
            opt.value = item.profile_id;
            if (item.active || item.profile_id === prov.active_profile) {
              opt.selected = true;
            }
            select.appendChild(opt);
          }
        }

        const switchBtn = el("button", "btn-secondary", "Switch Profile");
        switchBtn.type = "button";
        switchBtn.setAttribute("data-cli-profile-switch", prov.provider_id);
        const rowMsg = el("span", "alfred-cli-row-msg");
        rowMsg.style.fontSize = "11px";

        switchBtn.addEventListener("click", async () => {
          switchBtn.disabled = true;
          rowMsg.textContent = "Switching...";
          try {
            const res = await requestJson(
              "/api/cli/switch",
              {
                method: "POST",
                body: JSON.stringify({
                  provider_id: prov.provider_id,
                  profile_id: select.value,
                }),
              },
              ctx,
              signal,
            );
            if (!signal.aborted) {
              rowMsg.textContent = res.message || `Active: ${res.active_profile}`;
            }
          } catch (err) {
            if (!signal.aborted) {
              rowMsg.textContent = `Error: ${err.message}`;
            }
          } finally {
            if (!signal.aborted) {
              switchBtn.disabled = false;
            }
          }
        });

        profileControls.appendChild(select);
        profileControls.appendChild(switchBtn);
        profileControls.appendChild(rowMsg);
        row.appendChild(profileControls);
        grid.appendChild(row);
      }
    } catch (err) {
      if (!signal.aborted) {
        metaLine.textContent = `Error loading CLI status: ${err.message}`;
      }
    }
  }

  refreshBtn.addEventListener("click", () => {
    void renderAll();
  });

  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    clearElement(syncStatus);
    syncStatus.textContent = "Scanning and syncing skills & MCP...";
    try {
      const res = await requestJson(
        "/api/cli/sync",
        { method: "POST", body: JSON.stringify({}) },
        ctx,
        signal,
      );
      if (signal.aborted) {
        return;
      }
      clearElement(syncStatus);
      const synced = Array.isArray(res.synced_skills) ? res.synced_skills : [];
      const blocked = Array.isArray(res.blocked_skills) ? res.blocked_skills : [];
      const mcpCount = Number(res.synced_mcp_servers || 0);
      syncStatus.appendChild(
        el(
          "div",
          null,
          `Synced ${synced.length} skill(s) and ${mcpCount} MCP server(s); blocked ${blocked.length} skill(s).`,
        ),
      );
      if (blocked.length > 0) {
        const list = el("ul");
        for (const item of blocked) {
          const li = el(
            "li",
            null,
            `Blocked: ${item.skill_id || "unknown"} (${item.reason || "security scan"})`,
          );
          list.appendChild(li);
        }
        syncStatus.appendChild(list);
      }
    } catch (err) {
      if (!signal.aborted) {
        syncStatus.textContent = `Sync error: ${err.message}`;
      }
    } finally {
      if (!signal.aborted) {
        syncBtn.disabled = false;
      }
    }
  });

  void renderAll();

  return {
    unmount() {
      unmount(container);
    },
  };
}
