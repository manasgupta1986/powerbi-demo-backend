const PAGE_OPTIONS = [
  "Traffic Engagement",
  "Purchase Matrix",
  "Purchase Funnel"
];

const FILTER_CONFIG = [
  { filterName: "Zone", allLabel: "Select All", options: ["East", "North", "South", "West"] },
  { filterName: "NCCS", allLabel: "Select All", options: ["A", "B"] },
  { filterName: "Tier", allLabel: "Select All", options: ["Tier 1", "Tier 2", "Tier 3 & lower"] },
  { filterName: "Gender", allLabel: "Select All", options: ["Male", "Female"] },
  { filterName: "Age Band", allLabel: "Select All", options: ["Below 18", "18-24", "25-35", "35-44", "45-54", "55+"] }
];

const FILTER_MAP = Object.fromEntries(FILTER_CONFIG.map(x => [x.filterName, x]));

const STORAGE_KEYS = {
  settings: "pb_guided_settings_v1",
  activeRun: "pb_guided_active_run_v1",
  statusLog: "pb_guided_status_log_v1",
  chatHistory: "pb_guided_chat_history_v1",
  manualDraft: "pb_guided_manual_draft_v1"
};

const els = {};
let refreshTimer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheEls();
  bindPanelTabs();
  renderSelectionLists();
  renderManualFallbackOptions();
  bindEvents();
  await loadSavedState();
  await renderFromStorage();
  refreshTimer = setInterval(renderFromStorage, 1200);
}

function cacheEls() {
  els.clientName = document.getElementById("clientName");
  els.dashboardUrl = document.getElementById("dashboardUrl");
  els.backendUrl = document.getElementById("backendUrl");
  els.saveSettingsBtn = document.getElementById("saveSettingsBtn");

  els.tabSelection = document.getElementById("tabSelection");
  els.filterSelection = document.getElementById("filterSelection");
  els.includeBaseline = document.getElementById("includeBaseline");
  els.startGuidedRunBtn = document.getElementById("startGuidedRunBtn");
  els.finishRunBtn = document.getElementById("finishRunBtn");
  els.loadLatestRunBtn = document.getElementById("loadLatestRunBtn");
  els.openLatestReportBtn = document.getElementById("openLatestReportBtn");

  els.runBadge = document.getElementById("runBadge");
  els.currentStepBox = document.getElementById("currentStepBox");
  els.doneCaptureBtn = document.getElementById("doneCaptureBtn");
  els.skipStepBtn = document.getElementById("skipStepBtn");
  els.retryStepBtn = document.getElementById("retryStepBtn");
  els.pauseRunBtn = document.getElementById("pauseRunBtn");

  els.manualPage = document.getElementById("manualPage");
  els.manualStateType = document.getElementById("manualStateType");
  els.manualFilterName = document.getElementById("manualFilterName");
  els.manualFilterValue = document.getElementById("manualFilterValue");
  els.manualCaptureBtn = document.getElementById("manualCaptureBtn");

  els.statusLog = document.getElementById("statusLog");
  els.chatHistory = document.getElementById("chatHistory");
  els.chatInput = document.getElementById("chatInput");
  els.sendChatBtn = document.getElementById("sendChatBtn");
  els.clearChatBtn = document.getElementById("clearChatBtn");
}

function bindPanelTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".panel");

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(x => x.classList.remove("active"));
      panels.forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.panel).classList.add("active");
    });
  });
}

function renderSelectionLists() {
  els.tabSelection.innerHTML = PAGE_OPTIONS.map(page => `
    <label class="check-item">
      <input type="checkbox" class="guided-tab" value="${escapeHtml(page)}" checked />
      <span>${escapeHtml(page)}</span>
    </label>
  `).join("");

  els.filterSelection.innerHTML = FILTER_CONFIG.map((f, idx) => `
    <label class="check-item">
      <input type="checkbox" class="guided-filter" value="${escapeHtml(f.filterName)}" ${idx < 2 ? "checked" : ""} />
      <span>${escapeHtml(f.filterName)}</span>
    </label>
  `).join("");
}

function renderManualFallbackOptions() {
  els.manualPage.innerHTML = [
    `<option value="">Select tab</option>`,
    ...PAGE_OPTIONS.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
  ].join("");

  els.manualFilterName.innerHTML = [
    `<option value="">Select filter</option>`,
    ...FILTER_CONFIG.map(f => `<option value="${escapeHtml(f.filterName)}">${escapeHtml(f.filterName)}</option>`)
  ].join("");

  refreshManualFilterValues(true);
}

function bindEvents() {
  els.saveSettingsBtn.addEventListener("click", onSaveSettings);
  els.startGuidedRunBtn.addEventListener("click", onStartGuidedRun);
  els.finishRunBtn.addEventListener("click", onFinishRun);
  els.loadLatestRunBtn.addEventListener("click", onLoadLatestRun);
  els.openLatestReportBtn.addEventListener("click", onOpenLatestReport);

  els.doneCaptureBtn.addEventListener("click", () => onGuidedAction("MODE_B_DONE_CAPTURE_CURRENT_STEP"));
  els.skipStepBtn.addEventListener("click", () => onGuidedAction("MODE_B_SKIP_CURRENT_STEP"));
  els.retryStepBtn.addEventListener("click", () => onGuidedAction("MODE_B_RETRY_CURRENT_STEP"));
  els.pauseRunBtn.addEventListener("click", () => onGuidedAction("MODE_B_TOGGLE_PAUSE_GUIDED_RUN"));

  els.manualStateType.addEventListener("change", onManualStateChanged);
  els.manualFilterName.addEventListener("change", onManualFilterChanged);
  els.manualFilterValue.addEventListener("change", saveManualDraft);
  els.manualPage.addEventListener("change", saveManualDraft);
  els.manualCaptureBtn.addEventListener("click", onManualCapture);

  els.clientName.addEventListener("input", debounce(saveSettingsDraft, 300));
  els.dashboardUrl.addEventListener("input", debounce(saveSettingsDraft, 300));
  els.backendUrl.addEventListener("input", debounce(saveSettingsDraft, 300));

  els.sendChatBtn.addEventListener("click", onSendChat);
  els.clearChatBtn.addEventListener("click", onClearChat);
}

async function loadSavedState() {
  const data = await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.manualDraft]);
  const settings = data[STORAGE_KEYS.settings] || {};
  const manual = data[STORAGE_KEYS.manualDraft] || {};

  els.clientName.value = settings.clientName || "";
  els.dashboardUrl.value = settings.dashboardUrl || "";
  els.backendUrl.value = settings.backendUrl || "";

  if (manual.pageName) els.manualPage.value = manual.pageName;
  if (manual.stateType) els.manualStateType.value = manual.stateType;
  if (manual.filterName) els.manualFilterName.value = manual.filterName;

  refreshManualFilterValues(true);

  if (manual.filterValue) {
    els.manualFilterValue.value = manual.filterValue;
  }
}

async function renderFromStorage() {
  const data = await storageGet([
    STORAGE_KEYS.activeRun,
    STORAGE_KEYS.statusLog,
    STORAGE_KEYS.chatHistory
  ]);

  renderActiveRun(data[STORAGE_KEYS.activeRun] || null);
  renderStatusLog(data[STORAGE_KEYS.statusLog] || []);
  renderChatHistory(data[STORAGE_KEYS.chatHistory] || []);
}

function renderActiveRun(run) {
  if (!run) {
    els.runBadge.textContent = "No active guided run";
    els.currentStepBox.innerHTML = `
      <div class="step-title">Waiting to start</div>
      <div class="step-line">Start a guided run to generate the capture queue.</div>
    `;
    els.pauseRunBtn.textContent = "Pause Run";
    return;
  }

  const total = run.queue?.length || 0;
  const completed = (run.queue || []).filter(x => x.status === "completed").length;
  const skipped = (run.queue || []).filter(x => x.status === "skipped").length;
  const failed = (run.queue || []).filter(x => x.status === "failed").length;
  const current = run.queue?.[run.currentIndex] || null;
  const previous = run.currentIndex > 0 ? run.queue[run.currentIndex - 1] : null;

  els.runBadge.textContent = `Active run: ${run.runId} • ${run.clientName} • ${completed}/${total} completed`;
  els.pauseRunBtn.textContent = run.paused ? "Resume Run" : "Pause Run";

  if (!current) {
    els.currentStepBox.innerHTML = `
      <div class="step-title">Guided run complete</div>
      <div class="step-line">All steps are finished.</div>
      <div class="step-line">Completed: <strong>${completed}</strong></div>
      <div class="step-line">Skipped: <strong>${skipped}</strong></div>
      <div class="step-line">Failed: <strong>${failed}</strong></div>
    `;
    return;
  }

  const previousHadFilter = !!(previous && previous.stateType === "filtered");
  const currentIsFiltered = current.stateType === "filtered";

  let resetInstruction = "";
  if (currentIsFiltered) {
    resetInstruction = `
      <div class="reset-note">
        Reset all filters to their default (Select All) before applying the new filter, so the captured state contains ONLY <strong>${escapeHtml(current.filterName)} = ${escapeHtml(current.filterValue)}</strong>.
      </div>
    `;
  } else if (previousHadFilter) {
    resetInstruction = `
      <div class="reset-note">
        This is a baseline step. Reset all filters (Select All) so no previous filter remains active.
      </div>
    `;
  }

  const instructionFilter = currentIsFiltered
    ? `${current.filterName} = ${current.filterValue}`
    : "No filter change required";

  const title = currentIsFiltered
    ? `${current.pageName} → ${current.filterName} → ${current.filterValue}`
    : `${current.pageName} → Baseline`;

  els.currentStepBox.innerHTML = `
    <div class="step-title">Step ${run.currentIndex + 1} of ${total}</div>
    <div class="step-big">${escapeHtml(title)}</div>
    <div class="divider"></div>
    <div class="step-line"><strong>Do this in Power BI:</strong></div>
    <div class="step-line">1. Open tab: <strong>${escapeHtml(current.pageName)}</strong></div>
    <div class="step-line">2. Reset all filters to <strong>Select All</strong></div>
    <div class="step-line">3. Set state: <strong>${escapeHtml(current.stateType)}</strong></div>
    <div class="step-line">4. Filter: <strong>${escapeHtml(instructionFilter)}</strong></div>
    <div class="step-line">5. Wait for visuals to finish loading</div>
    <div class="step-line">6. Click <strong>Done, Capture Now</strong></div>
    ${resetInstruction}
    <div class="divider"></div>
    <div class="step-line">Progress → Completed: <strong>${completed}</strong>, Skipped: <strong>${skipped}</strong>, Failed: <strong>${failed}</strong></div>
    <div class="step-line">Run paused: <strong>${run.paused ? "Yes" : "No"}</strong></div>
  `;
}

function renderStatusLog(logs) {
  if (!logs.length) {
    els.statusLog.innerHTML = `
      <div class="log-item">
        <div class="log-time">Status</div>
        No status yet.
      </div>
    `;
    return;
  }

  els.statusLog.innerHTML = logs.map(log => `
    <div class="log-item ${escapeHtml(log.tone || "info")}">
      <div class="log-time">${escapeHtml(log.ts || "")}</div>
      <div>${escapeHtml(log.text || "")}</div>
    </div>
  `).join("");
}

function renderChatHistory(history) {
  if (!history.length) {
    els.chatHistory.innerHTML = `
      <div class="msg assistant">
        <div class="msg-label">assistant</div>
        No chat yet.
      </div>
    `;
    return;
  }

  els.chatHistory.innerHTML = history.map(msg => `
    <div class="msg ${escapeHtml(msg.role)}">
      <div class="msg-label">${escapeHtml(msg.role)}</div>
      ${escapeHtml(msg.text)}
    </div>
  `).join("");

  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

async function onSaveSettings() {
  await storageSet({ [STORAGE_KEYS.settings]: collectSettings() });
  await addLocalStatus("Settings saved.", "ok");
}

async function saveSettingsDraft() {
  await storageSet({ [STORAGE_KEYS.settings]: collectSettings() });
}

function collectSettings() {
  return {
    clientName: els.clientName.value.trim(),
    dashboardUrl: els.dashboardUrl.value.trim(),
    backendUrl: normalizeUrl(els.backendUrl.value.trim())
  };
}

function getSelectedTabs() {
  return [...document.querySelectorAll(".guided-tab:checked")].map(x => x.value);
}

function getSelectedFilters() {
  return [...document.querySelectorAll(".guided-filter:checked")].map(x => x.value);
}

function buildGuidedQueue(tabs, filters, includeBaseline) {
  const queue = [];
  let order = 1;
  const baseStamp = Date.now();

  for (const pageName of tabs) {
    if (includeBaseline) {
      queue.push({
        stepId: `step_${baseStamp}_${order}`,
        order,
        pageName,
        stateType: "baseline",
        filterName: "",
        filterValue: "",
        status: "pending"
      });
      order += 1;
    }

    for (const filterName of filters) {
      const def = FILTER_MAP[filterName];
      if (!def) continue;

      for (const option of def.options) {
        queue.push({
          stepId: `step_${baseStamp}_${order}`,
          order,
          pageName,
          stateType: "filtered",
          filterName,
          filterValue: option,
          status: "pending"
        });
        order += 1;
      }
    }
  }

  return queue;
}

async function onStartGuidedRun() {
  const settings = collectSettings();

  if (!settings.clientName) { await addLocalStatus("Client name is required.", "error"); return; }
  if (!settings.dashboardUrl) { await addLocalStatus("Dashboard URL is required.", "error"); return; }
  if (!settings.backendUrl) { await addLocalStatus("Backend URL is required.", "error"); return; }

  const selectedTabs = getSelectedTabs();
  const selectedFilters = getSelectedFilters();
  const includeBaseline = els.includeBaseline.checked;

  if (!selectedTabs.length) { await addLocalStatus("Select at least one tab.", "error"); return; }
  if (!includeBaseline && !selectedFilters.length) {
    await addLocalStatus("Select at least one filter or enable baseline.", "error");
    return;
  }

  const queue = buildGuidedQueue(selectedTabs, selectedFilters, includeBaseline);

  const runPayload = {
    runId: `run_${Date.now()}`,
    clientName: settings.clientName,
    dashboardUrl: settings.dashboardUrl,
    backendUrl: settings.backendUrl,
    mode: "GUIDED_CAPTURE_MANUAL_SET_AUTO_SCROLL",
    startedAt: new Date().toISOString(),
    paused: false,
    currentIndex: 0,
    queue
  };

  await storageSet({ [STORAGE_KEYS.settings]: settings });

  const response = await sendRuntimeMessage({
    type: "MODE_B_START_GUIDED_RUN",
    payload: runPayload
  });

  if (response.ok) {
    await addLocalStatus(`Guided run started with ${queue.length} steps.`, "ok");
  } else {
    await addLocalStatus(`Could not start guided run: ${response.error || "Unknown error"}`, "error");
  }

  await renderFromStorage();
}

async function onFinishRun() {
  const response = await sendRuntimeMessage({ type: "MODE_B_FINISH_GUIDED_RUN" });

  if (response.ok) {
    await addLocalStatus("Active run finished.", "ok");
  } else {
    await addLocalStatus(`Could not finish run: ${response.error || "Unknown error"}`, "error");
  }

  await renderFromStorage();
}

async function onGuidedAction(type) {
  const response = await sendRuntimeMessage({ type });

  if (!response.ok) {
    await addLocalStatus(response.error || "Action failed.", "error");
  }

  await renderFromStorage();
}

function onManualStateChanged() {
  if (els.manualStateType.value !== "filtered") {
    els.manualFilterName.value = "";
  }
  refreshManualFilterValues(false);
  saveManualDraft();
}

function onManualFilterChanged() {
  refreshManualFilterValues(false);
  saveManualDraft();
}

function refreshManualFilterValues(keepValue = false) {
  const prev = keepValue ? els.manualFilterValue.value : "";

  if (els.manualStateType.value !== "filtered") {
    els.manualFilterName.disabled = true;
    els.manualFilterValue.disabled = true;
    els.manualFilterValue.innerHTML = `<option value="">Not needed for baseline</option>`;
    return;
  }

  els.manualFilterName.disabled = false;
  els.manualFilterValue.disabled = false;

  const filterName = els.manualFilterName.value;
  if (!filterName || !FILTER_MAP[filterName]) {
    els.manualFilterValue.innerHTML = `<option value="">Select filter first</option>`;
    return;
  }

  const def = FILTER_MAP[filterName];
  els.manualFilterValue.innerHTML = [
    `<option value="">Select value</option>`,
    ...def.options.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
  ].join("");

  if (prev && def.options.includes(prev)) {
    els.manualFilterValue.value = prev;
  }
}

async function saveManualDraft() {
  await storageSet({
    [STORAGE_KEYS.manualDraft]: {
      pageName: els.manualPage.value,
      stateType: els.manualStateType.value,
      filterName: els.manualStateType.value === "filtered" ? els.manualFilterName.value : "",
      filterValue: els.manualStateType.value === "filtered" ? els.manualFilterValue.value : ""
    }
  });
}

async function onManualCapture() {
  const settings = collectSettings();
  if (!settings.backendUrl) { await addLocalStatus("Backend URL is required.", "error"); return; }

  const pageName = els.manualPage.value;
  const stateType = els.manualStateType.value;
  const filterName = stateType === "filtered" ? els.manualFilterName.value : "";
  const filterValue = stateType === "filtered" ? els.manualFilterValue.value : "";

  if (!pageName) { await addLocalStatus("Select a tab for manual capture.", "error"); return; }
  if (stateType === "filtered" && !filterName) { await addLocalStatus("Select a filter name for manual capture.", "error"); return; }
  if (stateType === "filtered" && !filterValue) { await addLocalStatus("Select a filter value for manual capture.", "error"); return; }

  await saveManualDraft();

  const response = await sendRuntimeMessage({
    type: "MODE_B_MANUAL_CAPTURE_CURRENT_STATE",
    payload: {
      pageName,
      stateType,
      filterName,
      filterValue,
      clientName: settings.clientName || "",
      dashboardUrl: settings.dashboardUrl || "",
      backendUrl: settings.backendUrl || ""
    }
  });

  if (response.ok) {
    await addLocalStatus("Manual capture requested.", "ok");
  } else {
    await addLocalStatus(`Manual capture failed: ${response.error || "Unknown error"}`, "error");
  }

  await renderFromStorage();
}

async function onLoadLatestRun() {
  const settings = collectSettings();
  if (!settings.backendUrl) { await addLocalStatus("Backend URL is required.", "error"); return; }

  try {
    const res = await fetch(`${settings.backendUrl}/latest-data`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await addLocalStatus(buildLatestRunSummary(data), "ok");
  } catch (err) {
    await addLocalStatus(`Could not load latest saved run: ${err.message}`, "error");
  }
}

async function onOpenLatestReport() {
  const settings = collectSettings();
  if (!settings.backendUrl) { await addLocalStatus("Backend URL is required.", "error"); return; }

  window.open(`${settings.backendUrl}/latest-report`, "_blank");
  await addLocalStatus("Opened latest report.", "ok");
}

async function onSendChat() {
  const question = els.chatInput.value.trim();
  if (!question) { await addLocalStatus("Enter a question first.", "warn"); return; }

  const data = await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.activeRun]);
  const settings = data[STORAGE_KEYS.settings] || collectSettings();
  const activeRun = data[STORAGE_KEYS.activeRun] || null;

  if (!settings.backendUrl) { await addLocalStatus("Backend URL is required.", "error"); return; }

  await appendChat("user", question);
  els.chatInput.value = "";

  try {
    const res = await fetch(`${settings.backendUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        clientName: settings.clientName || "",
        runId: activeRun?.runId || "",
        closedBook: true
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const answer = json.answer || json.response || json.result || "No answer returned.";
    await appendChat("assistant", answer);
    await addLocalStatus("Chat answer received.", "ok");
  } catch (err) {
    const msg = `Chat failed: ${err.message}`;
    await appendChat("assistant", msg);
    await addLocalStatus(msg, "error");
  }
}

async function onClearChat() {
  await storageSet({ [STORAGE_KEYS.chatHistory]: [] });
  await renderFromStorage();
  await addLocalStatus("Chat cleared.", "ok");
}

function buildLatestRunSummary(data) {
  if (!data) return "Latest run returned empty response.";
  if (typeof data === "string") return `Latest run: ${data}`;

  const parts = ["Latest run loaded."];
  if (data.runId) parts.push(`runId=${data.runId}`);
  if (data.clientName) parts.push(`client=${data.clientName}`);
  if (typeof data.totalStates !== "undefined") parts.push(`states=${data.totalStates}`);
  if (typeof data.totalSlices !== "undefined") parts.push(`slices=${data.totalSlices}`);
  if (Array.isArray(data.extractedRows)) parts.push(`datapoints=${data.extractedRows.length}`);
  return parts.join(" ");
}

async function appendChat(role, text) {
  const data = await storageGet([STORAGE_KEYS.chatHistory]);
  const history = data[STORAGE_KEYS.chatHistory] || [];
  history.push({ role, text, ts: new Date().toISOString() });

  await storageSet({ [STORAGE_KEYS.chatHistory]: history.slice(-50) });
  await renderFromStorage();
}

async function addLocalStatus(text, tone = "info") {
  const data = await storageGet([STORAGE_KEYS.statusLog]);
  const logs = data[STORAGE_KEYS.statusLog] || [];
  logs.unshift({
    ts: new Date().toLocaleString(),
    text,
    tone
  });

  await storageSet({ [STORAGE_KEYS.statusLog]: logs.slice(0, 150) });
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function storageGet(keys) {
  return new Promise(resolve => {
    chrome.storage.local.get(keys, result => resolve(result || {}));
  });
}

function storageSet(obj) {
  return new Promise(resolve => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function sendRuntimeMessage(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}
