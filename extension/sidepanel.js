const STORAGE_KEY = "dm_analyst_console_v5";
const POLL_INTERVAL_MS = 3000;

const FILTER_VALUE_OPTIONS = {
  Zone: ["East", "North", "South", "West"],
  NCCS: ["A", "B"],
  Tier: ["Tier 1", "Tier 2", "Tier 3 & lower"],
  Gender: ["Male", "Female"],
  "Age Band": ["Below 18", "18-24", "25-35", "35-44", "45-54", "55+"]
};

const PAGE_OPTIONS = ["Traffic Engagement", "Purchase Matrix", "Purchase Funnel"];

const state = {
  settings: {
    backendUrl: "https://powerbi-demo-backend.onrender.com",
    clientName: ""
  },
  activeTab: "tab-collect",
  queue: [],
  carouselIndex: 0,
  runHistory: [],
  selectedRunId: null,
  latestStatus: null,
  latestReportPayload: null,
  chatByRun: {},
  pollTimer: null,
  analysisInProgress: false
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
  await refreshStatusForSelectedRun(false);
  await refreshReportForSelectedRun(false);
  renderAll();
});

function cacheDom() {
  Object.assign(els, {
    backendStatus: byId("backendStatus"),
    workspaceBadge: byId("workspaceBadge"),
    backendUrl: byId("backendUrl"),
    clientName: byId("clientName"),
    saveSettingsBtn: byId("saveSettingsBtn"),
    checkBackendBtn: byId("checkBackendBtn"),

    runSelector: byId("runSelector"),
    refreshRunsBtn: byId("refreshRunsBtn"),
    selectedRunStatus: byId("selectedRunStatus"),
    selectedRunMeta: byId("selectedRunMeta"),

    queueCount: byId("queueCount"),
    addScreenshotsBtn: byId("addScreenshotsBtn"),
    fileInput: byId("fileInput"),
    clearQueueBtn: byId("clearQueueBtn"),
    analyzeNowBtn: byId("analyzeNowBtn"),
    carouselEmpty: byId("carouselEmpty"),
    carouselPanel: byId("carouselPanel"),
    prevItemBtn: byId("prevItemBtn"),
    nextItemBtn: byId("nextItemBtn"),
    carouselCounter: byId("carouselCounter"),
    carouselCard: byId("carouselCard"),
    carouselThumbs: byId("carouselThumbs"),

    analysisStatus: byId("analysisStatus"),
    analysisProgress: byId("analysisProgress"),
    refreshStatusBtn: byId("refreshStatusBtn"),
    retryAnalysisBtn: byId("retryAnalysisBtn"),

    reportStatus: byId("reportStatus"),
    reportReference: byId("reportReference"),
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
      if (btn.dataset.tab === "tab-report") await refreshReportForSelectedRun(false);
      if (btn.dataset.tab === "tab-ask") renderChatArea();
    });
  });

  els.saveSettingsBtn.addEventListener("click", saveSettingsFromControls);
  els.checkBackendBtn.addEventListener("click", checkBackend);
  els.refreshRunsBtn.addEventListener("click", () => refreshRunHistory(true));
  els.runSelector.addEventListener("change", async () => {
    state.selectedRunId = els.runSelector.value || null;
    await persistState();
    await refreshStatusForSelectedRun(false);
    await refreshReportForSelectedRun(false);
    renderAll();
  });

  els.addScreenshotsBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", handleFilesSelected);
  els.clearQueueBtn.addEventListener("click", clearQueue);
  els.analyzeNowBtn.addEventListener("click", analyzeScreenshots);
  els.prevItemBtn.addEventListener("click", () => moveCarousel(-1));
  els.nextItemBtn.addEventListener("click", () => moveCarousel(1));

  els.refreshStatusBtn.addEventListener("click", () => refreshStatusForSelectedRun(true));
  els.retryAnalysisBtn.addEventListener("click", retryAnalysis);
  els.refreshReportBtn.addEventListener("click", () => refreshReportForSelectedRun(true));

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
  state.selectedRunId = data.selectedRunId || null;
  state.chatByRun = data.chatByRun || {};
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      settings: state.settings,
      activeTab: state.activeTab,
      queue: state.queue,
      carouselIndex: state.carouselIndex,
      selectedRunId: state.selectedRunId,
      chatByRun: state.chatByRun
    }
  });
}

function applyStateToDom() {
  els.backendUrl.value = state.settings.backendUrl;
  els.clientName.value = state.settings.clientName;
  setActiveTab(state.activeTab, false);
  updateWorkspaceBadge();
}

function syncSettingsFromDom() {
  state.settings.backendUrl = sanitizeUrl(els.backendUrl.value);
  state.settings.clientName = els.clientName.value.trim();
}

async function saveSettingsFromControls() {
  syncSettingsFromDom();
  await persistState();
  updateWorkspaceBadge();
  toast("Settings saved");
  await refreshRunHistory(false);
}

function setActiveTab(tabId, persist = true) {
  state.activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabId));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabId));
  if (persist) persistState();
}

function workspaceName() {
  return (state.settings.clientName || "default-workspace").trim() || "default-workspace";
}

function updateWorkspaceBadge() {
  els.workspaceBadge.textContent = state.settings.clientName ? `Client: ${state.settings.clientName}` : "No client selected";
}

function selectedRun() {
  return state.runHistory.find((run) => run.runId === state.selectedRunId) || null;
}

function renderAll() {
  updateWorkspaceBadge();
  renderRunSelector();
  renderSelectedRunCard();
  renderQueue();
  renderAnalysisStatus();
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

async function refreshRunHistory(showToast = false) {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    const data = await apiGet(`/analyst/report/history?workspaceName=${encodeURIComponent(workspaceName())}`);
    state.runHistory = Array.isArray(data.runs) ? data.runs : [];
    if (!state.selectedRunId && state.runHistory.length) state.selectedRunId = state.runHistory[0].runId;
    if (state.selectedRunId && !state.runHistory.find((run) => run.runId === state.selectedRunId)) {
      state.selectedRunId = state.runHistory[0]?.runId || null;
    }
    await persistState();
    renderRunSelector();
    renderSelectedRunCard();
    if (showToast) toast("Runs refreshed");
  } catch (error) {
    toast(error.message || "Failed to refresh runs");
  }
}

function renderRunSelector() {
  const options = state.runHistory.length
    ? state.runHistory.map((run) => `<option value="${escapeAttr(run.runId)}" ${run.runId === state.selectedRunId ? "selected" : ""}>${escapeHtml(formatRunLabel(run))}</option>`).join("")
    : `<option value="">No saved runs</option>`;
  els.runSelector.innerHTML = options;
}

function renderSelectedRunCard() {
  const run = selectedRun();
  if (!run) {
    setPill(els.selectedRunStatus, "No run", "muted");
    els.selectedRunMeta.textContent = "The selected run will be used by Current, Report, and Ask.";
    return;
  }

  const tone = run.status === "completed"
    ? (run.hasUsableData ? "success" : "danger")
    : run.status === "failed"
      ? "danger"
      : ["queued", "extracting", "collecting", "upload_complete", "started"].includes(run.status)
        ? "warning"
        : "muted";
  const label = run.status === "completed"
    ? (run.hasUsableData ? "Ready" : "Needs review")
    : capitalize(run.status || "in progress");
  setPill(els.selectedRunStatus, label, tone);

  els.selectedRunMeta.innerHTML = `
    <div><strong>Date and time:</strong> ${escapeHtml(formatDateTime(run.finishedAt || run.createdAt))}</div>
    <div><strong>Files:</strong> ${Number(run.fileCount || 0)} · <strong>Numeric rows:</strong> ${Number(run.numericRowCount || 0)} · <strong>Text rows:</strong> ${Number(run.textRowCount || 0)}</div>
    <div><strong>Default target:</strong> This selected run is now used for status, report, and chat.</div>
  `;
}

async function handleFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  const readFiles = await Promise.all(files.map(readFileAsDataUrl));
  readFiles.forEach(({ file, dataUrl }) => {
    const inferred = inferTagsFromFilename(file.name);
    state.queue.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name,
      dataUrl,
      page: inferred.page,
      filterType: inferred.filterType,
      filterValue: inferred.filterValue,
      note: ""
    });
  });

  state.carouselIndex = Math.max(0, state.queue.length - readFiles.length);
  els.fileInput.value = "";
  await persistState();
  renderQueue();
  toast(`${readFiles.length} screenshot(s) added`);
}

function inferTagsFromFilename(fileName) {
  const normalized = normalizeFileName(fileName);

  let page = "Traffic Engagement";
  if (/\bpurchase\s+matrix\b/.test(normalized)) page = "Purchase Matrix";
  else if (/\bpurchase\s+funnel\b/.test(normalized)) page = "Purchase Funnel";
  else if (/\btraffic\s+engagement\b/.test(normalized)) page = "Traffic Engagement";

  let filterType = "Zone";
  if (/\bzone\b/.test(normalized)) filterType = "Zone";
  else if (/\bnccs\b/.test(normalized)) filterType = "NCCS";
  else if (/\btier\b/.test(normalized)) filterType = "Tier";
  else if (/\bgender\b/.test(normalized)) filterType = "Gender";
  else if (/\bage\s*band\b/.test(normalized) || /\bage\b/.test(normalized)) filterType = "Age Band";

  return { page, filterType, filterValue: inferFilterValue(normalized, filterType) };
}

function normalizeFileName(fileName) {
  return String(fileName || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferFilterValue(normalized, filterType) {
  if (filterType === "Zone") {
    if (/\beast\b/.test(normalized)) return "East";
    if (/\bnorth\b/.test(normalized)) return "North";
    if (/\bsouth\b/.test(normalized)) return "South";
    if (/\bwest\b/.test(normalized)) return "West";
  }
  if (filterType === "NCCS") {
    if (/\bnccs\s*a\b/.test(normalized)) return "A";
    if (/\bnccs\s*b\b/.test(normalized)) return "B";
  }
  if (filterType === "Tier") {
    if (/\btier\s*1\b/.test(normalized)) return "Tier 1";
    if (/\btier\s*2\b/.test(normalized)) return "Tier 2";
    if (/\btier\s*3\b|\blower\b/.test(normalized)) return "Tier 3 & lower";
  }
  if (filterType === "Gender") {
    if (/\bmale\b/.test(normalized)) return "Male";
    if (/\bfemale\b/.test(normalized)) return "Female";
  }
  if (filterType === "Age Band") {
    if (/\bbelow\s*18\b|\bunder\s*18\b/.test(normalized)) return "Below 18";
    if (/\b18\s*24\b|\b18\s*to\s*24\b|\b18-24\b/.test(normalized)) return "18-24";
    if (/\b25\s*35\b|\b25\s*to\s*35\b|\b25-35\b/.test(normalized)) return "25-35";
    if (/\b35\s*44\b|\b35\s*to\s*44\b|\b35-44\b/.test(normalized)) return "35-44";
    if (/\b45\s*54\b|\b45\s*to\s*54\b|\b45-54\b/.test(normalized)) return "45-54";
    if (/\b55\+\b|\b55\s*plus\b/.test(normalized)) return "55+";
  }
  return FILTER_VALUE_OPTIONS[filterType]?.[0] || "";
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
  els.carouselCard.innerHTML = createQueueCardHtml(item);
  els.carouselThumbs.innerHTML = state.queue.map((queueItem, index) => `
    <button class="thumb ${index === state.carouselIndex ? "active" : ""}" data-queue-index="${index}">
      <div>${escapeHtml(shorten(queueItem.fileName, 18))}</div>
      <div>${escapeHtml(queueItem.filterType)} · ${escapeHtml(queueItem.filterValue)}</div>
    </button>
  `).join("");

  els.carouselCard.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", async (event) => {
      const field = event.target.dataset.field;
      state.queue[state.carouselIndex][field] = event.target.value;
      if (field === "filterType") {
        state.queue[state.carouselIndex].filterValue = FILTER_VALUE_OPTIONS[event.target.value]?.[0] || "";
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
  const pageOptions = PAGE_OPTIONS.map((option) => `<option value="${escapeAttr(option)}" ${option === item.page ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");
  const filterTypeOptions = Object.keys(FILTER_VALUE_OPTIONS).map((option) => `<option value="${escapeAttr(option)}" ${option === item.filterType ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");
  const filterValueOptions = (FILTER_VALUE_OPTIONS[item.filterType] || []).map((option) => `<option value="${escapeAttr(option)}" ${option === item.filterValue ? "selected" : ""}>${escapeHtml(option)}</option>`).join("");

  return `
    <div class="queue-top">
      <div>
        <div class="queue-name">${escapeHtml(item.fileName)}</div>
        <div class="queue-subtext">Tags are auto-filled from the filename. Adjust only if needed.</div>
      </div>
      <button class="btn btn-secondary" data-action="delete-queue-item">Remove</button>
    </div>
    <img class="preview-img" src="${item.dataUrl}" alt="${escapeAttr(item.fileName)}" />
    <div class="queue-grid">
      <label><span>Page</span><select data-field="page">${pageOptions}</select></label>
      <label><span>Filter type</span><select data-field="filterType">${filterTypeOptions}</select></label>
      <label><span>Filter value</span><select data-field="filterValue">${filterValueOptions}</select></label>
    </div>
    <label><span>Note</span><textarea data-field="note" rows="3" placeholder="Optional context for this screenshot">${escapeHtml(item.note || "")}</textarea></label>
  `;
}

async function analyzeScreenshots() {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    if (!state.settings.clientName) throw new Error("Enter the client/platform name first");
    if (!state.queue.length) throw new Error("Add screenshots before analysis");

    const start = await apiPost("/analyst/upload/start", {
      workspaceName: workspaceName(),
      clientName: state.settings.clientName,
      operatorName: ""
    });

    const runId = start.runId;
    state.selectedRunId = runId;
    state.latestStatus = null;
    renderSelectedRunCard();

    for (let i = 0; i < state.queue.length; i += 1) {
      const item = state.queue[i];
      setPill(els.analysisStatus, "Uploading", "warning");
      els.analysisProgress.innerHTML = `
        <div><strong>Actual status:</strong> uploading</div>
        <div><strong>What is happening:</strong> uploading screenshot ${i + 1} of ${state.queue.length}</div>
        <div class="progress-grid">
          <div class="progress-item"><div class="progress-label">Current file</div><div class="progress-value">${escapeHtml(item.fileName)}</div></div>
          <div class="progress-item"><div class="progress-label">Estimated time remaining</div><div class="progress-value">Calculating...</div></div>
        </div>
      `;
      await apiPost("/analyst/upload/file", {
        workspaceName: workspaceName(),
        runId,
        fileName: item.fileName,
        page: item.page,
        filterType: item.filterType,
        filterValue: item.filterValue,
        note: item.note,
        dataUrl: item.dataUrl
      });
    }

    await apiPost("/analyst/upload/finish", { workspaceName: workspaceName(), runId });
    state.queue = [];
    state.carouselIndex = 0;
    await persistState();
    renderQueue();

    await apiPost("/analyst/analyze/start", { workspaceName: workspaceName(), runId });
    await refreshRunHistory(false);
    beginPolling();
    await refreshStatusForSelectedRun(false);
    toast("Analysis started");
  } catch (error) {
    toast(error.message || "Failed to analyze screenshots");
  }
}

async function retryAnalysis() {
  try {
    syncSettingsFromDom();
    await ensureBackendReady();
    if (!state.selectedRunId) throw new Error("Select a run first");
    await apiPost("/analyst/analyze/start", { workspaceName: workspaceName(), runId: state.selectedRunId });
    beginPolling();
    await refreshStatusForSelectedRun(false);
    toast("Analysis retried");
  } catch (error) {
    toast(error.message || "Retry failed");
  }
}

function beginPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    await refreshStatusForSelectedRun(false);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function refreshStatusForSelectedRun(showToast) {
  try {
    if (!state.selectedRunId) {
      state.latestStatus = null;
      state.analysisInProgress = false;
      renderAnalysisStatus();
      return;
    }

    const data = await apiGet(`/analyst/analyze/status?workspaceName=${encodeURIComponent(workspaceName())}&runId=${encodeURIComponent(state.selectedRunId)}`);
    state.latestStatus = data;
    state.analysisInProgress = ["queued", "extracting", "collecting", "upload_complete", "started"].includes(data.status);

    if (state.analysisInProgress) beginPolling();
    else stopPolling();

    await refreshRunHistory(false);
    if (data.status === "completed") await refreshReportForSelectedRun(false);
    renderAll();
    if (showToast) toast(`Status updated: ${data.status}`);
  } catch (error) {
    if (showToast) toast(error.message || "Failed to refresh status");
  }
}

function renderAnalysisStatus() {
  const status = state.latestStatus?.status || "idle";
  const progress = state.latestStatus?.progress || null;
  const label = status === "completed" ? (state.latestStatus?.hasUsableData ? "Ready" : "Needs review") : capitalize(status);
  const tone = status === "completed"
    ? (state.latestStatus?.hasUsableData ? "success" : "danger")
    : status === "failed"
      ? "danger"
      : ["queued", "extracting", "collecting", "upload_complete", "started"].includes(status)
        ? "warning"
        : "muted";
  setPill(els.analysisStatus, label, tone);

  if (!state.selectedRunId) {
    els.analysisProgress.textContent = "No run selected yet.";
    return;
  }
  if (!state.latestStatus) {
    els.analysisProgress.textContent = "No analysis started yet.";
    return;
  }

  const estimated = formatEta(progress?.estimatedSecondsRemaining);
  els.analysisProgress.innerHTML = `
    <div><strong>Actual status:</strong> ${escapeHtml(progress?.phase || status)}</div>
    <div><strong>What is happening:</strong> ${escapeHtml(progress?.message || "Waiting")}</div>
    <div class="progress-grid">
      <div class="progress-item"><div class="progress-label">Estimated time remaining</div><div class="progress-value">${escapeHtml(estimated)}</div></div>
      <div class="progress-item"><div class="progress-label">Current file</div><div class="progress-value">${escapeHtml(progress?.currentFileName || "—")}</div></div>
      <div class="progress-item"><div class="progress-label">File progress</div><div class="progress-value">${escapeHtml(formatRatio(progress?.currentFileIndex, progress?.totalFiles))}</div></div>
      <div class="progress-item"><div class="progress-label">Slice progress</div><div class="progress-value">${escapeHtml(formatRatio(progress?.currentSliceIndex, progress?.totalSlicesForFile))}</div></div>
      <div class="progress-item"><div class="progress-label">Processed slices</div><div class="progress-value">${escapeHtml(formatRatio(progress?.processedSlices, progress?.totalSlices))}</div></div>
      <div class="progress-item"><div class="progress-label">Batch progress</div><div class="progress-value">${escapeHtml(formatRatio(progress?.currentBatchIndex, progress?.totalBatches))}</div></div>
    </div>
    <div style="margin-top:10px;"><strong>Usable data:</strong> ${state.latestStatus.hasUsableData ? "Yes" : "No"} · <strong>Numeric rows:</strong> ${Number(state.latestStatus.numericRowCount || 0)} · <strong>Text rows:</strong> ${Number(state.latestStatus.textRowCount || 0)}</div>
    ${state.latestStatus.error ? `<div style="margin-top:10px;"><strong>Error:</strong> ${escapeHtml(state.latestStatus.error)}</div>` : ""}
  `;
}

async function refreshReportForSelectedRun(showToast) {
  try {
    if (!state.selectedRunId) {
      state.latestReportPayload = null;
      renderReport();
      return;
    }
    const data = await apiGet(`/analyst/report/run?workspaceName=${encodeURIComponent(workspaceName())}&runId=${encodeURIComponent(state.selectedRunId)}`);
    state.latestReportPayload = data?.report || null;
    renderReport();
    if (showToast) toast("Report refreshed");
  } catch (error) {
    state.latestReportPayload = null;
    renderReport();
    if (showToast) toast(error.message || "Failed to load report");
  }
}

function renderReport() {
  const run = selectedRun();
  const report = state.latestReportPayload;

  if (!run) {
    setPill(els.reportStatus, "No report", "muted");
    els.reportReference.textContent = "Select a run to view its report.";
    els.reportContainer.textContent = "No report available yet.";
    els.openReportLink.href = "#";
    return;
  }

  els.reportReference.innerHTML = `
    <div><strong>Date and time:</strong> ${escapeHtml(formatDateTime(run.finishedAt || run.createdAt))}</div>
    <div><strong>Client:</strong> ${escapeHtml(state.settings.clientName || workspaceName())}</div>
  `;

  if (!report) {
    setPill(els.reportStatus, "No report", "muted");
    els.reportContainer.textContent = "No report available yet.";
    els.openReportLink.href = buildUrl(`/analyst/report/html?workspaceName=${encodeURIComponent(workspaceName())}&runId=${encodeURIComponent(run.runId)}`);
    return;
  }

  if (!report.hasUsableData) {
    setPill(els.reportStatus, "Needs review", "danger");
    els.reportContainer.innerHTML = `
      <div class="report-section">
        <h3>Usable-data check failed</h3>
        <div class="report-summary">This run finished technically, but there is not enough extracted data yet to support a reliable report.</div>
      </div>
    `;
    els.openReportLink.href = buildUrl(`/analyst/report/html?workspaceName=${encodeURIComponent(workspaceName())}&runId=${encodeURIComponent(run.runId)}`);
    return;
  }

  setPill(els.reportStatus, "Ready", "success");
  els.openReportLink.href = buildUrl(`/analyst/report/html?workspaceName=${encodeURIComponent(workspaceName())}&runId=${encodeURIComponent(run.runId)}`);
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
  const run = selectedRun();
  const messages = state.chatByRun[state.selectedRunId] || [];

  if (!run) {
    setPill(els.chatStatus, "No run selected", "muted");
    els.chatReference.textContent = "Select a usable run to continue the conversation.";
    els.chatMessages.textContent = "Chat will appear here after a usable analysis is available.";
    return;
  }

  const usable = Boolean(run.hasUsableData);
  setPill(els.chatStatus, usable ? "Ready" : "Blocked", usable ? "success" : "danger");
  els.chatReference.innerHTML = `
    <div><strong>Date and time:</strong> ${escapeHtml(formatDateTime(run.finishedAt || run.createdAt))}</div>
    <div><strong>Client:</strong> ${escapeHtml(state.settings.clientName || workspaceName())}</div>
    <div><strong>Status:</strong> ${escapeHtml(run.status || "unknown")} · <strong>Usable:</strong> ${usable ? "Yes" : "No"}</div>
  `;

  if (!usable) {
    els.chatMessages.innerHTML = `<div class="chat-message assistant"><div class="chat-meta">${escapeHtml(formatDateTime(new Date().toISOString()))}</div><div class="chat-content">This run is blocked for chat because the usable-data check failed. Select another run or retry analysis.</div></div>`;
    return;
  }

  if (!messages.length) {
    els.chatMessages.innerHTML = `<div class="chat-message assistant"><div class="chat-meta">${escapeHtml(formatDateTime(new Date().toISOString()))}</div><div class="chat-content">I’m ready to answer questions about this selected run and continue from the latest saved context.</div></div>`;
    return;
  }

  els.chatMessages.innerHTML = messages.map((message) => `
    <div class="chat-message ${message.role === "user" ? "user" : "assistant"}">
      <div class="chat-meta">${escapeHtml(formatDateTime(message.createdAt))}</div>
      <div class="chat-content">${escapeHtml(message.content)}</div>
    </div>
  `).join("");
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function sendChatMessage() {
  try {
    const question = els.chatInput.value.trim();
    if (!question) throw new Error("Type a question first");
    const run = selectedRun();
    if (!run) throw new Error("Select a run first");
    if (!run.hasUsableData) throw new Error("Selected run failed the usable-data check");

    const messages = state.chatByRun[run.runId] || [];
    messages.push({ role: "user", content: question, createdAt: new Date().toISOString() });
    state.chatByRun[run.runId] = messages;
    els.chatInput.value = "";
    await persistState();
    renderChatArea();

    const data = await apiPost("/analyst/chat", {
      workspaceName: workspaceName(),
      runId: run.runId,
      question
    });

    state.chatByRun[run.runId].push({
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
  const run = selectedRun();
  if (!run) return;
  state.chatByRun[run.runId] = [];
  persistState();
  renderChatArea();
}

function buildUrl(path) {
  return `${state.settings.backendUrl}${path}`;
}

async function ensureBackendReady() {
  if (!state.settings.backendUrl) throw new Error("Set the backend URL first");
}

function sanitizeUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
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

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatRunLabel(run) {
  const dt = formatDateTime(run.finishedAt || run.createdAt);
  const suffix = run.status === "completed" ? (run.hasUsableData ? "Ready" : "Needs review") : capitalize(run.status || "In progress");
  return `${dt} · ${suffix}`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "Calculating...";
  const value = Math.max(0, Number(seconds));
  if (value === 0) return "0 sec";
  if (value < 60) return `${Math.round(value)} sec`;
  const minutes = Math.floor(value / 60);
  const remainder = Math.round(value % 60);
  return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
}

function formatRatio(current, total) {
  if (!total) return "—";
  return `${Number(current || 0)} of ${Number(total || 0)}`;
}

function toast(message) {
  console.log(message);
}

function setPill(element, label, tone) {
  element.textContent = label;
  element.className = `pill pill-${tone}`;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
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
