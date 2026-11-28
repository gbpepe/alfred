/**
 * Alfred `cloud-storage` UI panel (`vpsCloudStorageCard`).
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

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function formatBytes(rawBytes) {
  const n = Number(rawBytes || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = n;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  const decimals = idx === 0 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(decimals)} ${units[idx]}`;
}

async function requestJson(url, options, ctx, signal) {
  if (ctx && typeof ctx.apiJson === "function") {
    return ctx.apiJson(url, { ...options, signal });
  }
  const fetchFn = ctx && typeof ctx.fetch === "function" ? ctx.fetch : globalThis.fetch;
  const headers = {
    "Content-Type": "application/json",
    ...(ctx && ctx.headers ? ctx.headers : {}),
    ...(options && options.headers ? options.headers : {}),
  };
  const csrf = typeof ctx?.getCsrfToken === "function" ? ctx.getCsrfToken() : ctx?.csrfToken;
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
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
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
  const signal = abortController.signal;
  const state = {
    disposed: false,
    abortController,
    activeProvider: "gdrive",
    activeAccount: "default",
    statusData: null,
  };
  mountedInstances.set(container, state);

  const card = el("section", "alfred-card");
  card.id = "vpsCloudStorageCard";
  card.setAttribute("data-module-card", "cloud-storage");

  const header = el("div", "alfred-card-header");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.flexWrap = "wrap";

  const titleWrap = el("div");
  titleWrap.style.display = "flex";
  titleWrap.style.alignItems = "center";
  titleWrap.style.gap = "8px";
  const title = el("h3", "alfred-card-title", "Cloud Storage");
  const defaultBadge = el("span", "alfred-badge", "gdrive");
  defaultBadge.style.fontSize = "11px";
  defaultBadge.style.padding = "2px 8px";
  defaultBadge.style.borderRadius = "999px";
  titleWrap.appendChild(title);
  titleWrap.appendChild(defaultBadge);

  const headerActions = el("div", "alfred-card-actions");
  headerActions.style.display = "flex";
  headerActions.style.gap = "8px";
  const refreshBtn = el("button", "btn-secondary", "Refresh");
  refreshBtn.type = "button";
  headerActions.appendChild(refreshBtn);

  header.appendChild(titleWrap);
  header.appendChild(headerActions);

  const metaLine = el("div", "alfred-card-meta", "Loading cloud storage status...");
  metaLine.style.fontSize = "12px";
  metaLine.style.margin = "6px 0 10px 0";

  const tabsRow = el("div", "alfred-cloud-tabs");
  tabsRow.style.display = "flex";
  tabsRow.style.gap = "6px";
  tabsRow.style.flexWrap = "wrap";
  tabsRow.style.marginBottom = "10px";

  const bodyWrap = el("div", "alfred-cloud-body");
  bodyWrap.style.display = "flex";
  bodyWrap.style.flexDirection = "column";
  bodyWrap.style.gap = "10px";

  const browserBox = el("div", "alfred-cloud-browser");
  browserBox.style.border = "1px solid var(--border, #334155)";
  browserBox.style.borderRadius = "8px";
  browserBox.style.padding = "10px";
  browserBox.style.display = "flex";
  browserBox.style.flexDirection = "column";
  browserBox.style.gap = "8px";

  const statusMsg = el("div", "alfred-cloud-status-msg");
  statusMsg.style.fontSize = "12px";
  statusMsg.style.marginTop = "8px";

  const activityBox = el("div", "alfred-cloud-activity");
  activityBox.style.marginTop = "10px";
  activityBox.style.fontSize = "12px";

  card.appendChild(header);
  card.appendChild(metaLine);
  card.appendChild(tabsRow);
  card.appendChild(bodyWrap);
  card.appendChild(browserBox);
  card.appendChild(statusMsg);
  card.appendChild(activityBox);
  container.appendChild(card);

  function setStatus(text) {
    if (!state.disposed) {
      statusMsg.textContent = text;
    }
  }

  function renderTabs() {
    clearElement(tabsRow);
    const providers = Array.isArray(state.statusData?.providers) ? state.statusData.providers : [];
    for (const prov of providers) {
      const isActive = prov.id === state.activeProvider;
      const btn = el(
        "button",
        isActive ? "btn-primary" : "btn-secondary",
        `${prov.displayName} (${prov.connectedCount || 0})`,
      );
      btn.type = "button";
      btn.setAttribute("data-cloud-tab", prov.id);
      btn.addEventListener("click", () => {
        state.activeProvider = prov.id;
        state.activeAccount = prov.defaultAccount || "default";
        renderBody();
        renderTabs();
      });
      tabsRow.appendChild(btn);
    }
  }

  async function loadFolderItems(listEl) {
    if (state.disposed) {
      return;
    }
    clearElement(listEl);
    listEl.appendChild(el("div", null, "Loading remote files..."));
    try {
      const qs = new URLSearchParams({
        provider: state.activeProvider,
        account: state.activeAccount,
        limit: "50",
      });
      const res = await requestJson(`/api/cloud/list?${qs.toString()}`, { method: "GET" }, ctx, signal);
      if (state.disposed) {
        return;
      }
      clearElement(listEl);
      const items = Array.isArray(res.items) ? res.items : [];
      if (items.length === 0) {
        listEl.appendChild(el("div", null, "No items found in this folder."));
        return;
      }
      for (const item of items) {
        const row = el("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.padding = "4px 6px";
        row.style.borderBottom = "1px solid var(--border, #334155)";

        const nameSpan = el(
          "span",
          null,
          `${item.kind === "folder" ? "[DIR] " : ""}${item.name}`,
        );
        const rightWrap = el("div");
        rightWrap.style.display = "flex";
        rightWrap.style.alignItems = "center";
        rightWrap.style.gap = "6px";

        const sizeText = item.kind === "folder" ? "folder" : formatBytes(item.sizeBytes);
        rightWrap.appendChild(el("span", null, sizeText));

        const shareBtn = el("button", "btn-secondary", "Share");
        shareBtn.type = "button";
        shareBtn.addEventListener("click", async () => {
          shareBtn.disabled = true;
          try {
            const shareRes = await requestJson(
              "/api/cloud/share",
              {
                method: "POST",
                body: JSON.stringify({
                  provider: state.activeProvider,
                  account: state.activeAccount,
                  fileRefOrPath: item.pathDisplay || item.id,
                }),
              },
              ctx,
              signal,
            );
            const shareInfo = shareRes.share || {};
            setStatus(`Shared ${item.name} -> ${shareInfo.sharedWith || "recipient"}`);
          } catch (err) {
            setStatus(`Share error: ${err.message}`);
          } finally {
            if (!state.disposed) {
              shareBtn.disabled = false;
            }
          }
        });
        rightWrap.appendChild(shareBtn);

        row.appendChild(nameSpan);
        row.appendChild(rightWrap);
        listEl.appendChild(row);
      }
    } catch (err) {
      if (!state.disposed) {
        clearElement(listEl);
        listEl.appendChild(el("div", null, `List error: ${err.message}`));
      }
    }
  }

  function renderBody() {
    clearElement(bodyWrap);
    clearElement(browserBox);
    const providers = Array.isArray(state.statusData?.providers) ? state.statusData.providers : [];
    const activeProv = providers.find((p) => p.id === state.activeProvider) || providers[0];
    if (!activeProv) {
      bodyWrap.appendChild(el("div", null, "No cloud provider configured."));
      return;
    }

    const clientStatus = el("div");
    clientStatus.style.display = "flex";
    clientStatus.style.justifyContent = "space-between";
    clientStatus.style.alignItems = "center";
    clientStatus.style.gap = "8px";
    clientStatus.appendChild(el("strong", null, `${activeProv.displayName} OAuth2`));
    const clientReady = Boolean(activeProv.hasClientId && activeProv.hasClientSecret);
    clientStatus.appendChild(
      el("span", "alfred-badge", clientReady ? "Client Ready" : "Missing Client Keys"),
    );
    bodyWrap.appendChild(clientStatus);

    const accounts = Array.isArray(activeProv.accounts) ? activeProv.accounts : [];
    for (const acc of accounts) {
      const row = el("div");
      row.setAttribute("data-cloud-account", acc.account);
      row.style.border = "1px solid var(--border, #334155)";
      row.style.borderRadius = "8px";
      row.style.padding = "8px";
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.flexWrap = "wrap";

      const labelText = acc.accountEmail
        ? `${acc.account} (${acc.accountEmail})`
        : acc.account;
      const infoWrap = el("div");
      infoWrap.style.display = "flex";
      infoWrap.style.gap = "6px";
      infoWrap.style.alignItems = "center";
      infoWrap.appendChild(el("strong", null, labelText));
      infoWrap.appendChild(el("span", "alfred-badge", acc.status || "disconnected"));
      if (acc.accessMode === "read_only") {
        infoWrap.appendChild(el("span", "alfred-badge", "read_only"));
      }

      const btnWrap = el("div");
      btnWrap.style.display = "flex";
      btnWrap.style.gap = "6px";

      const connectBtn = el(
        "button",
        "btn-primary",
        acc.hasRefreshToken ? "Re-auth OAuth2" : "Connect OAuth2",
      );
      connectBtn.type = "button";
      connectBtn.addEventListener("click", async () => {
        connectBtn.disabled = true;
        try {
          const qs = new URLSearchParams({
            provider: activeProv.id,
            account: acc.account,
          });
          const res = await requestJson(
            `/api/cloud/oauth/start?${qs.toString()}`,
            { method: "GET" },
            ctx,
            signal,
          );
          if (res.authUrl && typeof globalThis.open === "function") {
            globalThis.open(res.authUrl, "alfred_cloud_oauth", "width=560,height=720");
          }
          setStatus(`OAuth2 started for ${activeProv.id}::${acc.account}`);
        } catch (err) {
          setStatus(`OAuth2 error: ${err.message}`);
        } finally {
          if (!state.disposed) {
            connectBtn.disabled = false;
          }
        }
      });
      btnWrap.appendChild(connectBtn);

      if (acc.hasRefreshToken) {
        const disconnectBtn = el("button", "btn-secondary", "Disconnect");
        disconnectBtn.type = "button";
        disconnectBtn.addEventListener("click", async () => {
          disconnectBtn.disabled = true;
          try {
            await requestJson(
              "/api/cloud/disconnect",
              {
                method: "POST",
                body: JSON.stringify({ provider: activeProv.id, account: acc.account }),
              },
              ctx,
              signal,
            );
            setStatus(`Disconnected ${activeProv.id}::${acc.account}`);
            await renderAll();
          } catch (err) {
            setStatus(`Disconnect error: ${err.message}`);
          } finally {
            if (!state.disposed) {
              disconnectBtn.disabled = false;
            }
          }
        });
        btnWrap.appendChild(disconnectBtn);
      }

      row.appendChild(infoWrap);
      row.appendChild(btnWrap);
      bodyWrap.appendChild(row);
    }

    const browserHeader = el("div");
    browserHeader.style.display = "flex";
    browserHeader.style.justifyContent = "space-between";
    browserHeader.style.alignItems = "center";
    browserHeader.style.gap = "8px";
    browserHeader.appendChild(el("strong", null, `Remote Browser (${activeProv.displayName})`));

    const controls = el("div");
    controls.style.display = "flex";
    controls.style.gap = "6px";
    controls.style.flexWrap = "wrap";

    const dirInput = el("input");
    dirInput.type = "text";
    dirInput.placeholder = "New folder name";

    const mkdirBtn = el("button", "btn-secondary", "Create Folder");
    mkdirBtn.type = "button";

    const browseBtn = el("button", "btn-secondary", "Load Files");
    browseBtn.type = "button";

    const fileListEl = el("div");
    fileListEl.style.display = "flex";
    fileListEl.style.flexDirection = "column";
    fileListEl.style.gap = "4px";

    mkdirBtn.addEventListener("click", async () => {
      const folderName = dirInput.value.trim();
      if (!folderName) {
        setStatus("Enter a folder name first.");
        return;
      }
      mkdirBtn.disabled = true;
      try {
        await requestJson(
          "/api/cloud/mkdir",
          {
            method: "POST",
            body: JSON.stringify({
              provider: activeProv.id,
              account: state.activeAccount,
              pathOrName: folderName,
            }),
          },
          ctx,
          signal,
        );
        dirInput.value = "";
        setStatus(`Created folder '${folderName}'.`);
        await loadFolderItems(fileListEl);
      } catch (err) {
        setStatus(`Mkdir error: ${err.message}`);
      } finally {
        if (!state.disposed) {
          mkdirBtn.disabled = false;
        }
      }
    });

    browseBtn.addEventListener("click", () => {
      void loadFolderItems(fileListEl);
    });

    controls.appendChild(dirInput);
    controls.appendChild(mkdirBtn);
    controls.appendChild(browseBtn);
    browserBox.appendChild(browserHeader);
    browserBox.appendChild(controls);
    browserBox.appendChild(fileListEl);
  }

  function renderActivity(activityData) {
    clearElement(activityBox);
    activityBox.appendChild(el("strong", null, "Recent Activity"));
    const rows = Array.isArray(activityData?.activity) ? activityData.activity : [];
    if (rows.length === 0) {
      activityBox.appendChild(el("div", null, "No cloud activity logged yet."));
      return;
    }
    const list = el("ul");
    list.style.margin = "6px 0 0 0";
    list.style.paddingLeft = "18px";
    for (const row of rows.slice(0, 10)) {
      const bytesPart = row.byteSize ? ` (${formatBytes(row.byteSize)})` : "";
      const summary = `[${row.status}] ${row.provider}::${row.account} · ${row.action} · ${row.remoteRef}${bytesPart}`;
      list.appendChild(el("li", null, summary));
    }
    activityBox.appendChild(list);
  }

  async function renderAll() {
    if (state.disposed) {
      return;
    }
    try {
      const [statusData, activityData] = await Promise.all([
        requestJson("/api/cloud/status", { method: "GET" }, ctx, signal),
        requestJson("/api/cloud/activity?limit=15", { method: "GET" }, ctx, signal),
      ]);
      if (state.disposed) {
        return;
      }
      state.statusData = statusData;
      if (statusData.defaultProvider) {
        defaultBadge.textContent = statusData.defaultProvider;
        if (!statusData.providers?.some((p) => p.id === state.activeProvider)) {
          state.activeProvider = statusData.defaultProvider;
        }
      }
      const pubText = statusData.allowPublicLinks ? "public links enabled" : "public links disabled";
      metaLine.textContent =
        `Max download: ${statusData.maxDownloadMb || 250} MB · ` +
        `Max upload: ${statusData.maxUploadMb || 500} MB · Policy: ${pubText}`;
      renderTabs();
      renderBody();
      renderActivity(activityData);
    } catch (err) {
      if (!state.disposed) {
        metaLine.textContent = `Error loading cloud status: ${err.message}`;
      }
    }
  }

  refreshBtn.addEventListener("click", () => {
    void renderAll();
  });

  void renderAll();

  return {
    unmount() {
      unmount(container);
    },
  };
}
