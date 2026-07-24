const STORAGE_KEYS = {
  settings: "pb_guided_settings_v1",
  activeRun: "pb_guided_active_run_v1",
  statusLog: "pb_guided_status_log_v1"
};

let captureInProgress = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "MODE_B_START_GUIDED_RUN": {
          const run = message.payload;
          await storageSet({
            [STORAGE_KEYS.activeRun]: run,
            [STORAGE_KEYS.settings]: {
              clientName: run.clientName,
              dashboardUrl: run.dashboardUrl,
              backendUrl: run.backendUrl
            }
          });
          await addStatus(`Guided run started: ${run.runId} (${run.queue.length} steps)`, "ok");
          sendResponse({ ok: true });
          return;
        }

        case "MODE_B_FINISH_GUIDED_RUN": {
          const run = await getActiveRun();
          if (!run) { sendResponse({ ok: false, error: "No active run." }); return; }

          run.finishedAt = new Date().toISOString();
          await maybePostJson(`${stripTrailingSlash(run.backendUrl)}/finish-run`, {
            runId: run.runId,
            finishedAt: run.finishedAt
          });

          await storageRemove([STORAGE_KEYS.activeRun]);
          await addStatus(`Guided run finished: ${run.runId}`, "ok");
          sendResponse({ ok: true });
          return;
        }

        case "MODE_B_TOGGLE_PAUSE_GUIDED_RUN": {
          const run = await getActiveRun();
          if (!run) { sendResponse({ ok: false, error: "No active run." }); return; }

          run.paused = !run.paused;
          await saveActiveRun(run);
          await addStatus(run.paused ? "Guided run paused." : "Guided run resumed.", "warn");
          sendResponse({ ok: true });
          return;
        }

        case "MODE_B_SKIP_CURRENT_STEP": {
          const run = await getActiveRun();
          if (!run) { sendResponse({ ok: false, error: "No active run." }); return; }

          const step = run.queue?.[run.currentIndex];
          if (!step) { sendResponse({ ok: false, error: "No current step to skip." }); return; }

          step.status = "skipped";
          step.skippedAt = new Date().toISOString();
          await addStatus(`Skipped: ${stepLabel(step)}`, "warn");

          run.currentIndex += 1;
          if (run.currentIndex >= run.queue.length) {
            run.finishedAt = new Date().toISOString();
            await addStatus(`Guided run completed: ${run.runId}`, "ok");
          }

          await saveActiveRun(run);
          sendResponse({ ok: true });
          return;
        }

        case "MODE_B_DONE_CAPTURE_CURRENT_STEP": {
          const result = await captureCurrentGuidedStep(false);
          sendResponse(result);
          return;
        }

        case "MODE_B_RETRY_CURRENT_STEP": {
          const result = await captureCurrentGuidedStep(true);
          sendResponse(result);
          return;
        }

        case "MODE_B_MANUAL_CAPTURE_CURRENT_STATE": {
          const result = await captureManualState(message.payload);
          sendResponse(result);
          return;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
          return;
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

  captureInProgress = true;

  try {
    step.status = "in_progress";
    step.startedAt = new Date().toISOString();
    await saveActiveRun(run);

    await addStatus(`${isRetry ? "Retrying" : "Capturing"} step: ${stepLabel(step)}`, "ok");

    const tab = await getActivePowerBITab();
    if (!tab?.id) {
      step.status = "failed";
      step.failedAt = new Date().toISOString();
      await saveActiveRun(run);
      return { ok: false, error: "No active Power BI tab found." };
    }

    const captureResult = await captureFullStateFromActiveTab(tab.id);
    if (!captureResult.ok) {
      step.status = "failed";
      step.failedAt = new Date().toISOString();
      await saveActiveRun(run);
      await addStatus(`Capture failed: ${captureResult.error}`, "error");
      return captureResult;
    }

    const statePayload = {
      runId: run.runId,
      stateId: `state_${Date.now()}`,
      stepId: step.stepId,
      clientName: run.clientName,
      dashboardUrl: run.dashboardUrl,
      pageName: step.pageName,
      stateType: step.stateType,
      filterName: step.filterName || "",
      filterValue: step.filterValue || "",
      capturedAt: new Date().toISOString(),
      slices: captureResult.slices
    };

    const postResult = await postCaptureState(run.backendUrl, statePayload);
    if (!postResult.ok) {
      step.status = "failed";
      step.failedAt = new Date().toISOString();
      await saveActiveRun(run);
      await addStatus(`Upload failed: ${postResult.error}`, "error");
      return { ok: false, error: postResult.error };
    }

    step.status = "completed";
    step.completedAt = new Date().toISOString();
    step.sliceCount = captureResult.slices.length;
    run.currentIndex += 1;

    if (run.currentIndex >= run.queue.length) {
      run.finishedAt = new Date().toISOString();
      await addStatus(`Guided run completed: ${run.runId}`, "ok");
    } else {
      const nextStep = run.queue[run.currentIndex];
      await addStatus(
        `Completed ${stepLabel(step)} (${captureResult.slices.length} slices). Next: ${stepLabel(nextStep)}`,
        "ok"
      );
    }

    await saveActiveRun(run);
    return { ok: true, message: `Captured ${captureResult.slices.length} slices for ${stepLabel(step)}` };
  } finally {
    captureInProgress = false;
  }
}

async function captureManualState(payload) {
  if (captureInProgress) return { ok: false, error: "Another capture is already in progress." };
  if (!payload?.backendUrl) return { ok: false, error: "Missing backend URL." };

  captureInProgress = true;

  try {
    await addStatus(`Manual capture requested: ${manualLabel(payload)}`, "ok");

    const tab = await getActivePowerBITab();
    if (!tab?.id) return { ok: false, error: "No active Power BI tab found." };

    const captureResult = await captureFullStateFromActiveTab(tab.id);
    if (!captureResult.ok) {
      await addStatus(`Manual capture failed: ${captureResult.error}`, "error");
      return captureResult;
    }

    const statePayload = {
      runId: `manual_run_${Date.now()}`,
      stateId: `manual_state_${Date.now()}`,
      stepId: "",
      clientName: payload.clientName || "",
      dashboardUrl: payload.dashboardUrl || "",
      pageName: payload.pageName || "",
      stateType: payload.stateType || "baseline",
      filterName: payload.filterName || "",
      filterValue: payload.filterValue || "",
      capturedAt: new Date().toISOString(),
      slices: captureResult.slices
    };

    const postResult = await postCaptureState(payload.backendUrl, statePayload);
    if (!postResult.ok) {
      await addStatus(`Manual upload failed: ${postResult.error}`, "error");
      return { ok: false, error: postResult.error };
    }

    await addStatus(
      `Manual capture uploaded: ${manualLabel(payload)} (${captureResult.slices.length} slices)`,
      "ok"
    );

    return { ok: true, message: `Manual capture uploaded (${captureResult.slices.length} slices)` };
  } finally {
    captureInProgress = false;
  }
}

async function captureFullStateFromActiveTab(tabId) {
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

    if (seenScrollY.has(scrollY) && i > 0) {
      await addStatus(`Stopping capture on duplicate scroll position y=${scrollY}`, "warn");
      break;
    }
    seenScrollY.add(scrollY);

    const screenshot = await captureVisibleCurrentWindow();
    if (!screenshot.ok) return { ok: false, error: screenshot.error || "Screenshot failed." };

    slices.push({
      sliceIndex: i + 1,
      scrollY,
      viewportWidth: metrics.viewportWidth || 0,
      viewportHeight: metrics.viewportHeight || 0,
      totalScrollHeight: metrics.totalScrollHeight || 0,
      clientHeight: metrics.clientHeight || 0,
      capturedAt: new Date().toISOString(),
      imageDataUrl: screenshot.dataUrl
    });

    await addStatus(`Captured slice ${i + 1} at y=${scrollY}`, "ok");

    if (metrics.bottomReached) {
      await addStatus(`Reached bottom at slice ${i + 1}`, "ok");
      break;
    }

    const next = await sendTabMessage(tabId, { type: "MODE_B_SCROLL_NEXT" });
    if (!next.ok) return { ok: false, error: `Scroll failed: ${next.error}` };
    if (!next.changed) {
      await addStatus(`Stopping capture because scroll did not change`, "warn");
      break;
    }

    const nextY = Math.round(next.scrollY || 0);
    if (lastNextY !== null && nextY === lastNextY) {
      await addStatus(`Stopping capture because next y repeated (${nextY})`, "warn");
      break;
    }
    lastNextY = nextY;

    await sleep(350);
  }

  if (!slices.length) return { ok: false, error: "No slices were captured." };
  return { ok: true, slices };
}

async function postCaptureState(backendUrl, payload) {
  try {
    const res = await fetch(`${stripTrailingSlash(backendUrl)}/capture-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
    }

    const json = await res.json().catch(() => ({}));
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function maybePostJson(url, body) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch { /* best effort */ }
}

async function getActivePowerBITab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs.length) return null;
  return tabs[0];
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
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      resolve(response || { ok: false, error: "No response from content script." });
    });
  });
}

async function getActiveRun() {
  const data = await storageGet([STORAGE_KEYS.activeRun]);
  return data[STORAGE_KEYS.activeRun] || null;
}

async function saveActiveRun(run) {
  await storageSet({ [STORAGE_KEYS.activeRun]: run });
}

async function addStatus(text, tone = "info") {
  const data = await storageGet([STORAGE_KEYS.statusLog]);
  const logs = data[STORAGE_KEYS.statusLog] || [];
  logs.unshift({
    ts: new Date().toLocaleString(),
    text,
    tone
  });

  await storageSet({ [STORAGE_KEYS.statusLog]: logs.slice(0, 200) });
}

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

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ""; }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
function storageRemove(keys) {
  return new Promise(resolve => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}
