const STORAGE_KEY = "dm_analyst_console_v2";
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

const PAGE_OPTIONS = ["Traffic Engagement", "Purchase Matrix", "Purchase Funnel"];
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
  activeTab: "tab-collect",
  queue: [],
  currentRunId: null,
  selectedReportRunId: null,
  uploadInProgress: false,
  analysisInProgress: false,
  latestStatus: null,
  latestReportPayload: null,
  runHistory: [],
  chatByRun: {}
};

const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheDom();
  bindEvents();
  await loadState();
  applyStateToDom();
  renderAll();

  await checkBackend();
  await refreshRunHistory();
  if (!state.currentRunId) autoSelectBestRun();
  if (state.currentRunId) await refreshAnalysisStatusSilently();
  await refreshReportForSelectedRun();
  renderAll();
});

function cacheDom() {
  Object.assign(els, {
    backendStatus: byId("backendStatus"),
    workspaceBadge: byId("workspaceBadge"),
    backendUrl: byId("backendUrl"),
    workspaceName: byId("workspaceName"),
    clientName: byId("clientName"),
    operatorName: byId("operatorName"),
    saveSettingsBtn: byId("saveSettingsBtn"),
    checkBackendBtn: byId("checkBackendBtn"),

    currentRunStatus: byId("currentRunStatus"),
    currentRunSummary: byId("currentRunSummary"),
    startNewRunBtn: byId("startNewRunBtn"),
    continueLatestBtn: byId("continueLatestBtn"),

    queueCount: byId("queueCount"),
    defaultPage: byId("defaultPage"),
    defaultFilterType: byId("defaultFilterType"),
    addScreenshotsBtn: byId("addScreenshotsBtn"),
    fileInput: byId("fileInput"),
    uploadQueue: byId("uploadQueue"),
    clearQueueBtn: byId("clearQueueBtn"),
    uploadBatchBtn: byId("uploadBatchBtn"),
    analyzeBatchBtn: byId("analyzeBatchBtn"),

    togglePromptBtn: byId("togglePromptBtn"),
    promptArea: byId("promptArea"),
    promptOverride: byId("promptOverride"),
    resetPromptBtn: byId("resetPromptBtn"),
    copyPromptBtn: byId("copyPromptBtn"),

    analysisStatus: byId("analysisStatus"),
    analysisProgress: byId("analysisProgress"),
    refreshStatusBtn: byId("refreshStatusBtn"),
    retryAnalysisBtn: byId("retryAnalysisBtn"),

    historyList: byId("historyList"),
    refreshHistoryBtn: byId("refreshHistoryBtn"),

    reportStatus: byId("reportStatus"),
    reportReference: byId("reportReference"),
    useLatestReportBtn: byId("useLatestReportBtn"),
    refreshReportBtn: byId("refreshReportBtn"),
    openReportLink: byId("openReportLink"),
    reportContainer: byId("reportContainer"),

    chatStatus: byId("chatStatus"),
    chatReference: byId("chatReference"),
    chatMessages: byId("chatMessages"),
    chatInput: byId("chatInput"),
    clearChatBtn: byId("clearChatBtn"),
    sendChatBtn: byId("sendChatBtn")
  });
}

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      setActiveTab(btn.dataset.tab);
      if (btn.dataset.tab === "tab-report") await refreshReportForSelectedRun();
      if (btn.dataset.tab === "tab-ask") renderChatArea();
    });
  });

  els.saveSettingsBtn.addEventListener("click", async () => {
    syncSettingsFromDom();
    await persistState();
    updateWorkspaceBadge();
    notify("Settings saved");
  });

  els.checkBackendBtn.addEventListener("click", checkBackend);
  els.startNewRunBtn.addEventListener("click", startNewRun);
  els.continueLatestBtn.addEventListener("click", continueLatestRun);
  els.addScreenshotsBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", handleFilesSelected);
  els.clearQueueBtn.addEventListener("click", clearQueue);
  els.uploadBatchBtn.addEventListener("click", uploadCurrentBatch);
  els.analyzeBatchBtn.addEventListener("click", doneAddingAnalyzeBatch);

  els.defaultPage.addEventListener("change", saveSettingsFromControls);
  els.defaultFilterType.addEventListener("change", saveSettingsFromControls);

  els.togglePromptBtn.addEventListener("click", togglePromptArea);
  els.resetPromptBtn.addEventListener("click", resetPrompt);
  els.copyPromptBtn.addEventListener("click", copyPrompt);

  els.refreshStatusBtn.addEventListener("click", refreshAnalysisStatus);
  els.retryAnalysisBtn.addEventListener("click", retryAnalysis);
  els.refreshHistoryBtn.addEventListener("click", refreshRunHistory);

  els.useLatestReportBtn.addEventListener("click", useLatestCompletedRun);
  els.refreshReportBtn.addEventListener("click", refreshReportForSelectedRun);

  els.sendChatBtn.addEventListener("click", sendChatMessage);
  els.clearChatBtn.addEventListener("click", clearChatForSelectedRun);
  els.chatInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendChatMessage();
  });
}

async function loadState() {
  const saved = await chrome.storage.local.get([STORAGE_KEY]);
  const data = saved?.[STORAGE_KEY];
  if (!data) return;
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.activeTab = data.activeTab || state.activeTab;
  state.queue = Array.isArray(data.queue) ? data.queue : [];
  state.currentRunId = data.currentRunId || null;
  state.selectedReportRunId = data.selectedReportRunId || null;
  state.chatByRun = data.chatByRun || {};
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      settings: state.settings,
      activeTab: state.activeTab,
      queue: state.queue,
      currentRunId: state.currentRunId,
      selectedReportRunId: state.selectedReportRunId,
      chatByRun: state.chatByRun
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
  updateWorkspaceBadge();

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
  state.settings.workspaceName = els.workspaceName.value.trim() || "default-workspace";
  state.settings.clientName = els.clientName.value.trim();
  state.settings.operatorName = els.operatorName.value.trim();
  state.settings.defaultPage = els.defaultPage.value;
  state.settings.defaultFilterType = els.defaultFilterType.value;
  state.settings.promptOverride = els.promptOverride.value.trim() || DEFAULT_PROMPT;
}

async function saveSettingsFromControls() {
  syncSettingsFromDom();
  await persistState();
}

function setActiveTab(tabId, persist = true) {
  state.activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
  if (persist) persistState();
}

function updateWorkspaceBadge() {
  els.workspaceBadge.textContent = `Workspace: ${state.settings.workspaceName || "default-workspace"}`;
}

function renderAll() {
  updateWorkspaceBadge();
  renderCurrentRunCard();
  renderQueue();
  renderAnalysisStatus();
  renderHistory();
  renderReport();
  renderChatArea();
}

async function startNewRun() {
  syncSettingsFromDom();
  state.queue = [];
  state.currentRunId = null;
  state.selectedReportRunId = null;
  state.latestStatus = null;
  state.latestReportPayload = null;
  await persistState();
  renderAll();
  notify("New run started. Add screenshots next.");
}

async function continueLatestRun() {
  await refreshRunHistory();
  autoSelectBestRun();
  if (state.currentRunId) await refreshAnalysisStatusSilently();
  await refreshReportForSelectedRun();
  renderAll();
}

function autoSelectBestRun() {
  const latest = state.runHistory[0];
  if (!latest) return;
  state.currentRunId = state.currentRunId || latest.runId;
  state.selectedReportRunId = state.selectedReportRunId || latest.runId;
  persistState();
}

async function handleFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  syncSettingsFromDom();

  const additions = [];
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const parsed = parseFilename(file.name);
    additions.push({
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

  state.queue.unshift(...additions);
  els.fileInput.value = "";
  await persistState();
  renderQueue();
  renderCurrentRunCard();
  notify(`${additions.length} screenshot(s) added`);
}

function parseFilename(fileName) {
  const lower = String(fileName || "").toLowerCase();
  let page = "";
  if (lower.includes("traffic") && lower.includes("engagement")) page = "Traffic Engagement";
  else if (lower.includes("purchase") && lower.includes("matrix")) page = "Purchase Matrix";
  else if (lower.includes("purchase") && lower.includes("funnel")) page = "Purchase Funnel";

  let filterType = "";
  if (lower.includes("zone")) filterType = "Zone";
  else if (lower.includes("nccs")) filterType = "NCCS";
  else if (lower.includes("tier")) filterType = "Tier";
  else if (lower.includes("gender")) filterType = "Gender";
  else if (lower.includes("age")) filterType = "Age Band";

  let filterValue = "";
  const pairs = {
    Zone: [["east", "East"], ["west", "West"], ["north", "North"], ["south", "South"]],
    NCCS: [["nccs a", "A"], ["_a", "A"], ["nccs b", "B"], ["_b", "B"]],
    Tier: [["tier 1", "Tier 1"], ["tier1", "Tier 1"], ["tier 2", "Tier 2"], ["tier2", "Tier 2"], ["tier 3", "Tier 3 & lower"], ["tier3", "Tier 3 & lower"], ["lower", "Tier 3 & lower"]],
    Gender: [["female", "Female"], ["male", "Male"]],
    "Age Band": [["below 18", "Below 18"], ["18-24", "18-24"], ["25-35", "25-35"], ["35-44", "35-44"], ["45-54", "45-54"], ["55+", "55+"], ["55 plus", "55+"]]
  };
  for (const [needle, label] of pairs[filterType] || []) {
    if (lower.includes(needle)) { filterValue = label; break; }
  }

  return { page, filterType, filterValue };
}

function renderQueue() {
  els.queueCount.textContent = `${state.queue.length} file${state.queue.length === 1 ? "" : "s"}`;
  if (!state.queue.length) {
    els.uploadQueue.classList.add("empty-state");
    els.uploadQueue.innerHTML = "No screenshots added yet.";
    return;
  }

  els.uploadQueue.classList.remove("empty-state");
  els.uploadQueue.innerHTML = "";
  state.queue.forEach((item) => {
    const filterValues = FILTER_OPTIONS[item.filterType] || [];
    const node = document.createElement("div");
    node.className = "queue-item";
    node.innerHTML = `
      <div class="queue-top">
        <div>
          <div class="queue-name">${escapeHtml(item.fileName)}</div>
          <div class="queue-subtext">${item.uploaded ? "Uploaded to backend" : "Pending upload"}</div>
        </div>
        <button class="btn btn-ghost" data-remove-id="${item.id}">Remove</button>
      </div>
      <div class="queue-grid">
        <label>
          <span>Page</span>
          <select data-field="page" data-id="${item.id}">
            ${PAGE_OPTIONS.map((opt) => `<option value="${escapeAttr(opt)}" ${item.page === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>Filter type</span>
          <select data-field="filterType" data-id="${item.id}">
            ${Object.keys(FILTER_OPTIONS).map((opt) => `<option value="${escapeAttr(opt)}" ${item.filterType === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>Filter value</span>
          <input type="text" value="${escapeAttr(item.filterValue || "")}" data-field="filterValue" data-id="${item.id}" list="list-${item.id}" />
          <datalist id="list-${item.id}">
            ${filterValues.map((value) => `<option value="${escapeAttr(value)}"></option>`).join("")}
          </datalist>
        </label>
      </div>
      <div class="queue-note">
        <label>
          <span>Note</span>
          <textarea rows="2" data-field="note" data-id="${item.id}">${escapeHtml(item.note || "")}</textarea>
        </label>
      </div>
      <img class="preview-img" src="${item.dataUrl}" alt="${escapeAttr(item.fileName)}" />
    `;
    els.uploadQueue.appendChild(node);
  });

  els.uploadQueue.querySelectorAll("[data-remove-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.queue = state.queue.filter((x) => x.id !== btn.dataset.removeId);
      await persistState();
      renderQueue();
      renderCurrentRunCard();
    });
  });

  els.uploadQueue.querySelectorAll("[data-field]").forEach((field) => {
    field.addEventListener("input", handleQueueEdit);
    field.addEventListener("change", handleQueueEdit);
  });
}

async function handleQueueEdit(event) {
  const { id, field } = event.target.dataset;
  const item = state.queue.find((x) => x.id === id);
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
  renderCurrentRunCard();
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
  } catch {
    notify("Could not copy prompt");
  }
}

async function checkBackend() {
  syncSettingsFromDom();
  setPill(els.backendStatus, "Checking...", "warning");
  try {
    await api("/health", { method: "GET" });
    setPill(els.backendStatus, "Backend ready", "success");
  } catch {
    setPill(els.backendStatus, "Backend offline", "danger");
  }
}

async function uploadCurrentBatch() {
  if (state.uploadInProgress) return;
  syncSettingsFromDom();
  if (!state.queue.length) {
    notify("Add screenshots first");
    return;
  }

  state.uploadInProgress = true;
  setBusy(els.uploadBatchBtn, true, "Uploading...");

  try {
    const startRes = await api("/analyst/upload/start", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        clientName: state.settings.clientName,
        operatorName: state.settings.operatorName
      })
    });

    state.currentRunId = startRes.runId;
    state.selectedReportRunId = startRes.runId;
    state.latestStatus = null;
    state.latestReportPayload = null;
    await persistState();

    let uploadedCount = 0;
    for (const item of state.queue) {
      await api("/analyst/upload/file", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: state.settings.workspaceName,
          runId: state.currentRunId,
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
      els.analysisProgress.classList.remove("empty-state");
      els.analysisProgress.innerHTML = `<div><strong>Upload in progress</strong></div><div class="muted">Run ID: ${escapeHtml(state.currentRunId)}</div><div class="muted">Uploaded ${uploadedCount} of ${state.queue.length} screenshot(s)</div>`;
      await persistState();
      renderQueue();
    }

    await api("/analyst/upload/finish", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        runId: state.currentRunId
      })
    });

    setPill(els.currentRunStatus, "Uploaded", "success");
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `<div><strong>Upload complete</strong></div><div class="muted">Next step: click Done Adding → Analyze Batch</div>`;
    await refreshRunHistory();
    renderCurrentRunCard();
    notify("Batch uploaded. Next: Analyze Batch.");
  } catch (error) {
    setPill(els.analysisStatus, "Upload failed", "danger");
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `<div><strong>Upload failed</strong></div><div class="muted">${escapeHtml(error.message || "Unknown error")}</div>`;
    notify(error.message || "Upload failed");
  } finally {
    state.uploadInProgress = false;
    setBusy(els.uploadBatchBtn, false, "Upload Batch");
  }
}

async function doneAddingAnalyzeBatch() {
  const hasPending = state.queue.some((x) => !x.uploaded);
  if (hasPending || !state.currentRunId) {
    await uploadCurrentBatch();
  }
  if (state.currentRunId) {
    await startAnalysis();
  }
}

async function startAnalysis() {
  if (state.analysisInProgress) return;
  if (!state.currentRunId) {
    notify("Upload a batch first");
    return;
  }

  state.analysisInProgress = true;
  setBusy(els.analyzeBatchBtn, true, "Starting...");
  setPill(els.analysisStatus, "Queued", "warning");

  try {
    await api("/analyst/analyze/start", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        runId: state.currentRunId,
        promptOverride: els.promptOverride.value.trim() || DEFAULT_PROMPT
      })
    });

    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `<div><strong>Analysis started</strong></div><div class="muted">Run ID: ${escapeHtml(state.currentRunId)}</div><div class="muted">We are now extracting values and building the report.</div>`;
    await pollAnalysisStatus();
  } catch (error) {
    setPill(els.analysisStatus, "Failed", "danger");
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `<div><strong>Could not start analysis</strong></div><div class="muted">${escapeHtml(error.message || "Unknown error")}</div>`;
  } finally {
    state.analysisInProgress = false;
    setBusy(els.analyzeBatchBtn, false, "Done Adding → Analyze Batch");
  }
}

async function retryAnalysis() {
  if (!state.currentRunId) {
    notify("Select or create a run first");
    return;
  }
  await startAnalysis();
}

async function refreshAnalysisStatus() {
  if (!state.currentRunId) {
    notify("No run selected");
    return;
  }
  try {
    const payload = await api(statusUrl(state.currentRunId), { method: "GET" });
    state.latestStatus = payload;
    renderAnalysisStatus();
    await refreshRunHistory();
  } catch (error) {
    els.analysisProgress.classList.remove("empty-state");
    els.analysisProgress.innerHTML = `<div><strong>Status refresh failed</strong></div><div class="muted">${escapeHtml(error.message || "Unknown error")}</div>`;
  }
}

async function refreshAnalysisStatusSilently() {
  if (!state.currentRunId) return;
  try {
    state.latestStatus = await api(statusUrl(state.currentRunId), { method: "GET" });
  } catch {}
}

async function pollAnalysisStatus() {
  let keepPolling = true;
  while (keepPolling && state.currentRunId) {
    try {
      state.latestStatus = await api(statusUrl(state.currentRunId), { method: "GET" });
      renderAnalysisStatus();
      const status = state.latestStatus?.status || "";
      if (status === "completed" || status === "failed") {
        keepPolling = false;
        await refreshRunHistory();
        await refreshReportForSelectedRun();
        renderAll();
        break;
      }
    } catch (error) {
      keepPolling = false;
      els.analysisProgress.classList.remove("empty-state");
      els.analysisProgress.innerHTML = `<div><strong>Polling failed</strong></div><div class="muted">${escapeHtml(error.message || "Unknown error")}</div>`;
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function renderAnalysisStatus() {
  if (!state.latestStatus) {
    setPill(els.analysisStatus, "Idle", "muted");
    if (!state.currentRunId) {
      els.analysisProgress.classList.add("empty-state");
      els.analysisProgress.innerHTML = "No analysis started yet.";
    }
    return;
  }

  const s = state.latestStatus;
  const usable = Boolean(s.numericRowCount || s.textRowCount || s.hasSummary);
  const status = s.status || "unknown";
  let tone = "warning";
  if (status === "failed") tone = "danger";
  else if (status === "completed" && usable) tone = "success";
  else if (status === "completed" && !usable) tone = "warning";
  setPill(els.analysisStatus, status === "completed" && !usable ? "Needs review" : capitalize(status), tone);

  const nextStep = status === "completed"
    ? (usable ? "Next step: open Report or Ask." : "No usable data found. Retry analysis or upload a clearer screenshot.")
    : status === "extracting"
    ? "Step in progress: AI is extracting values from the uploaded charts."
    : "Waiting for the backend to continue processing.";

  els.analysisProgress.classList.remove("empty-state");
  els.analysisProgress.innerHTML = `
    <div><strong>Current analysis status</strong></div>
    <div class="badge-row">
      <span class="badge">Run ID: ${escapeHtml(s.runId || state.currentRunId || "")}</span>
      <span class="badge">Numeric rows: ${escapeHtml(String(s.numericRowCount || 0))}</span>
      <span class="badge">Text rows: ${escapeHtml(String(s.textRowCount || 0))}</span>
      <span class="badge">Summary ready: ${s.hasSummary ? "Yes" : "No"}</span>
    </div>
    <div class="muted" style="margin-top:8px;">${escapeHtml(nextStep)}</div>
    ${s.error ? `<div class="muted" style="color:#ffb6b6;margin-top:8px;">Error: ${escapeHtml(s.error)}</div>` : ""}
  `;
}

async function refreshRunHistory() {
  try {
    syncSettingsFromDom();
    const payload = await api(`/analyst/report/history?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&limit=20`, { method: "GET" });
    state.runHistory = payload.items || [];
    if (!state.currentRunId && state.runHistory[0]) state.currentRunId = state.runHistory[0].runId;
    if (!state.selectedReportRunId && state.runHistory[0]) state.selectedReportRunId = state.runHistory[0].runId;
    await persistState();
    renderHistory();
    renderCurrentRunCard();
  } catch (error) {
    state.runHistory = [];
    renderHistory();
  }
}

function renderHistory() {
  if (!state.runHistory.length) {
    els.historyList.classList.add("empty-state");
    els.historyList.innerHTML = "No saved runs yet.";
    return;
  }

  els.historyList.classList.remove("empty-state");
  els.historyList.innerHTML = "";
  state.runHistory.forEach((run) => {
    const node = document.createElement("div");
    node.className = "history-item";
    const time = formatDateTime(run.generatedAt || run.finishedAt || run.createdAt);
    const quality = run.hasUsableData ? "Usable" : "Needs review";
    node.innerHTML = `
      <div class="history-top">
        <div>
          <div class="history-name">${escapeHtml(run.title || run.runId)}</div>
          <div class="history-subtext">Run ${escapeHtml(run.runId)} · ${escapeHtml(time)}</div>
        </div>
        <span class="pill ${run.hasUsableData ? "pill-success" : "pill-warning"}">${escapeHtml(quality)}</span>
      </div>
      <div class="badge-row">
        <span class="badge">Files: ${escapeHtml(String(run.fileCount || 0))}</span>
        <span class="badge">Numeric: ${escapeHtml(String(run.numericRowCount || 0))}</span>
        <span class="badge">Text: ${escapeHtml(String(run.textRowCount || 0))}</span>
      </div>
      <div class="history-actions">
        <button class="btn btn-secondary" data-action="continue" data-run-id="${run.runId}">Use as Current Run</button>
        <button class="btn btn-secondary" data-action="report" data-run-id="${run.runId}">Open in Report</button>
        <button class="btn btn-secondary" data-action="chat" data-run-id="${run.runId}">Use in Chat</button>
        ${run.htmlReportUrl ? `<a class="btn btn-ghost link-btn" href="${escapeAttr(absolutizeBackendPath(run.htmlReportUrl))}" target="_blank" rel="noopener noreferrer">HTML Report</a>` : ""}
      </div>
    `;
    els.historyList.appendChild(node);
  });

  els.historyList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const runId = btn.dataset.runId;
      const action = btn.dataset.action;
      if (action === "continue") {
        state.currentRunId = runId;
        await persistState();
        await refreshAnalysisStatusSilently();
        renderCurrentRunCard();
        renderAnalysisStatus();
        notify("Current run updated");
      } else if (action === "report") {
        state.selectedReportRunId = runId;
        await persistState();
        await refreshReportForSelectedRun();
        setActiveTab("tab-report");
      } else if (action === "chat") {
        state.selectedReportRunId = runId;
        await persistState();
        renderChatArea();
        setActiveTab("tab-ask");
      }
    });
  });
}

function renderCurrentRunCard() {
  const run = state.runHistory.find((x) => x.runId === state.currentRunId) || null;
  if (!run && !state.queue.length) {
    setPill(els.currentRunStatus, "No run", "muted");
    els.currentRunSummary.classList.add("empty-state");
    els.currentRunSummary.innerHTML = "Start a new run, add screenshots, then analyze the batch.";
    return;
  }

  const hasPendingQueue = state.queue.length > 0 && state.queue.some((x) => !x.uploaded);
  const nextStep = hasPendingQueue
    ? "Next step: click Upload Batch, or add another screenshot first."
    : run && run.status !== "completed"
    ? "Next step: click Done Adding → Analyze Batch."
    : run && run.hasUsableData
    ? "Next step: open Report or Ask."
    : run
    ? "Run completed but needs review. Retry analysis or upload clearer screenshots."
    : "Next step: add screenshots.";

  const tone = !run ? "warning" : run.hasUsableData ? "success" : run.status === "completed" ? "warning" : "muted";
  const label = !run ? "Draft" : run.hasUsableData ? "Usable" : capitalize(run.status || "draft");
  setPill(els.currentRunStatus, label, tone);
  els.currentRunSummary.classList.remove("empty-state");
  els.currentRunSummary.innerHTML = `
    <div><strong>${run ? escapeHtml(run.title || run.runId) : "Draft batch"}</strong></div>
    <div class="badge-row">
      ${run ? `<span class="badge">Run ID: ${escapeHtml(run.runId)}</span>` : ""}
      <span class="badge">Queued screenshots: ${escapeHtml(String(state.queue.length))}</span>
      ${run ? `<span class="badge">Generated: ${escapeHtml(formatDateTime(run.generatedAt || run.finishedAt || run.createdAt))}</span>` : ""}
    </div>
    <div class="muted" style="margin-top:8px;">${escapeHtml(nextStep)}</div>
  `;
}

async function useLatestCompletedRun() {
  await refreshRunHistory();
  const latestUsable = state.runHistory.find((x) => x.hasUsableData) || state.runHistory[0];
  if (!latestUsable) {
    notify("No saved runs available");
    return;
  }
  state.selectedReportRunId = latestUsable.runId;
  await persistState();
  await refreshReportForSelectedRun();
  renderChatArea();
  notify("Latest completed run selected");
}

async function refreshReportForSelectedRun() {
  const runId = state.selectedReportRunId || state.currentRunId;
  if (!runId) {
    state.latestReportPayload = null;
    renderReport();
    return;
  }

  try {
    syncSettingsFromDom();
    const payload = await api(`/analyst/report/run?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&runId=${encodeURIComponent(runId)}`, { method: "GET" });
    state.latestReportPayload = payload;
    state.selectedReportRunId = runId;
    await persistState();
  } catch (error) {
    state.latestReportPayload = null;
  }
  renderReport();
}

function renderReport() {
  const payload = state.latestReportPayload;
  if (!payload) {
    setPill(els.reportStatus, "No report", "muted");
    els.reportReference.classList.add("empty-state");
    els.reportReference.innerHTML = "Select a saved run or complete an analysis first.";
    els.reportContainer.classList.add("empty-state");
    els.reportContainer.innerHTML = "No report available yet.";
    els.openReportLink.href = "#";
    return;
  }

  const usable = Boolean(payload.hasUsableData);
  setPill(els.reportStatus, usable ? "Ready" : "Needs review", usable ? "success" : "warning");
  els.reportReference.classList.remove("empty-state");
  els.reportReference.innerHTML = `
    <div><strong>Reference run</strong></div>
    <div class="badge-row">
      <span class="badge">Run ID: ${escapeHtml(payload.runId)}</span>
      <span class="badge">Generated: ${escapeHtml(formatDateTime(payload.generatedAt || payload.finishedAt || payload.createdAt))}</span>
      <span class="badge">Usable data: ${payload.hasUsableData ? "Yes" : "No"}</span>
    </div>
  `;

  const report = payload.report || {};
  const summary = payload.summary || "";
  els.reportContainer.classList.remove("empty-state");
  els.reportContainer.innerHTML = `
    ${!usable ? `<div class="report-section"><h3>No usable data extracted</h3><div class="report-summary">This run completed, but the system did not extract enough usable data. Try retrying analysis or uploading a clearer screenshot/crop.</div></div>` : ""}
    <div class="report-section">
      <h3>${escapeHtml(report.title || "Summary Report")}</h3>
      ${summary ? `<div class="report-summary">${escapeHtml(summary)}</div>` : `<div class="report-summary">No summary available.</div>`}
    </div>
    ${renderListSection("Executive Summary", report.executive_summary)}
    ${renderListSection("Key Findings", report.key_findings)}
    ${renderListSection("Recommendations", report.recommendations)}
    ${renderListSection("Data Quality Notes", report.data_quality_notes)}
  `;

  els.openReportLink.href = payload.htmlReportUrl ? absolutizeBackendPath(payload.htmlReportUrl) : "#";
}

function renderListSection(title, items) {
  const safeItems = Array.isArray(items) ? items : [];
  if (!safeItems.length) return "";
  return `
    <div class="report-section">
      <h3>${escapeHtml(title)}</h3>
      <ul>${safeItems.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>
    </div>
  `;
}

function selectedChatRunId() {
  return state.selectedReportRunId || state.currentRunId || (state.runHistory[0] && state.runHistory[0].runId) || null;
}

function renderChatArea() {
  const runId = selectedChatRunId();
  const run = state.runHistory.find((x) => x.runId === runId) || null;
  const messages = runId ? state.chatByRun[runId] || [] : [];

  if (!run) {
    setPill(els.chatStatus, "No run selected", "muted");
    els.chatReference.classList.add("empty-state");
    els.chatReference.innerHTML = "Chat will automatically use the latest completed run unless you select another saved run.";
    els.chatMessages.classList.add("empty-state");
    els.chatMessages.innerHTML = "Chat will appear here after a usable analysis is available.";
    return;
  }

  const usable = Boolean(run.hasUsableData);
  setPill(els.chatStatus, usable ? "Ready" : "Needs review", usable ? "success" : "warning");
  els.chatReference.classList.remove("empty-state");
  els.chatReference.innerHTML = `
    <div><strong>Chat is referencing this run</strong></div>
    <div class="badge-row">
      <span class="badge">Run ID: ${escapeHtml(run.runId)}</span>
      <span class="badge">Generated: ${escapeHtml(formatDateTime(run.generatedAt || run.finishedAt || run.createdAt))}</span>
      <span class="badge">Usable data: ${run.hasUsableData ? "Yes" : "No"}</span>
    </div>
  `;

  if (!messages.length) {
    els.chatMessages.classList.add("empty-state");
    els.chatMessages.innerHTML = usable
      ? "Ask about this run. The assistant will use the latest extracted dataset for this selected run."
      : "This run has no usable data yet. Retry analysis or select another run.";
    return;
  }

  els.chatMessages.classList.remove("empty-state");
  els.chatMessages.innerHTML = "";
  messages.forEach((message) => {
    const div = document.createElement("div");
    div.className = `chat-message ${message.role}`;
    div.textContent = message.content;
    els.chatMessages.appendChild(div);
  });
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function sendChatMessage() {
  const runId = selectedChatRunId();
  const question = els.chatInput.value.trim();
  if (!question) return;
  if (!runId) {
    notify("No run selected for chat");
    return;
  }

  const run = state.runHistory.find((x) => x.runId === runId);
  if (run && !run.hasUsableData) {
    notify("Selected run has no usable data. Choose another run or retry analysis.");
    return;
  }

  appendChatMessage(runId, "user", question);
  els.chatInput.value = "";
  setBusy(els.sendChatBtn, true, "Sending...");

  try {
    syncSettingsFromDom();
    const messages = state.chatByRun[runId] || [];
    const payload = await api("/analyst/chat", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: state.settings.workspaceName,
        runId,
        messages,
        userQuestion: question
      })
    });

    let answer = payload.answer || payload.message || "No response returned from the backend.";
    if (payload.reference?.generatedAt) {
      answer = `${answer}\n\n[Reference run generated: ${formatDateTime(payload.reference.generatedAt)}]`;
    }
    appendChatMessage(runId, "assistant", answer);
    setPill(els.chatStatus, "Ready", "success");
  } catch (error) {
    appendChatMessage(runId, "assistant", error.message || "Chat failed");
    setPill(els.chatStatus, "Warning", "warning");
  } finally {
    setBusy(els.sendChatBtn, false, "Send");
  }
}

function appendChatMessage(runId, role, content) {
  if (!state.chatByRun[runId]) state.chatByRun[runId] = [];
  state.chatByRun[runId].push({ role, content, createdAt: new Date().toISOString() });
  persistState();
  renderChatArea();
}

async function clearChatForSelectedRun() {
  const runId = selectedChatRunId();
  if (!runId) return;
  state.chatByRun[runId] = [];
  await persistState();
  renderChatArea();
}

async function api(path, options = {}) {
  const baseUrl = sanitizeUrl(state.settings.backendUrl || els.backendUrl.value || "");
  if (!baseUrl) throw new Error("Backend URL is required");

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
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }

  if (!response.ok) {
    throw new Error(payload.error || payload.message || payload.raw || `Request failed (${response.status})`);
  }
  return payload;
}

function statusUrl(runId) {
  return `/analyst/analyze/status?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&runId=${encodeURIComponent(runId)}`;
}

function absolutizeBackendPath(relativeOrAbsolute) {
  if (!relativeOrAbsolute) return "#";
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
  const baseUrl = sanitizeUrl(state.settings.backendUrl || els.backendUrl.value || "");
  if (!baseUrl) return relativeOrAbsolute;
  return relativeOrAbsolute.startsWith("/") ? `${baseUrl}${relativeOrAbsolute}` : `${baseUrl}/${relativeOrAbsolute}`;
}

function setPill(el, text, tone = "muted") {
  el.textContent = text;
  el.className = `pill pill-${tone}`;
}

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function sanitizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function formatDateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
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

function byId(id) {
  return document.getElementById(id);
}
