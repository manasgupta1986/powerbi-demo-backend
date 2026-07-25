const STORAGE_KEYS = {
  settings: "pb_guided_settings_v1",
  activeRun: "pb_guided_active_run_v1",
  statusLog: "pb_guided_status_log_v1",
  progress: "pb_guided_progress_v1"
};

let captureInProgress = false;
let captureWatchdog = null;
let keepAliveTimer = null;

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("setPanelBehavior failed:", err));
  } catch (err) { console.warn("sidePanel API not available:", err); }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (err) { console.warn("Could not open side panel:", err); }
});

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}
function startCaptureWatchdog() {
  clearCaptureWatchdog();
  captureWatchdog = setTimeout(async () => {
    captureInProgress = false;
    stopKeepAlive();
    await addStatus("Capture lock auto-released after timeout.", "warn");
  }, 5 * 60 * 1000);
}
function clearCaptureWatchdog() {
  if (captureWatchdog) { clearTimeout(captureWatchdog); captureWatchdog = null; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "MODE_B_START_GUIDED_RUN": {
          const run = message.payload;
          await storageSet({
            [STORAGE_KEYS.activeRun]: run,
            [STORAGE_KEYS.settings]: {
              clientName: run.clientName, dashboardUrl: run.dashboardUrl, backendUrl: run.backendUrl
            }
          });
          await clearProgress();
          await addStatus(`Guided run started: ${run.runId} (${run.queue.length} steps)`, "ok");
          sendResponse({ ok: true }); return;
        }
        case "MODE_B_FINISH_GUIDED_RUN": {
          const run = await getActiveRun();
          if (!run) { sendResponse({ ok: false, error: "No active run." }); return; }
          run.finishedAt = new Date().toISOString();
          await maybePostJson(`${stripTrailingSlash(run.backendUrl)}/finish-run`, {
            runId: run.runId, finishedAt: run.finishedAt
          });
          await storageRemove([STORAGE_KEYS.activeRun]);
          await clearProgress();
          await addStatus(`Guided run finished: ${run.runId}`, "ok");
          sendResponse({ ok: true }); return;
        }
        case "MODE_B_TOGGLE_PAUSE_GUIDED_RUN": {
          const run = await getActiveRun();
          if (!run) { sendResponse({ ok: false, error: "No active run." }); return; }
          run.paused = !run.paused;
          await saveActiveRun(run);
          await addStatus(run.paused ? "Guided run paused." : "Guided run resumed.", "warn");
          sendResponse({ ok: true }); return;
        }
        case "MODE_B_SKIP_CURRENT_STEP": {
          const run = await getActiveRun();
          if (!run) { sendResponse({ ok: false, error: "No active run." }); return; }
          const step = run.queue?.[run.currentIndex];
          if (!step) { sendResponse({ ok: false, error: "No current step to skip." }); return; }
          step.status = "skipped"; step.skippedAt = new Date().toISOString();
          await addStatus(`Skipped: ${stepLabel(step)}`, "warn");
          run.currentIndex += 1;
          if (run.currentIndex >= run.queue.length) {
            run.finishedAt = new Date().toISOString();
            await addStatus(`Guided run completed: ${run.runId}`, "ok");
          }
          await saveActiveRun(run);
          sendResponse({ ok: true }); return;
        }
        case "MODE_B_DONE_CAPTURE_CURRENT_STEP": {
          const result = await captureCurrentGuidedStep(false);
          sendResponse(result); return;
        }
        case "MODE_B_RETRY_CURRENT_STEP": {
          const result = await captureCurrentGuidedStep(true);
          sendResponse(result); return;
        }
        case "MODE_B_MANUAL_CAPTURE_CURRENT_STATE": {
          const result = await captureManualState(message.payload);
          sendResponse(result); return;
        }
        case "MODE_B_RESET_CAPTURE_LOCK": {
          captureInProgress = false;
          clearCaptureWatchdog();
          stopKeepAlive();
          await addStatus("Capture lock manually reset.", "warn");
          sendResponse({ ok: true }); return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` }); return;
      }
    } catch (err) {
      await addStatus(`Background error: ${err.message}`, "error");
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});

async function captureCurrentGuidedStep(isRetry) {
  if (captureInProgress) return { ok: false, error: "Another capture is already in progress." };
  const run = await getActiveRun();
  if (!run) return { ok: false, error: "No active run." };
  if (run.paused) return { ok: false, error: "Run is paused." };
  const step = run.queue?.[run.currentIndex];
  if (!step) return { ok: false, error: "No current step." };

  clearCaptureWatchdog();
  stopKeepAlive();
  captureInProgress = true;
  startCaptureWatchdog();
  startKeepAlive();

  try {
    step.status = "in_progress"; step.startedAt = new Date().toISOString();
    await saveActiveRun(run);

    await setProgress({
      phase: "capturing", captureProgress: 5, uploadProgress: 0, extractionProgress: 0,
      message: `Capturing ${stepLabel(step)}`, runId: run.runId, stateId: ""
    });

    const tab = await getActivePowerBITab();
    if (!tab?.id) {
      step.status = "failed"; step.failedAt = new Date().toISOString();
      await saveActiveRun(run); await failProgress("No Power BI dashboard tab is open. Open the Power BI dashboard tab in this window and try again.");
      return { ok: false, error: "No Power BI dashboard tab is open. Open the Power BI dashboard tab in this window and try again." };
    }

    const captureResult = await captureFullStateFromActiveTab(tab.id);
    if (!captureResult.ok) {
      step.status = "failed"; step.failedAt = new Date().toISOString();
      await saveActiveRun(run); await failProgress(captureResult.error);
      return captureResult;
    }

    const stateId = `state_${Date.now()}`;
    const meta = {
      runId: run.runId, stateId, stepId: step.stepId,
      clientName: run.clientName, dashboardUrl: run.dashboardUrl,
      pageName: step.pageName, stateType: step.stateType,
      filterName: step.filterName || "", filterValue: step.filterValue || "",
      capturedAt: new Date().toISOString()
    };

    const uploadResult = await uploadSlicesInChunks(run.backendUrl, meta, captureResult.slices);
    if (!uploadResult.ok) {
      step.status = "failed"; step.failedAt = new Date().toISOString();
      await saveActiveRun(run); await failProgress(uploadResult.error);
      return { ok: false, error: uploadResult.error };
    }

    step.status = "completed"; step.completedAt = new Date().toISOString();
    step.sliceCount = captureResult.slices.length; run.currentIndex += 1;

    if (run.currentIndex >= run.queue.length) {
      run.finishedAt = new Date().toISOString();
      await addStatus(`Guided run completed: ${run.runId}`, "ok");
    } else {
      const nextStep = run.queue[run.currentIndex];
      await addStatus(`Uploaded ${stepLabel(step)} (${captureResult.slices.length} slices). Next: ${stepLabel(nextStep)}`, "ok");
    }
    await saveActiveRun(run);

    await setProgress({
      phase: "extracting", captureProgress: 100, uploadProgress: 100, extractionProgress: 15,
      message: "Upload complete. Extraction running on backend.", runId: run.runId, stateId
    });

    pollExtractionStatus(run.backendUrl, run.runId, stateId).catch(() => {});
    return { ok: true, message: `Captured ${captureResult.slices.length} slices for ${stepLabel(step)}` };
  } finally {
    captureInProgress = false;
    clearCaptureWatchdog();
    stopKeepAlive();
  }
}

async function captureManualState(payload) {
  if (captureInProgress) return { ok: false, error: "Another capture is already in progress." };
  if (!payload?.backendUrl) return { ok: false, error: "Missing backend URL." };

  clearCaptureWatchdog();
  stopKeepAlive();
  captureInProgress = true;
  startCaptureWatchdog();
  startKeepAlive();

  try {
    await addStatus(`Manual capture requested: ${manualLabel(payload)}`, "ok");
    await setProgress({
      phase: "capturing", captureProgress: 5, uploadProgress: 0, extractionProgress: 0,
      message: `Manual capture: ${manualLabel(payload)}`, runId: "", stateId: ""
    });

    const tab = await getActivePowerBITab();
    if (!tab?.id) return { ok: false, error: "No Power BI dashboard tab is open. Open the Power BI dashboard tab in this window and try again." };

    const captureResult = await captureFullStateFromActiveTab(tab.id);
    if (!captureResult.ok) { await failProgress(captureResult.error); return captureResult; }

    const runId = `manual_run_${Date.now()}`; const stateId = `manual_state_${Date.now()}`;
    const meta = {
      runId, stateId, stepId: "",
      clientName: payload.clientName || "", dashboardUrl: payload.dashboardUrl || "",
      pageName: payload.pageName || "", stateType: payload.stateType || "baseline",
      filterName: payload.filterName || "", filterValue: payload.filterValue || "",
      capturedAt: new Date().toISOString()
    };

    const uploadResult = await uploadSlicesInChunks(payload.backendUrl, meta, captureResult.slices);
    if (!uploadResult.ok) { await failProgress(uploadResult.error); return { ok: false, error: uploadResult.error }; }

    await setProgress({
      phase: "extracting", captureProgress: 100, uploadProgress: 100, extractionProgress: 15,
      message: "Upload complete. Extraction running on backend.", runId, stateId
    });

    pollExtractionStatus(payload.backendUrl, runId, stateId).catch(() => {});
    return { ok: true, message: `Manual capture uploaded (${captureResult.slices.length} slices)` };
  } finally {
    captureInProgress = false;
    clearCaptureWatchdog();
    stopKeepAlive();
  }
}

async function uploadSlicesInChunks(backendUrl, meta, slices) {
  const base = stripTrailingSlash(backendUrl);
  const total = slices.length;

  await setProgress({
    phase: "uploading", captureProgress: 100, uploadProgress: 5, extractionProgress: 0,
    message: `Starting upload of ${total} slices`, runId: meta.runId, stateId: meta.stateId
  });

  try {
    console.log(`[upload] start: run=${meta.runId} state=${meta.stateId} slices=${total}`);
    const startRes = await fetch(`${base}/capture-state/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...meta, totalSlices: total })
    });
    if (!startRes.ok) {
      const text = await safeReadText(startRes);
      return { ok: false, error: `Start failed: HTTP ${startRes.status}${text ? `: ${text}` : ""}` };
    }
  } catch (err) {
    return { ok: false, error: `Start request failed: ${err.message}` };
  }

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    console.log(`[upload] slice ${slice.sliceIndex} of ${total} starting`);
    const sliceBody = {
      runId: meta.runId,
      stateId: meta.stateId,
      sliceIndex: slice.sliceIndex,
      scrollY: slice.scrollY || 0,
      viewportWidth: slice.viewportWidth || 0,
      viewportHeight: slice.viewportHeight || 0,
      totalScrollHeight: slice.totalScrollHeight || 0,
      clientHeight: slice.clientHeight || 0,
      capturedAt: slice.capturedAt || new Date().toISOString(),
      imageDataUrl: slice.imageDataUrl || ""
    };

    let attempt = 0;
    let lastErr = "";
    while (attempt < 3) {
      attempt += 1;
      try {
        const res = await fetch(`${base}/capture-state/slice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sliceBody)
        });
        console.log(`[upload] slice ${slice.sliceIndex} attempt ${attempt} status ${res.status}`);
        if (res.ok) { lastErr = ""; break; }
        const text = await safeReadText(res);
        lastErr = `HTTP ${res.status}${text ? `: ${text}` : ""}`;
      } catch (err) {
        lastErr = err.message;
        console.warn(`[upload] slice ${slice.sliceIndex} attempt ${attempt} error ${err.message}`);
      }
      await sleep(500 * attempt);
    }

    slice.imageDataUrl = "";

    if (lastErr) return { ok: false, error: `Slice ${slice.sliceIndex} upload failed: ${lastErr}` };

    const uploadProgress = Math.min(99, Math.floor(((i + 1) / total) * 100));
    await setProgress({
      phase: "uploading", captureProgress: 100, uploadProgress, extractionProgress: 0,
      message: `Uploaded slice ${i + 1} of ${total}`, runId: meta.runId, stateId: meta.stateId
    });
  }

  try {
    console.log(`[upload] finishing: run=${meta.runId} state=${meta.stateId}`);
    const finRes = await fetch(`${base}/capture-state/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: meta.runId, stateId: meta.stateId })
    });
    if (!finRes.ok) {
      const text = await safeReadText(finRes);
      return { ok: false, error: `Finish failed: HTTP ${finRes.status}${text ? `: ${text}` : ""}` };
    }
  } catch (err) {
    return { ok: false, error: `Finish request failed: ${err.message}` };
  }

  await setProgress({
    phase: "uploading", captureProgress: 100, uploadProgress: 100, extractionProgress: 5,
    message: `All ${total} slices uploaded`, runId: meta.runId, stateId: meta.stateId
  });

  return { ok: true };
}

async function pollExtractionStatus(backendUrl, runId, stateId) {
  const start = Date.now();
  const maxMs = 5 * 60 * 1000;
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${stripTrailingSlash(backendUrl)}/state-status?runId=${encodeURIComponent(runId)}&stateId=${encodeURIComponent(stateId)}`);
      if (res.ok) {
        const json = await res.json();
        const s = json.status || {};
        const extractionProgress = s.progress ?? 20;
        await setProgress({
          phase: s.stage === "done" ? "done" : s.stage === "failed" ? "failed" : "extracting",
          captureProgress: 100, uploadProgress: 100, extractionProgress,
          message: s.message || "", runId, stateId
        });
        if (s.stage === "done" || s.stage === "failed") return;
      }
    } catch (_e) {}
    await sleep(2000);
  }
  await setProgress({
    phase: "failed", captureProgress: 100, uploadProgress: 100, extractionProgress: 100,
    message: "Timed out waiting for extraction status.", runId, stateId
  });
}

async function captureFullStateFromActiveTab(tabId) {
  await sleep(800);

  const reset = await sendTabMessage(tabId, { type: "MODE_B_RESET_SCROLL_TOP" });
  if (!reset.ok) return { ok: false, error: `Could not initialize scroll state: ${reset.error}` };

  const slices = [];
  const seenScrollY = new Set();
  const maxSlices = 20;
  let lastNextY = null;

  for (let i = 0; i < maxSlices; i++) {
    const metrics = await sendTabMessage(tabId, { type: "MODE_B_GET_SCROLL_METRICS" });
    if (!metrics.ok) return { ok: false, error: `Could not read scroll metrics: ${metrics.error}` };

    const scrollY = Math.round(metrics.scrollY || 0);
    if (seenScrollY.has(scrollY) && i > 0) break;
    seenScrollY.add(scrollY);

    const screenshot = await captureVisibleCurrentWindow();
    if (!screenshot.ok) return { ok: false, error: screenshot.error || "Screenshot failed." };

    slices.push({
      sliceIndex: i + 1, scrollY,
      viewportWidth: metrics.viewportWidth || 0,
      viewportHeight: metrics.viewportHeight || 0,
      totalScrollHeight: metrics.totalScrollHeight || 0,
      clientHeight: metrics.clientHeight || 0,
      capturedAt: new Date().toISOString(),
      imageDataUrl: screenshot.dataUrl
    });

    const captureProgress = Math.min(90, 10 + Math.floor((i + 1) * (80 / maxSlices)));
    await setProgress({
      phase: "capturing", captureProgress, uploadProgress: 0, extractionProgress: 0,
      message: `Captured slice ${i + 1} at y=${scrollY}`
    });
    await addStatus(`Captured slice ${i + 1} at y=${scrollY}`, "ok");

    if (metrics.bottomReached) break;

    const next = await sendTabMessage(tabId, { type: "MODE_B_SCROLL_NEXT" });
    if (!next.ok) return { ok: false, error: `Scroll failed: ${next.error}` };
    if (!next.changed) break;

    const nextY = Math.round(next.scrollY || 0);
    if (lastNextY !== null && nextY === lastNextY) break;
    lastNextY = nextY;

    await sleep(350);
  }

  if (!slices.length) return { ok: false, error: "No slices were captured." };
  return { ok: true, slices };
}

async function maybePostJson(url, body) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {}
}

async function getActivePowerBITab() {
  const pbTabsInWindow = await chrome.tabs.query({
    currentWindow: true,
    url: ["https://app.powerbi.com/*", "https://*.powerbi.com/*"]
  });
  if (pbTabsInWindow && pbTabsInWindow.length) {
    const target = pbTabsInWindow[0];
    try {
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId) await chrome.windows.update(target.windowId, { focused: true });
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {}
    return target;
  }
  const pbTabsAnywhere = await chrome.tabs.query({
    url: ["https://app.powerbi.com/*", "https://*.powerbi.com/*"]
  });
  if (pbTabsAnywhere && pbTabsAnywhere.length) {
    const target = pbTabsAnywhere[0];
    try {
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId) await chrome.windows.update(target.windowId, { focused: true });
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {}
    return target;
  }
  return null;
}

function captureVisibleCurrentWindow() {
  return new Promise(resolve => {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, dataUrl => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      if (!dataUrl) { resolve({ ok: false, error: "captureVisibleTab returned empty image." }); return; }
      resolve({ ok: true, dataUrl });
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, async response => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || "";
        const isNotConnected =
          errMsg.includes("Receiving end does not exist") ||
          errMsg.includes("Could not establish connection");
        if (isNotConnected) {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
            await new Promise(r => setTimeout(r, 250));
            chrome.tabs.sendMessage(tabId, message, retryResponse => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
                return;
              }
              resolve(retryResponse || { ok: false, error: "No response from content script after re-injection." });
            });
            return;
          } catch (injectErr) {
            resolve({ ok: false, error: `Content script re-injection failed: ${injectErr.message}` });
            return;
          }
        }
        resolve({ ok: false, error: errMsg });
        return;
      }
      resolve(response || { ok: false, error: "No response from content script." });
    });
  });
}

async function getActiveRun() {
  const data = await storageGet([STORAGE_KEYS.activeRun]);
  return data[STORAGE_KEYS.activeRun] || null;
}
async function saveActiveRun(run) { await storageSet({ [STORAGE_KEYS.activeRun]: run }); }

async function addStatus(text, tone = "info") {
  const data = await storageGet([STORAGE_KEYS.statusLog]);
  const logs = data[STORAGE_KEYS.statusLog] || [];
  logs.unshift({ ts: new Date().toLocaleString(), text, tone });
  await storageSet({ [STORAGE_KEYS.statusLog]: logs.slice(0, 200) });
}

async function setProgress(patch) {
  const data = await storageGet([STORAGE_KEYS.progress]);
  const prev = data[STORAGE_KEYS.progress] || {};
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  await storageSet({ [STORAGE_KEYS.progress]: next });
}
async function failProgress(err) {
  await setProgress({
    phase: "failed", captureProgress: 100, uploadProgress: 100, extractionProgress: 100,
    message: `Failed: ${err || "unknown"}`
  });
}
async function clearProgress() { await storageSet({ [STORAGE_KEYS.progress]: null }); }

function stepLabel(step) {
  if (!step) return "Unknown step";
  return step.stateType === "baseline"
    ? `${step.pageName} → Baseline`
    : `${step.pageName} → ${step.filterName} = ${step.filterValue}`;
}
function manualLabel(payload) {
  return payload.stateType === "baseline"
    ? `${payload.pageName} → Baseline`
    : `${payload.pageName} → ${payload.filterName} = ${payload.filterValue}`;
}
function stripTrailingSlash(url) { return String(url || "").replace(/\/+$/, ""); }
async function safeReadText(res) { try { return await res.text(); } catch { return ""; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function storageGet(keys) { return new Promise(resolve => chrome.storage.local.get(keys, r => resolve(r || {}))); }
function storageSet(obj) { return new Promise(resolve => chrome.storage.local.set(obj, () => resolve())); }
function storageRemove(keys) { return new Promise(resolve => chrome.storage.local.remove(keys, () => resolve())); }
