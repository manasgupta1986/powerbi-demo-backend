const STORAGE_KEY = "dm_analyst_console_v1";
const POLL_INTERVAL_MS = 3000;

const DEFAULT_PROMPT = `
Analyze these tagged dashboard screenshots.

For each screenshot:
- identify the visible numerical values
- preserve the page and filter metadata
- if exact values are not printed, estimate them from the axis scale, segment height, total bar height, and legend colors
- do not guess unsupported numbers
- note uncertainties clearly

Then produce:
1. a structured extracted dataset
2. a concise executive summary
3. key findings
4. recommendations
5. data-quality notes
`.trim();

const PAGE_OPTIONS = [
  "Traffic Engagement",
  "Purchase Matrix",
  "Purchase Funnel"
];

const FILTER_OPTIONS = {
  Zone: ["East", "North", "South", "West"],
  NCCS: ["A", "B"],
  Tier: ["Tier 1", "Tier 2", "Tier 3 & lower"],
  Gender: ["Male", "Female"],
  "Age Band": ["Below 18", "18-24", "25-35", "35-44", "45-54", "55+"]
};

const state = {
  settings: {
    backendUrl: "https://powerbi-demo-backend.onrender.com",
    workspaceName: "default-workspace",
    clientName: "",
    operatorName: "",
    defaultPage: "Traffic Engagement",
    defaultFilterType: "Zone",
    promptOverride: DEFAULT_PROMPT,
    promptCollapsed: false
  },
  activeTab: "tab-analyst",
  queue: [],
  currentRunId: null,
  uploadInProgress: false,
  analysisInProgress: false,
  latestStatus: null,
  latestAnalysis: null,
  latestReportPayload: null,
  chatMessages: []
};

const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheDom();
  bindEvents();
  await loadState();
  applyStateToDom();
  renderAll();

  await checkBackend();
  await refreshLatestRun();
  await refreshAnalysisStatusSilently();
  await refreshLatestAnalysis();
  await refreshLatestReport();
});

function cacheDom() {
  Object.assign(els, {
    backendStatus: document.getElementById("backendStatus"),
    backendUrl: document.getElementById("backendUrl"),
    workspaceName: document.getElementById("workspaceName"),
    clientName: document.getElementById("clientName"),
    operatorName: document.getElementById("operatorName"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    checkBackendBtn: document.getElementById("checkBackendBtn"),

    queueCount: document.getElementById("queueCount"),
    defaultPage: document.getElementById("defaultPage"),
    defaultFilterType: document.getElementById("defaultFilterType"),
    fileInput: document.getElementById("fileInput"),
    uploadQueue: document.getElementById("uploadQueue"),
    clearQueueBtn: document.getElementById("clearQueueBtn"),
    startUploadBtn: document.getElementById("startUploadBtn"),

    togglePromptBtn: document.getElementById("togglePromptBtn"),
    promptArea: document.getElementById("promptArea"),
    promptOverride: document.getElementById("promptOverride"),
    resetPromptBtn: document.getElementById("resetPromptBtn"),
    copyPromptBtn: document.getElementById("copyPromptBtn"),

    analysisStatus: document.getElementById("analysisStatus"),
    startAnalysisBtn: document.getElementById("startAnalysisBtn"),
    refreshStatusBtn: document.getElementById("refreshStatusBtn"),
    analysisProgress: document.getElementById("analysisProgress"),

    reportStatus: document.getElementById("reportStatus"),
    refreshReportBtn: document.getElementById("refreshReportBtn"),
    openReportLink: document.getElementById("openReportLink"),
    reportContainer: document.getElementById("reportContainer"),

    chatStatus: document.getElementById("chatStatus"),
    chatMessages: document.getElementById("chatMessages"),
    chatInput: document.getElementById("chatInput"),
    clearChatBtn: document.getElementById("clearChatBtn"),
    sendChatBtn: document.getElementById("sendChatBtn")
  });
}

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      setActiveTab(btn.dataset.tab);

      if (btn.dataset.tab === "tab-report") {
        await refreshLatestReport();
      }

      if (btn.dataset.tab === "tab-chat") {
        renderChat();
      }
    });
  });

  els.saveSettingsBtn.addEventListener("click", async () => {
    syncSettingsFromDom();
    await persistState();
    notify("Settings saved");
  });

  els.checkBackendBtn.addEventListener("click", checkBackend);

  els.defaultPage.addEventListener("change", async () => {
    syncSettingsFromDom();
    await persistState();
  });

  els.defaultFilterType.addEventListener("change", async () => {
    syncSettingsFromDom();
    await persistState();
  });

  els.fileInput.addEventListener("change", handleFilesSelected);
  els.clearQueueBtn.addEventListener("click", clearQueue);
  els.startUploadBtn.addEventListener("click", startUploadFlow);

  els.togglePromptBtn.addEventListener("click", togglePromptArea);
  els.resetPromptBtn.addEventListener("click", resetPrompt);
  els.copyPromptBtn.addEventListener("click", copyPrompt);

  els.startAnalysisBtn.addEventListener("click", startAnalysisFlow);
  els.refreshStatusBtn.addEventListener("click", refreshAnalysisStatus);

  els.refreshReportBtn.addEventListener("click", refreshLatestReport);

  els.sendChatBtn.addEventListener("click", sendChatMessage);
  els.clearChatBtn.addEventListener("click", clearChat);

  els.chatInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      sendChatMessage();
    }
  });
}

async function loadState() {
  const saved = await chrome.storage.local.get([STORAGE_KEY]);
  if (saved?.[STORAGE_KEY]) {
    const stored = saved[STORAGE_KEY];

    state.settings = {
      ...state.settings,
      ...(stored.settings || {})
    };

    state.activeTab = stored.activeTab || state.activeTab;
    state.queue = Array.isArray(stored.queue) ? stored.queue : [];
    state.currentRunId = stored.currentRunId || null;
    state.chatMessages = Array.isArray(stored.chatMessages)
      ? stored.chatMessages
      : [];
  }
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      settings: state.settings,
      activeTab: state.activeTab,
      queue: state.queue,
      currentRunId: state.currentRunId,
      chatMessages: state.chatMessages
    }
  });
}

function applyStateToDom() {
  els.backendUrl.value = state.settings.backendUrl;
  els.workspaceName.value = state.settings.workspaceName;
  els.clientName.value = state.settings.clientName;
  els.operatorName.value = state.settings.operatorName;
  els.defaultPage.value = state.settings.defaultPage;
  els.defaultFilterType.value = state.settings.defaultFilterType;
  els.promptOverride.value = state.settings.promptOverride;

  setActiveTab(state.activeTab, false);

  if (state.settings.promptCollapsed) {
    els.promptArea.classList.add("hidden");
    els.togglePromptBtn.textContent = "Expand";
  } else {
    els.promptArea.classList.remove("hidden");
    els.togglePromptBtn.textContent = "Collapse";
  }
}

function syncSettingsFromDom() {
  state.settings.backendUrl = sanitizeUrl(els.backendUrl.value);
  state.settings.workspaceName =
    els.workspaceName.value.trim() || "default-workspace";
  state.settings.clientName = els.clientName.value.trim();
  state.settings.operatorName = els.operatorName.value.trim();
  state.settings.defaultPage = els.defaultPage.value;
  state.settings.defaultFilterType = els.defaultFilterType.value;
  state.settings.promptOverride =
    els.promptOverride.value.trim() || DEFAULT_PROMPT;
}

function setActiveTab(tabId, persist = true) {
  state.activeTab = tabId;

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });

  if (persist) {
    persistState();
  }
}

function renderAll() {
  renderQueue();
  renderAnalysisStatus();
  renderReport();
  renderChat();
}

async function handleFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  syncSettingsFromDom();

  const newEntries = [];
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const parsed = parseFilename(file.name);

    newEntries.push({
      id: crypto.randomUUID(),
      fileName: file.name,
      page: parsed.page || state.settings.defaultPage,
      filterType: parsed.filterType || state.settings.defaultFilterType,
      filterValue: parsed.filterValue || "",
      note: "",
      dataUrl,
      uploaded: false
    });
  }

  state.queue.unshift(...newEntries);
  els.fileInput.value = "";

  await persistState();
  renderQueue();
  notify(`${newEntries.length} file(s) added`);
}

function parseFilename(fileName) {
  const lower = String(fileName || "").toLowerCase();

  let page = "";
  if (lower.includes("traffic") && lower.includes("engagement")) {
    page = "Traffic Engagement";
  } else if (lower.includes("purchase") && lower.includes("matrix")) {
    page = "Purchase Matrix";
  } else if (lower.includes("purchase") && lower.includes("funnel")) {
    page = "Purchase Funnel";
  }

  let filterType = "";
  if (lower.includes("zone")) filterType = "Zone";
  else if (lower.includes("nccs")) filterType = "NCCS";
  else if (lower.includes("tier")) filterType = "Tier";
  else if (lower.includes("gender")) filterType = "Gender";
  else if (lower.includes("age")) filterType = "Age Band";

  let filterValue = "";
  if (filterType === "Zone") {
    if (lower.includes("east")) filterValue = "East";
    if (lower.includes("west")) filterValue = "West";
    if (lower.includes("north")) filterValue = "North";
    if (lower.includes("south")) filterValue = "South";
  } else if (filterType === "NCCS") {
    if (lower.includes("nccs a") || lower.includes("_a")) filterValue = "A";
    if (lower.includes("nccs b") || lower.includes("_b")) filterValue = "B";
  } else if (filterType === "Tier") {
    if (lower.includes("tier 1") || lower.includes("tier1")) {
      filterValue = "Tier 1";
    } else if (lower.includes("tier 2") || lower.includes("tier2")) {
      filterValue = "Tier 2";
    } else if (
      lower.includes("tier 3") ||
      lower.includes("tier3") ||
      lower.includes("lower")
    ) {
      filterValue = "Tier 3 & lower";
    }
  } else if (filterType === "Gender") {
    if (lower.includes("female")) filterValue = "Female";
    else if (lower.includes("male")) filterValue = "Male";
  } else if (filterType === "Age Band") {
    if (lower.includes("below 18")) filterValue = "Below 18";
    else if (lower.includes("18-24")) filterValue = "18-24";
    else if (lower.includes("25-35")) filterValue = "25-35";
    else if (lower.includes("35-44")) filterValue = "35-44";
    else if (lower.includes("45-54")) filterValue = "45-54";
    else if (lower.includes("55+")) filterValue = "55+";
    else if (lower.includes("55 plus")) filterValue = "55+";
  }

  return { page, filterType, filterValue };
}

function renderQueue() {
  els.queueCount.textContent = `${state.queue.length} file${
    state.queue.length === 1 ? "" : "s"
  }`;

  if (!state.queue.length) {
    els.uploadQueue.innerHTML = "No screenshots added yet.";
    els.uploadQueue.classList.add("empty-state");
    return;
  }

  els.uploadQueue.classList.remove("empty-state");
  els.uploadQueue.innerHTML = "";

  state.queue.forEach((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = "queue-item";

    const filterValues = FILTER_OPTIONS[item.filterType] || [];

    wrapper.innerHTML = `
      <div class="queue-top">
        <div>
          <div class="queue-name">${escapeHtml(item.fileName)}</div>
          <div class="queue-subtext">
            ${item.uploaded ? "Uploaded" : "Pending upload"}
          </div>
        </div>
        <button class="btn btn-ghost" data-remove-id="${item.id}">Remove</button>
      </div>

      <div class="queue-grid">
        <label>
          <span>Page</span>
          <select data-field="page" data-id="${item.id}">
            ${PAGE_OPTIONS.map((opt) => {
              return `<option value="${escapeAttr(opt)}" ${
                item.page === opt ? "selected" : ""
              }>${escapeHtml(opt)}</option>`;
            }).join("")}
          </select>
        </label>

        <label>
          <span>Filter type</span>
          <select data-field="filterType" data-id="${item.id}">
            ${Object.keys(FILTER_OPTIONS).map((opt) => {
              return `<option value="${escapeAttr(opt)}" ${
                item.filterType === opt ? "selected" : ""
              }>${escapeHtml(opt)}</option>`;
            }).join("")}
          </select>
        </label>

        <label>
          <span>Filter value</span>
          <input
            type="text"
            value="${escapeAttr(item.filterValue || "")}"
            data-field="filterValue"
            data-id="${item.id}"
            list="filter-values-${item.id}"
          />
          <datalist id="filter-values-${item.id}">
            ${filterValues.map((value) => {
              return `<option value="${escapeAttr(value)}"></option>`;
            }).join("")}
          </datalist>
        </label>
      </div>

      <div class="queue-note">
        <label>
          <span>Note</span>
          <textarea rows="2" data-field="note" data-id="${item.id}">${escapeHtml(
            item.note || ""
          )}</textarea>
        </label>
      </div>

      <img class="preview-img" src="${item.dataUrl}" alt="${escapeAttr(
      item.fileName
    )}" />
    `;

    els.uploadQueue.appendChild(wrapper);
  });

  els.uploadQueue.querySelectorAll("[data-remove-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.queue = state.queue.filter((item) => item.id !== btn.dataset.removeId);
      await persistState();
      renderQueue();
    });
  });

  els.uploadQueue.querySelectorAll("[data-field]").forEach((field) => {
    field.addEventListener("input", handleQueueEdit);
    field.addEventListener("change", handleQueueEdit);
  });
}

async function handleQueueEdit(event) {
  const id = event.target.dataset.id;
  const field = event.target.dataset.field;

  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;

  item[field] = event.target.value;

  if (field === "filterType") {
    const valid = FILTER_OPTIONS[item.filterType] || [];
    if (!valid.includes(item.filterValue)) {
      item.filterValue = "";
      renderQueue();
    }
  }

  await persistState();
}

async function clearQueue() {
  state.queue = [];
  await persistState();
  renderQueue();
}

function togglePromptArea() {
  state.settings.promptCollapsed = !state.settings.promptCollapsed;

  if (state.settings.promptCollapsed) {
    els.promptArea.classList.add("hidden");
    els.togglePromptBtn.textContent = "Expand";
  } else {
    els.promptArea.classList.remove("hidden");
    els.togglePromptBtn.textContent = "Collapse";
  }

  persistState();
}

async function resetPrompt() {
  state.settings.promptOverride = DEFAULT_PROMPT;
  els.promptOverride.value = DEFAULT_PROMPT;
  await persistState();
  notify("Prompt reset");
}

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(els.promptOverride.value);
    notify("Prompt copied");
  } catch (error) {
    notify("Could not copy prompt");
  }
}

async function checkBackend() {
  syncSettingsFromDom();
  setPill(els.backendStatus, "Checking...", "warning");

  try {
    const payload = await api("/health", { method: "GET" });
    if (payload?.ok === true || payload) {
      setPill(els.backendStatus, "Backend ready", "success");
    } else {
      setPill(els.backendStatus, "Backend issue", "danger");
    }
  } catch (error) {
    setPill(els.backendStatus, "Backend offline", "danger");
  }
}

async function startUploadFlow() {
  if (state.uploadInProgress) return;

  syncSettingsFromDom();

  if (!state.queue.length) {
    notify("Add screenshots first");
    return;
  }

  state.uploadInProgress = true;
  setBusy(els.startUploadBtn, true, "Uploading...");

  try {
    const startRes = await api("/analyst/upload/start", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        clientName: state.settings.clientName,
        operatorName: state.settings.operatorName
      })
    });

    const runId = startRes.runId;
    state.currentRunId = runId;
    state.latestStatus = null;
    state.latestAnalysis = null;
    state.latestReportPayload = null;
    state.chatMessages = [];
    await persistState();
    renderChat();
    renderReport();

    let uploadedCount = 0;

    for (const item of state.queue) {
      if (item.uploaded) {
        uploadedCount += 1;
        continue;
      }

      await api("/analyst/upload/file", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: state.settings.workspaceName,
          runId,
          fileName: item.fileName,
          page: item.page,
          filterType: item.filterType,
          filterValue: item.filterValue,
          note: item.note,
          dataUrl: item.dataUrl
        })
      });

      item.uploaded = true;
      uploadedCount += 1;
      await persistState();
      renderQueue();

      els.analysisProgress.classList.remove("empty-state");
      els.analysisProgress.innerHTML = `
        <div><strong>Upload in progress</strong></div>
        <div class="muted">Run ID: ${escapeHtml(runId)}</div>
        <div class="muted">Uploaded ${uploadedCount} of ${state.queue.length} file(s)</div>
      `;
    }

    const finishRes = await api("/analyst/upload/finish", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        runId
      })
    });

    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `
      <div><strong>Upload completed</strong></div>
      <div class="muted">Run ID: ${escapeHtml(runId)}</div>
      <div class="muted">Status: ${escapeHtml(finishRes.status || "upload_complete")}</div>
      <div class="muted">Files: ${escapeHtml(String(finishRes.fileCount || state.queue.length))}</div>
    `;

    setPill(els.analysisStatus, "Upload complete", "success");
    notify("Upload completed");
  } catch (error) {
    setPill(els.analysisStatus, "Upload failed", "danger");
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `
      <div><strong>Upload failed</strong></div>
      <div class="muted">${escapeHtml(error.message || "Unknown error")}</div>
    `;
    notify(error.message || "Upload failed");
  } finally {
    state.uploadInProgress = false;
    setBusy(els.startUploadBtn, false, "Upload screenshots");
  }
}

async function refreshLatestRun() {
  try {
    syncSettingsFromDom();

    const payload = await api(
      `/analyst/upload/latest?workspaceName=${encodeURIComponent(
        state.settings.workspaceName
      )}`,
      { method: "GET" }
    );

    const latestRun = payload?.latestRun || null;
    if (latestRun?.runId) {
      state.currentRunId = latestRun.runId;
      await persistState();
    }
  } catch (error) {
    // ignore
  }
}

async function startAnalysisFlow() {
  if (state.analysisInProgress) return;

  syncSettingsFromDom();

  if (!state.currentRunId) {
    notify("Upload screenshots first");
    return;
  }

  state.analysisInProgress = true;
  setBusy(els.startAnalysisBtn, true, "Starting...");
  setPill(els.analysisStatus, "Queued", "warning");

  try {
    const payload = await api("/analyst/analyze/start", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        runId: state.currentRunId,
        promptOverride: state.settings.promptOverride
      })
    });

    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `
      <div><strong>Analysis started</strong></div>
      <div class="muted">Run ID: ${escapeHtml(payload.runId || state.currentRunId)}</div>
      <div class="muted">Status: ${escapeHtml(payload.status || "queued")}</div>
    `;

    notify("AI analysis started");
    await pollAnalysisStatus();
  } catch (error) {
    setPill(els.analysisStatus, "Failed", "danger");
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `
      <div><strong>Could not start analysis</strong></div>
      <div class="muted">${escapeHtml(error.message || "Unknown error")}</div>
    `;
    notify(error.message || "Could not start analysis");
  } finally {
    state.analysisInProgress = false;
    setBusy(els.startAnalysisBtn, false, "Start AI analysis");
  }
}

async function refreshAnalysisStatus() {
  if (!state.currentRunId) {
    notify("No run available yet");
    return;
  }

  try {
    const payload = await api(
      `/analyst/analyze/status?workspaceName=${encodeURIComponent(
        state.settings.workspaceName
      )}&runId=${encodeURIComponent(state.currentRunId)}`,
      { method: "GET" }
    );

    state.latestStatus = payload;

    if (payload?.analysis) {
      state.latestAnalysis = payload.analysis;
    }

    renderAnalysisStatus();
    await refreshLatestReport();
  } catch (error) {
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `
      <div><strong>Status refresh failed</strong></div>
      <div class="muted">${escapeHtml(error.message || "Unknown error")}</div>
    `;
  }
}

async function refreshAnalysisStatusSilently() {
  if (!state.currentRunId) return;

  try {
    const payload = await api(
      `/analyst/analyze/status?workspaceName=${encodeURIComponent(
        state.settings.workspaceName
      )}&runId=${encodeURIComponent(state.currentRunId)}`,
      { method: "GET" }
    );

    state.latestStatus = payload;
    if (payload?.analysis) {
      state.latestAnalysis = payload.analysis;
    }
    renderAnalysisStatus();
  } catch (error) {
    // ignore
  }
}

async function pollAnalysisStatus() {
  if (!state.currentRunId) return;

  let keepPolling = true;

  while (keepPolling) {
    try {
      const payload = await api(
        `/analyst/analyze/status?workspaceName=${encodeURIComponent(
          state.settings.workspaceName
        )}&runId=${encodeURIComponent(state.currentRunId)}`,
        { method: "GET" }
      );

      state.latestStatus = payload;
      if (payload?.analysis) {
        state.latestAnalysis = payload.analysis;
      }

      renderAnalysisStatus();

      const status = payload?.status || "";

      if (status === "completed" || status === "failed") {
        keepPolling = false;
        await refreshLatestAnalysis();
        await refreshLatestReport();
        renderReport();
        break;
      }
    } catch (error) {
      keepPolling = false;
      els.analysisProgress.classList.remove("empty-state");
      els.analysisProgress.innerHTML = `
        <div><strong>Polling failed</strong></div>
        <div class="muted">${escapeHtml(error.message || "Unknown error")}</div>
      `;
      break;
    }

    await delay(POLL_INTERVAL_MS);
  }
}

function renderAnalysisStatus() {
  const payload = state.latestStatus;

  if (!payload) {
    setPill(els.analysisStatus, "Idle", "muted");
    if (!state.currentRunId) {
      els.analysisProgress.innerHTML = "No analysis started yet.";
      els.analysisProgress.classList.add("empty-state");
    }
    return;
  }

  els.analysisProgress.classList.remove("empty-state");

  const status = payload.status || "unknown";
  const pillTone =
    status === "completed"
      ? "success"
      : status === "failed"
      ? "danger"
      : "warning";

  setPill(els.analysisStatus, capitalize(status), pillTone);

  els.analysisProgress.innerHTML = `
    <div><strong>Current analysis status</strong></div>
    <div class="muted">Run ID: ${escapeHtml(payload.runId || state.currentRunId || "")}</div>
    <div class="muted">Status: ${escapeHtml(status)}</div>
    <div class="muted">Numeric rows: ${escapeHtml(
      String(payload.numericRowCount || 0)
    )}</div>
    <div class="muted">Text rows: ${escapeHtml(
      String(payload.textRowCount || 0)
    )}</div>
    <div class="muted">Summary ready: ${payload.hasSummary ? "Yes" : "No"}</div>
    <div class="muted">Report ready: ${payload.hasReport ? "Yes" : "No"}</div>
    ${
      payload.error
        ? `<div class="muted" style="color:#ffb6b6;">Error: ${escapeHtml(
            payload.error
          )}</div>`
        : ""
    }
  `;
}

async function refreshLatestAnalysis() {
  try {
    syncSettingsFromDom();

    const payload = await api(
      `/analyst/analyze/latest?workspaceName=${encodeURIComponent(
        state.settings.workspaceName
      )}`,
      { method: "GET" }
    );

    state.latestAnalysis = payload?.latest?.analysis || null;

    if (payload?.latest?.run?.runId) {
      state.currentRunId = payload.latest.run.runId;
      await persistState();
    }
  } catch (error) {
    // ignore
  }
}

async function refreshLatestReport() {
  try {
    syncSettingsFromDom();

    const payload = await api(
      `/analyst/report/latest?workspaceName=${encodeURIComponent(
        state.settings.workspaceName
      )}`,
      { method: "GET" }
    );

    state.latestReportPayload = payload;

    if (payload?.runId) {
      state.currentRunId = payload.runId;
      await persistState();
    }

    renderReport();
  } catch (error) {
    state.latestReportPayload = null;
    renderReport();
  }
}

function renderReport() {
  const reportPayload = state.latestReportPayload;
  const analysis = state.latestAnalysis;

  const report = reportPayload?.report || analysis?.report || null;
  const summary = reportPayload?.summary || analysis?.summary || "";

  if (!report) {
    setPill(els.reportStatus, "No report", "muted");
    els.reportContainer.innerHTML = "No report available yet.";
    els.reportContainer.classList.add("empty-state");
    els.openReportLink.href = "#";
    els.openReportLink.setAttribute("aria-disabled", "true");
    return;
  }

  setPill(els.reportStatus, "Ready", "success");
  els.reportContainer.classList.remove("empty-state");

  els.reportContainer.innerHTML = `
    <div class="report-section">
      <h3>${escapeHtml(report.title || "Summary Report")}</h3>
      ${
        summary
          ? `<div class="report-summary">${escapeHtml(summary)}</div>`
          : ""
      }
    </div>

    ${renderListSection("Executive Summary", report.executive_summary)}
    ${renderListSection("Key Findings", report.key_findings)}
    ${renderListSection("Recommendations", report.recommendations)}
    ${renderListSection("Data Quality Notes", report.data_quality_notes)}
  `;

  const htmlReportUrl = reportPayload?.htmlReportUrl || "";
  if (htmlReportUrl) {
    els.openReportLink.href = absolutizeBackendPath(htmlReportUrl);
    els.openReportLink.removeAttribute("aria-disabled");
  } else {
    els.openReportLink.href = "#";
    els.openReportLink.setAttribute("aria-disabled", "true");
  }
}

function renderListSection(title, items) {
  const safeItems = Array.isArray(items) ? items : [];
  if (!safeItems.length) return "";

  return `
    <div class="report-section">
      <h3>${escapeHtml(title)}</h3>
      <ul>
        ${safeItems
          .map((item) => `<li>${escapeHtml(String(item))}</li>`)
          .join("")}
      </ul>
    </div>
  `;
}

async function sendChatMessage() {
  const question = els.chatInput.value.trim();
  if (!question) return;

  appendChatMessage("user", question);
  els.chatInput.value = "";
  setBusy(els.sendChatBtn, true, "Sending...");

  try {
    syncSettingsFromDom();

    const payload = await api("/analyst/chat", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        runId: state.currentRunId,
        messages: state.chatMessages,
        userQuestion: question
      })
    });

    const answer =
      payload?.answer ||
      payload?.message ||
      "No response returned from the backend.";

    appendChatMessage("assistant", answer);
    setPill(els.chatStatus, "Connected", "success");
  } catch (error) {
    let message = error.message || "Chat failed";

    if (
      message.includes("404") ||
      message.toLowerCase().includes("cannot post") ||
      message.toLowerCase().includes("not found")
    ) {
      message =
        "Chat endpoint is not live yet. The UI is ready, but backend /analyst/chat still needs to be added.";
    }

    appendChatMessage("assistant", message);
    setPill(els.chatStatus, "Unavailable", "warning");
  } finally {
    setBusy(els.sendChatBtn, false, "Send");
  }
}

function appendChatMessage(role, content) {
  state.chatMessages.push({
    role,
    content,
    createdAt: new Date().toISOString()
  });

  persistState();
  renderChat();
}

async function clearChat() {
  state.chatMessages = [];
  await persistState();
  renderChat();
}

function renderChat() {
  if (!state.chatMessages.length) {
    els.chatMessages.innerHTML =
      "Chat will appear here after analysis is completed.";
    els.chatMessages.classList.add("empty-state");
    return;
  }

  els.chatMessages.classList.remove("empty-state");
  els.chatMessages.innerHTML = "";

  state.chatMessages.forEach((message) => {
    const div = document.createElement("div");
    div.className = `chat-message ${message.role}`;
    div.textContent = message.content;
    els.chatMessages.appendChild(div);
  });

  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function api(path, options = {}) {
  const baseUrl = sanitizeUrl(
    state.settings.backendUrl || els.backendUrl.value || ""
  );

  if (!baseUrl) {
    throw new Error("Backend URL is required");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body || undefined
  });

  const text = await response.text();

  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message =
      payload?.error ||
      payload?.message ||
      payload?.raw ||
      `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

function absolutizeBackendPath(relativeOrAbsolute) {
  if (!relativeOrAbsolute) return "#";
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;

  const baseUrl = sanitizeUrl(
    state.settings.backendUrl || els.backendUrl.value || ""
  );
  if (!baseUrl) return relativeOrAbsolute;

  if (relativeOrAbsolute.startsWith("/")) {
    return `${baseUrl}${relativeOrAbsolute}`;
  }

  return `${baseUrl}/${relativeOrAbsolute}`;
}

function setPill(el, text, tone = "muted") {
  el.textContent = text;
  el.className = `pill pill-${tone}`;
}

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }

  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function sanitizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function capitalize(value) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notify(message) {
  console.log("[Data Myner Analyst Console]", message);
}
