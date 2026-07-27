const STORAGE_KEY = "dm_analyst_console_v3";
const POLL_INTERVAL_MS = 3000;

const DEFAULT_PROMPT = `Analyze these tagged dashboard screenshots.

Important: the backend will slice tall screenshots into smaller chart blocks automatically.
Treat each slice as part of the same original screenshot.

For each visible chart block:
- identify numerical values directly from labels when visible
- if exact values are not printed, estimate them from axis scale, segment height, total bar height, and legend colors
- keep page, filter type, filter value, and source file metadata attached
- note uncertainty clearly instead of inventing precision
- avoid duplicate extraction if overlapping slices show the same chart

Then produce:
1. a structured extracted dataset
2. a concise executive summary
3. key findings
4. recommendations
5. data-quality notes`.trim();

const FILTER_VALUE_OPTIONS = {
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
  carouselIndex: 0,
  currentRunId: null,
  selectedReportRunId: null,
  selectedChatRunId: null,
  latestStatus: null,
  latestReportPayload: null,
  runHistory: [],
  chatByRun: {},
  uploadInProgress: false,
  analysisInProgress: false,
  pollTimer: null
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
  autoPickRunReferences();
  await refreshAnalysisStatusSilently();
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
    clearQueueBtn: byId("clearQueueBtn"),
    uploadBatchBtn: byId("uploadBatchBtn"),
    analyzeBatchBtn: byId("analyzeBatchBtn"),
    carouselEmpty: byId("carouselEmpty"),
    carouselPanel: byId("carouselPanel"),
    prevItemBtn: byId("prevItemBtn"),
    nextItemBtn: byId("nextItemBtn"),
    carouselCounter: byId("carouselCounter"),
    carouselCard: byId("carouselCard"),
    carouselThumbs: byId("carouselThumbs"),

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
    toast("Settings saved");
  });

  els.checkBackendBtn.addEventListener("click", checkBackend);
  els.startNewRunBtn.addEventListener("click", startNewRun);
  els.continueLatestBtn.addEventListener("click", continueLatestRun);
  els.addScreenshotsBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", handleFilesSelected);
  els.clearQueueBtn.addEventListener("click", clearQueue);
  els.uploadBatchBtn.addEventListener("click", uploadCurrentBatch);
  els.analyzeBatchBtn.addEventListener("click", doneAddingAnalyzeBatch);
  els.prevItemBtn.addEventListener("click", () => moveCarousel(-1));
  els.nextItemBtn.addEventListener("click", () => moveCarousel(1));

  els.defaultPage.addEventListener("change", saveSettingsFromControls);
  els.defaultFilterType.addEventListener("change", saveSettingsFromControls);
  els.promptOverride.addEventListener("change", saveSettingsFromControls);

  els.togglePromptBtn.addEventListener("click", togglePromptArea);
  els.resetPromptBtn.addEventListener("click", resetPrompt);
  els.copyPromptBtn.addEventListener("click", copyPrompt);

  els.refreshStatusBtn.addEventListener("click", refreshAnalysisStatus);
  els.retryAnalysisBtn.addEventListener("click", retryAnalysis);
  els.refreshHistoryBtn.addEventListener("click", refreshRunHistory);

  els.useLatestReportBtn.addEventListener("click", async () => {
    autoPickRunReferences(true);
    await refreshReportForSelectedRun();
    renderAll();
  });
  els.refreshReportBtn.addEventListener("click", refreshReportForSelectedRun);

  els.sendChatBtn.addEventListener("click", sendChatMessage);
  els.clearChatBtn.addEventListener("click", clearChatForSelectedRun);
  els.chatInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") sendChatMessage();
  });
}

async function loadState() {
  const saved = await chrome.storage.local.get([STORAGE_KEY]);
  const data = saved?.[STORAGE_KEY];
  if (!data) return;
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.activeTab = data.activeTab || state.activeTab;
  state.queue = Array.isArray(data.queue) ? data.queue : [];
  state.carouselIndex = Number.isFinite(data.carouselIndex) ? data.carouselIndex : 0;
  state.currentRunId = data.currentRunId || null;
  state.selectedReportRunId = data.selectedReportRunId || null;
  state.selectedChatRunId = data.selectedChatRunId || null;
  state.chatByRun = data.chatByRun || {};
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      settings: state.settings,
      activeTab: state.activeTab,
      queue: state.queue,
      carouselIndex: state.carouselIndex,
      currentRunId: state.currentRunId,
      selectedReportRunId: state.selectedReportRunId,
      selectedChatRunId: state.selectedChatRunId,
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

async function checkBackend() {
  try {
    syncSettingsFromDom();
    if (!state.settings.backendUrl) throw new Error("Missing backend URL");
    setPill(els.backendStatus, "Checking...", "muted");
    const data = await apiGet("/health");
    if (!data?.ok) throw new Error("Backend did not return ok=true");
    setPill(els.backendStatus, "Backend connected", "success");
    await persistState();
  } catch (error) {
    setPill(els.backendStatus, "Backend offline", "danger");
    toast(error.message || "Backend check failed");
  }
}

async function startNewRun() {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    const data = await apiPost("/analyst/upload/start", {
      workspaceName: state.settings.workspaceName,
      clientName: state.settings.clientName,
      operatorName: state.settings.operatorName
    });
    state.currentRunId = data.runId;
    state.selectedReportRunId = data.runId;
    state.selectedChatRunId = data.runId;
    state.latestStatus = null;
    state.latestReportPayload = null;
    state.queue = [];
    state.carouselIndex = 0;
    await persistState();
    renderAll();
    toast(`Run started: ${data.runId}`);
    await refreshRunHistory();
  } catch (error) {
    toast(error.message || "Failed to start new run");
  }
}

async function continueLatestRun() {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    const data = await apiGet(`/analyst/upload/latest?workspaceName=${encodeURIComponent(state.settings.workspaceName)}`);
    if (!data?.latest?.runId) throw new Error("No latest run found for this workspace");
    state.currentRunId = data.latest.runId;
    state.selectedReportRunId = data.latest.runId;
    state.selectedChatRunId = data.latest.runId;
    await persistState();
    await refreshAnalysisStatusSilently();
    await refreshReportForSelectedRun();
    renderAll();
    toast(`Using latest run: ${data.latest.runId}`);
  } catch (error) {
    toast(error.message || "Failed to load latest run");
  }
}

async function handleFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const readFiles = await Promise.all(files.map(readFileAsDataUrl));
  const defaults = {
    page: state.settings.defaultPage,
    filterType: state.settings.defaultFilterType
  };

  readFiles.forEach(({ file, dataUrl }) => {
    const inferred = inferTagsFromFilename(file.name, defaults.filterType);
    state.queue.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name,
      dataUrl,
      page: inferred.page || defaults.page,
      filterType: inferred.filterType || defaults.filterType,
      filterValue: inferred.filterValue || firstFilterValue(defaults.filterType),
      note: ""
    });
  });

  state.carouselIndex = Math.max(0, state.queue.length - readFiles.length);
  els.fileInput.value = "";
  await persistState();
  renderQueue();
  toast(`${readFiles.length} screenshot(s) added`);
}

function clearQueue() {
  state.queue = [];
  state.carouselIndex = 0;
  persistState();
  renderQueue();
}

function moveCarousel(direction) {
  if (!state.queue.length) return;
  state.carouselIndex = (state.carouselIndex + direction + state.queue.length) % state.queue.length;
  persistState();
  renderQueue();
}

function renderQueue() {
  els.queueCount.textContent = `${state.queue.length} file${state.queue.length === 1 ? "" : "s"}`;

  if (!state.queue.length) {
    els.carouselEmpty.classList.remove("hidden");
    els.carouselPanel.classList.add("hidden");
    els.carouselCard.innerHTML = "";
    els.carouselThumbs.innerHTML = "";
    return;
  }

  els.carouselEmpty.classList.add("hidden");
  els.carouselPanel.classList.remove("hidden");
  state.carouselIndex = clamp(state.carouselIndex, 0, state.queue.length - 1);

  const item = state.queue[state.carouselIndex];
  els.carouselCounter.textContent = `${state.carouselIndex + 1} of ${state.queue.length}`;
  els.carouselCard.innerHTML = createQueueCardHtml(item, state.carouselIndex);
  els.carouselThumbs.innerHTML = state.queue.map((queueItem, index) => `
    <button class="thumb ${index === state.carouselIndex ? "active" : ""}" data-queue-index="${index}">
      <div>${escapeHtml(shorten(queueItem.fileName, 18))}</div>
      <div>${escapeHtml(queueItem.filterValue || "Unlabeled")}</div>
    </button>
  `).join("");

  els.carouselCard.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", async (event) => {
      const field = event.target.dataset.field;
      const value = event.target.value;
      state.queue[state.carouselIndex][field] = value;
      if (field === "filterType") {
        state.queue[state.carouselIndex].filterValue = firstFilterValue(value);
      }
      await persistState();
      renderQueue();
    });
  });

  const deleteBtn = els.carouselCard.querySelector("[data-action='delete-queue-item']");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      state.queue.splice(state.carouselIndex, 1);
      state.carouselIndex = clamp(state.carouselIndex, 0, Math.max(0, state.queue.length - 1));
      await persistState();
      renderQueue();
    });
  }

  els.carouselThumbs.querySelectorAll("[data-queue-index]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.carouselIndex = Number(btn.dataset.queueIndex);
      await persistState();
      renderQueue();
    });
  });
}

function createQueueCardHtml(item) {
  const filterTypeOptions = Object.keys(FILTER_VALUE_OPTIONS).map((option) => `<option value="${escapeAttr(option)}" ${option === item.filterType ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");
  const filterValueOptions = (FILTER_VALUE_OPTIONS[item.filterType] || []).map((option) => `<option value="${escapeAttr(option)}" ${option === item.filterValue ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");
  const pageOptions = ["Traffic Engagement", "Purchase Matrix", "Purchase Funnel"].map((option) => `<option value="${escapeAttr(option)}" ${option === item.page ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");

  return `
    <div class="queue-top">
      <div>
        <div class="queue-name">${escapeHtml(item.fileName)}</div>
        <div class="queue-subtext">Review this screenshot, confirm tags, then move to the next one.</div>
      </div>
      <button class="btn btn-secondary" data-action="delete-queue-item">Remove</button>
    </div>
    <img class="preview-img" src="${item.dataUrl}" alt="${escapeAttr(item.fileName)}" />
    <div class="queue-grid">
      <label><span>Page</span><select data-field="page">${pageOptions}</select></label>
      <label><span>Filter type</span><select data-field="filterType">${filterTypeOptions}</select></label>
      <label><span>Filter value</span><select data-field="filterValue">${filterValueOptions}</select></label>
    </div>
    <label><span>Note</span><textarea data-field="note" rows="3" placeholder="Optional note about what this screenshot contains">${escapeHtml(item.note || "")}</textarea></label>
  `;
}

async function uploadCurrentBatch() {
  try {
    if (!state.queue.length) throw new Error("Add screenshots before uploading");
    syncSettingsFromDom();
    await ensureBackendReady();
    if (!state.currentRunId) {
      const start = await apiPost("/analyst/upload/start", {
        workspaceName: state.settings.workspaceName,
        clientName: state.settings.clientName,
        operatorName: state.settings.operatorName
      });
      state.currentRunId = start.runId;
    }

    state.uploadInProgress = true;
    renderCurrentRunCard();

    for (let i = 0; i < state.queue.length; i += 1) {
      const item = state.queue[i];
      els.currentRunSummary.innerHTML = `Uploading ${i + 1} of ${state.queue.length}: <strong>${escapeHtml(item.fileName)}</strong>`;
      await apiPost("/analyst/upload/file", {
        workspaceName: state.settings.workspaceName,
        runId: state.currentRunId,
        fileName: item.fileName,
        page: item.page,
        filterType: item.filterType,
        filterValue: item.filterValue,
        note: item.note,
        dataUrl: item.dataUrl
      });
    }

    await apiPost("/analyst/upload/finish", {
      workspaceName: state.settings.workspaceName,
      runId: state.currentRunId
    });

    state.queue = [];
    state.carouselIndex = 0;
    await persistState();
    await refreshRunHistory();
    renderAll();
    toast("Batch uploaded successfully");
  } catch (error) {
    toast(error.message || "Batch upload failed");
  } finally {
    state.uploadInProgress = false;
    renderCurrentRunCard();
    renderQueue();
  }
}

async function doneAddingAnalyzeBatch() {
  try {
    if (state.queue.length) await uploadCurrentBatch();
    if (!state.currentRunId) throw new Error("Start or continue a run first");
    syncSettingsFromDom();
    const data = await apiPost("/analyst/analyze/start", {
      workspaceName: state.settings.workspaceName,
      runId: state.currentRunId,
      promptOverride: state.settings.promptOverride
    });
    state.analysisInProgress = true;
    state.latestStatus = data;
    await persistState();
    renderAnalysisStatus();
    beginPolling();
    toast("Analysis started");
  } catch (error) {
    toast(error.message || "Failed to start analysis");
  }
}

function beginPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    await refreshAnalysisStatusSilently();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function refreshAnalysisStatus() {
  await refreshAnalysisStatusSilently(true);
}

async function refreshAnalysisStatusSilently(showToast = false) {
  try {
    if (!state.currentRunId) return;
    const data = await apiGet(`/analyst/analyze/status?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&runId=${encodeURIComponent(state.currentRunId)}`);
    state.latestStatus = data;
    state.analysisInProgress = ["queued", "extracting"].includes(data.status);
    if (!state.analysisInProgress) stopPolling();
    if (data.status === "completed") {
      await refreshRunHistory();
      if (data.hasUsableData) {
        state.selectedReportRunId = state.currentRunId;
        state.selectedChatRunId = state.currentRunId;
        await refreshReportForSelectedRun();
      }
    }
    await persistState();
    renderAnalysisStatus();
    renderCurrentRunCard();
    renderHistory();
    if (showToast) toast(`Status: ${data.status}`);
  } catch (error) {
    if (showToast) toast(error.message || "Failed to refresh status");
  }
}

async function retryAnalysis() {
  if (!state.currentRunId) return toast("No current run selected");
  await doneAddingAnalyzeBatch();
}

function renderCurrentRunCard() {
  const runId = state.currentRunId || "No run";
  let label = "No run";
  let tone = "muted";
  if (state.uploadInProgress) {
    label = "Uploading";
    tone = "warning";
  } else if (state.analysisInProgress) {
    label = "Analyzing";
    tone = "warning";
  } else if (state.latestStatus?.status === "completed" && state.latestStatus?.hasUsableData) {
    label = "Ready";
    tone = "success";
  } else if (state.latestStatus?.status === "completed" && !state.latestStatus?.hasUsableData) {
    label = "Needs review";
    tone = "danger";
  } else if (state.latestStatus?.status === "failed") {
    label = "Failed";
    tone = "danger";
  } else if (state.currentRunId) {
    label = "In progress";
    tone = "muted";
  }
  setPill(els.currentRunStatus, label, tone);

  const latestCompleted = latestCompletedRun();
  els.currentRunSummary.innerHTML = `
    <div><strong>Run ID:</strong> ${escapeHtml(runId)}</div>
    <div><strong>Workspace:</strong> ${escapeHtml(state.settings.workspaceName)}</div>
    <div><strong>Latest completed usable run:</strong> ${escapeHtml(latestCompleted ? `${latestCompleted.runId} · ${formatDateTime(latestCompleted.finishedAt || latestCompleted.createdAt)}` : "None yet")}</div>
  `;
}

function renderAnalysisStatus() {
  const status = state.latestStatus?.status || "idle";
  const label = status === "completed"
    ? (state.latestStatus?.hasUsableData ? "Usable" : "Needs review")
    : status.charAt(0).toUpperCase() + status.slice(1);
  const tone = status === "completed"
    ? (state.latestStatus?.hasUsableData ? "success" : "danger")
    : status === "failed" ? "danger" : ["queued", "extracting"].includes(status) ? "warning" : "muted";
  setPill(els.analysisStatus, label, tone);

  if (!state.latestStatus) {
    els.analysisProgress.textContent = "No analysis started yet.";
    return;
  }

  const blocks = [
    `<div><strong>Status:</strong> ${escapeHtml(state.latestStatus.status || "unknown")}</div>`,
    `<div><strong>Numeric rows:</strong> ${Number(state.latestStatus.numericRowCount || 0)}</div>`,
    `<div><strong>Text rows:</strong> ${Number(state.latestStatus.textRowCount || 0)}</div>`,
    `<div><strong>Has usable data:</strong> ${state.latestStatus.hasUsableData ? "Yes" : "No"}</div>`
  ];
  if (state.latestStatus.error) blocks.push(`<div><strong>Error:</strong> ${escapeHtml(state.latestStatus.error)}</div>`);
  if (state.latestStatus.status === "completed" && !state.latestStatus.hasUsableData) {
    blocks.push(`<div><strong>Hard check:</strong> The run finished technically, but report/chat are blocked because no usable extracted data was found. Retry after improving screenshot clarity or slicing settings.</div>`);
  }
  els.analysisProgress.innerHTML = blocks.join("");
}

async function refreshRunHistory() {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    const data = await apiGet(`/analyst/report/history?workspaceName=${encodeURIComponent(state.settings.workspaceName)}`);
    state.runHistory = Array.isArray(data.runs) ? data.runs : [];
    autoPickRunReferences();
    await persistState();
    renderHistory();
  } catch (error) {
    els.historyList.textContent = error.message || "Failed to load run history";
  }
}

function renderHistory() {
  if (!state.runHistory.length) {
    els.historyList.textContent = "No saved runs yet.";
    return;
  }

  els.historyList.innerHTML = state.runHistory.map((run) => {
    const statusTone = run.status === "completed" ? (run.hasUsableData ? "success" : "danger") : run.status === "failed" ? "danger" : "warning";
    return `
      <div class="history-item">
        <div class="history-top">
          <div>
            <div class="history-name">${escapeHtml(run.runId)}</div>
            <div class="history-subtext">Created ${escapeHtml(formatDateTime(run.createdAt))}</div>
          </div>
          <span class="pill pill-${statusTone}">${escapeHtml(run.status)}</span>
        </div>
        <div class="badge-row">
          <span class="badge">Files: ${Number(run.fileCount || 0)}</span>
          <span class="badge">Numeric: ${Number(run.numericRowCount || 0)}</span>
          <span class="badge">Text: ${Number(run.textRowCount || 0)}</span>
          <span class="badge">Usable: ${run.hasUsableData ? "Yes" : "No"}</span>
        </div>
        <div class="history-actions">
          <button class="btn btn-secondary" data-action="use-run" data-run-id="${escapeAttr(run.runId)}">Use as Current</button>
          <button class="btn btn-secondary" data-action="use-report" data-run-id="${escapeAttr(run.runId)}">Use in Report</button>
          <button class="btn btn-secondary" data-action="use-chat" data-run-id="${escapeAttr(run.runId)}">Use in Chat</button>
        </div>
      </div>
    `;
  }).join("");

  els.historyList.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const runId = button.dataset.runId;
      const action = button.dataset.action;
      if (action === "use-run") state.currentRunId = runId;
      if (action === "use-report") state.selectedReportRunId = runId;
      if (action === "use-chat") state.selectedChatRunId = runId;
      await persistState();
      if (action === "use-run") await refreshAnalysisStatusSilently();
      if (action === "use-report") await refreshReportForSelectedRun();
      renderAll();
    });
  });
}

function autoPickRunReferences(force = false) {
  const usable = state.runHistory.find((run) => run.status === "completed" && run.hasUsableData);
  const latest = state.runHistory[0] || null;
  if (force || !state.currentRunId) state.currentRunId = usable?.runId || latest?.runId || null;
  if (force || !state.selectedReportRunId) state.selectedReportRunId = usable?.runId || latest?.runId || null;
  if (force || !state.selectedChatRunId) state.selectedChatRunId = usable?.runId || latest?.runId || null;
}

function latestCompletedRun() {
  return state.runHistory.find((run) => run.status === "completed" && run.hasUsableData) || null;
}

async function refreshReportForSelectedRun() {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    const runId = state.selectedReportRunId || latestCompletedRun()?.runId;
    if (!runId) {
      state.latestReportPayload = null;
      renderReport();
      return;
    }
    const data = await apiGet(`/analyst/report/run?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&runId=${encodeURIComponent(runId)}`);
    state.latestReportPayload = data?.report || null;
    state.selectedReportRunId = runId;
    await persistState();
    renderReport();
  } catch (error) {
    state.latestReportPayload = null;
    els.reportContainer.textContent = error.message || "Failed to load report";
  }
}

function renderReport() {
  const report = state.latestReportPayload;
  const reportRunId = state.selectedReportRunId || "No run selected";
  els.reportReference.innerHTML = `<div><strong>Run:</strong> ${escapeHtml(reportRunId)}</div>`;

  if (!report) {
    setPill(els.reportStatus, "No report", "muted");
    els.reportContainer.textContent = "No report available yet.";
    els.openReportLink.href = "#";
    return;
  }

  if (!report.hasUsableData) {
    setPill(els.reportStatus, "Needs review", "danger");
    els.reportContainer.innerHTML = `
      <div class="report-section">
        <h3>Hard usable-data check</h3>
        <p class="report-summary">This run finished, but report display is intentionally blocked because the extracted output contains no usable numeric rows, text rows, or summary.</p>
      </div>
    `;
    els.openReportLink.href = buildUrl(`/analyst/report/html?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&runId=${encodeURIComponent(reportRunId)}`);
    return;
  }

  setPill(els.reportStatus, "Ready", "success");
  els.reportReference.innerHTML = `
    <div><strong>Run:</strong> ${escapeHtml(report.runId)}</div>
    <div><strong>Created:</strong> ${escapeHtml(formatDateTime(report.createdAt))}</div>
    <div><strong>Numeric rows:</strong> ${Number(report.numericRowCount || 0)} · <strong>Text rows:</strong> ${Number(report.textRowCount || 0)}</div>
  `;
  els.openReportLink.href = buildUrl(`/analyst/report/html?workspaceName=${encodeURIComponent(state.settings.workspaceName)}&runId=${encodeURIComponent(report.runId)}`);
  els.reportContainer.innerHTML = `
    <div class="report-section"><h3>${escapeHtml(report.report?.title || "Analyst Report")}</h3><div class="report-summary">${escapeHtml(report.summary || "")}</div></div>
    ${renderListSection("Executive Summary", report.report?.executive_summary || [])}
    ${renderListSection("Key Findings", report.report?.key_findings || [])}
    ${renderListSection("Recommendations", report.report?.recommendations || [])}
    ${renderListSection("Data Quality Notes", report.report?.data_quality_notes || [])}
  `;
}

function renderListSection(title, items) {
  return `
    <div class="report-section">
      <h3>${escapeHtml(title)}</h3>
      ${items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>` : `<div class="muted">No items</div>`}
    </div>
  `;
}

function renderChatArea() {
  const selectedRunId = state.selectedChatRunId || latestCompletedRun()?.runId;
  const run = state.runHistory.find((item) => item.runId === selectedRunId) || null;
  const messages = state.chatByRun[selectedRunId] || [];

  if (!selectedRunId) {
    setPill(els.chatStatus, "No run selected", "muted");
    els.chatReference.textContent = "Chat will automatically use the latest completed run unless you select another saved run.";
    els.chatMessages.textContent = "Chat will appear here after a usable analysis is available.";
    return;
  }

  const usable = Boolean(run?.hasUsableData);
  setPill(els.chatStatus, usable ? "Ready" : "Blocked", usable ? "success" : "danger");
  els.chatReference.innerHTML = `
    <div><strong>Run:</strong> ${escapeHtml(selectedRunId)}</div>
    <div><strong>Timestamp:</strong> ${escapeHtml(formatDateTime(run?.finishedAt || run?.createdAt))}</div>
    <div><strong>Status:</strong> ${escapeHtml(run?.status || "unknown")} · <strong>Usable:</strong> ${usable ? "Yes" : "No"}</div>
  `;

  if (!usable) {
    els.chatMessages.innerHTML = `<div class="chat-message assistant">This run is blocked for chat because the usable-data check failed. Choose a different run or re-run analysis.</div>`;
    return;
  }

  if (!messages.length) {
    els.chatMessages.innerHTML = `<div class="chat-message assistant">Ask about trends, app comparisons, low-confidence estimates, or summary conclusions for this run.</div>`;
    return;
  }

  els.chatMessages.innerHTML = messages.map((message) => `
    <div class="chat-message ${message.role === "user" ? "user" : "assistant"}">${escapeHtml(message.content)}</div>
  `).join("");
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function sendChatMessage() {
  try {
    const question = els.chatInput.value.trim();
    if (!question) throw new Error("Type a question first");
    const runId = state.selectedChatRunId || latestCompletedRun()?.runId;
    if (!runId) throw new Error("No usable run selected for chat");
    const run = state.runHistory.find((item) => item.runId === runId);
    if (!run?.hasUsableData) throw new Error("Selected run failed the usable-data check");

    const messages = state.chatByRun[runId] || [];
    messages.push({ role: "user", content: question, createdAt: new Date().toISOString() });
    state.chatByRun[runId] = messages;
    els.chatInput.value = "";
    await persistState();
    renderChatArea();

    const data = await apiPost("/analyst/chat", {
      workspaceName: state.settings.workspaceName,
      runId,
      question
    });

    state.chatByRun[runId].push({
      role: "assistant",
      content: data.answer || "No answer returned.",
      createdAt: new Date().toISOString()
    });
    await persistState();
    renderChatArea();
  } catch (error) {
    toast(error.message || "Chat failed");
  }
}

function clearChatForSelectedRun() {
  const runId = state.selectedChatRunId || latestCompletedRun()?.runId;
  if (!runId) return;
  state.chatByRun[runId] = [];
  persistState();
  renderChatArea();
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
  toast("Prompt reset");
}

async function copyPrompt() {
  await navigator.clipboard.writeText(els.promptOverride.value || DEFAULT_PROMPT);
  toast("Prompt copied");
}

async function ensureBackendReady() {
  if (!state.settings.backendUrl) throw new Error("Set the backend URL first");
}

function sanitizeUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function buildUrl(path) {
  return `${state.settings.backendUrl}${path}`;
}

async function apiGet(path) {
  const response = await fetch(buildUrl(path));
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `GET failed: ${path}`);
  return data;
}

async function apiPost(path, body) {
  const response = await fetch(buildUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || data.error || `POST failed: ${path}`);
  return data;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ file, dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function inferTagsFromFilename(fileName, defaultFilterType) {
  const raw = String(fileName || "").toLowerCase();
  let page = raw.includes("purchase") ? "Purchase Matrix" : raw.includes("traffic") ? "Traffic Engagement" : "Traffic Engagement";
  let filterType = defaultFilterType;
  if (raw.includes("zone")) filterType = "Zone";
  if (raw.includes("nccs")) filterType = "NCCS";
  if (raw.includes("tier")) filterType = "Tier";
  if (raw.includes("gender")) filterType = "Gender";
  if (raw.includes("age")) filterType = "Age Band";

  const options = FILTER_VALUE_OPTIONS[filterType] || [];
  const matched = options.find((option) => raw.includes(option.toLowerCase().replace(/\s+/g, " ").replace(" & ", " ")) || raw.includes(option.toLowerCase().replace(/\s+/g, "_")) || raw.includes(option.toLowerCase().replace(/\s+/g, "-")));
  return { page, filterType, filterValue: matched || firstFilterValue(filterType) };
}

function firstFilterValue(filterType) {
  return (FILTER_VALUE_OPTIONS[filterType] || [""])[0] || "";
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function setPill(element, label, tone) {
  element.textContent = label;
  element.className = `pill pill-${tone}`;
}

function toast(message) {
  console.log(message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shorten(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
  return escapeHtml(value);
}

function byId(id) {
  return document.getElementById(id);
}
