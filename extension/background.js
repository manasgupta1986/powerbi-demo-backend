function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function setStorage(v) { return chrome.storage.local.set(v); }
async function getStorage(k) { return chrome.storage.local.get(k); }

async function resetRunLog() {
  await setStorage({ isRunning: false, runStatus: "Idle", runLog: [], lastError: "" });
}

async function addLog(line) {
  const stamp = new Date().toLocaleTimeString();
  const row = `[${stamp}] ${line}`;
  const cur = await getStorage(["runLog"]);
  const runLog = Array.isArray(cur.runLog) ? cur.runLog : [];
  runLog.push(row);
  await setStorage({ runLog });
}

async function setStatus(status) {
  await setStorage({ runStatus: status });
  await addLog(status);
}

chrome.runtime.onInstalled.addListener(async () => {
  await resetRunLog();
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});
chrome.runtime.onStartup.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

async function waitForTabComplete(tabId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return true;
    await sleep(1000);
  }
  throw new Error("Dashboard tab did not finish loading in time.");
}

async function openOrReuseDashboardTab(dashboardUrl) {
  const existing = await chrome.tabs.query({ url: ["https://app.powerbi.com/*"] });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true, url: dashboardUrl });
    await waitForTabComplete(tab.id);
    return await chrome.tabs.get(tab.id);
  }
  const created = await chrome.tabs.create({ url: dashboardUrl, active: true });
  await waitForTabComplete(created.id);
  return created;
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (pong?.ok) return true;
  } catch (e) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await sleep(1500);
  const pong2 = await chrome.tabs.sendMessage(tabId, { type: "ping" });
  if (pong2?.ok) return true;
  throw new Error("Could not connect to content script.");
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function captureHeaderScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(800);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const viewport = await sendToTab(tabId, { type: "getViewportInfo" });
  return { dataUrl, viewport };
}

async function askBackendForCoordinates(backendUrl, screenshotDataUrl, labels, viewport) {
  const cleanUrl = backendUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/find-ui`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenshotDataUrl, labels, viewport })
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.error || "find-ui failed");
  return json;
}

function scaleCoordsToViewport(target, imageWidth, imageHeight, viewport) {
  if (!imageWidth || !imageHeight || !viewport?.width || !viewport?.height) return null;
  if (target?.x == null || target?.y == null) return null;
  const scaleX = viewport.width / imageWidth;
  const scaleY = viewport.height / imageHeight;
  return {
    x: Math.round(target.x * scaleX),
    y: Math.round(target.y * scaleY),
    confidence: target.confidence || 0
  };
}

async function visionClickLabel(tabId, backendUrl, label) {
  const { dataUrl, viewport } = await captureHeaderScreenshot(tabId);
  const result = await askBackendForCoordinates(backendUrl, dataUrl, [label], viewport);

  const target = (result.targets || [])[0];
  const point = scaleCoordsToViewport(target, result.image_width, result.image_height, viewport);

  if (!point || point.confidence < 0.35) {
    await addLog(`Vision could not locate "${label}" (confidence=${point?.confidence ?? "n/a"})`);
    return { ok: false, note: `Vision could not locate "${label}"` };
  }

  await addLog(`Vision located "${label}" at (${point.x}, ${point.y}) confidence=${point.confidence}`);
  const clickRes = await sendToTab(tabId, { type: "clickAtPoint", x: point.x, y: point.y });
  await sleep(1500);
  return {
    ok: !!clickRes?.ok,
    note: clickRes?.note || "",
    point
  };
}

async function captureVisibleState(tabId, meta) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(1400);
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const textResp = await sendToTab(tabId, { type: "getVisibleText" });
  const scrollResp = await sendToTab(tabId, { type: "getScrollMetrics" });
  return {
    phase: meta.phase || "unknown",
    pageName: meta.pageName || "",
    filterName: meta.filterName || "",
    filterValue: meta.filterValue || "",
    verificationNote: meta.verificationNote || "",
    visibleText: textResp?.visibleText || "",
    screenshotDataUrl,
    scrollY: scrollResp?.scrollY ?? null,
    viewportHeight: scrollResp?.viewportHeight ?? null,
    documentHeight: scrollResp?.documentHeight ?? null,
    sliceIndex: meta.sliceIndex ?? null
  };
}

async function captureAllSlices(tabId, phase, pageName, filterName, filterValue, note) {
  const captures = [];
  const topResp = await sendToTab(tabId, { type: "scrollToTop" });
  await addLog(`Top reset for ${pageName}: Y=${topResp?.scrollY}, doc=${topResp?.documentHeight}, viewport=${topResp?.viewportHeight}`);
  await sleep(800);

  let safety = 0;
  while (safety < 14) {
    safety += 1;
    const metrics = await sendToTab(tabId, { type: "getScrollMetrics" });
    const sliceNumber = captures.length + 1;

    const capture = await captureVisibleState(tabId, {
      phase, pageName, filterName, filterValue,
      verificationNote: `${note} | slice ${sliceNumber}`,
      sliceIndex: sliceNumber
    });
    captures.push(capture);
    await addLog(`Captured slice ${sliceNumber} for ${pageName} | ${filterName || "baseline"} | ${filterValue || "overall"} at Y=${metrics?.scrollY}`);

    if (metrics?.atBottom) {
      await addLog(`Reached bottom for ${pageName} at slice ${sliceNumber}`);
      break;
    }
    const scrollResp = await sendToTab(tabId, { type: "scrollDownOneStep" });
    if (scrollResp?.after?.scrollY === scrollResp?.before?.scrollY) {
      await addLog(`Scroll stopped changing for ${pageName}.`);
      break;
    }
    await sleep(800);
  }
  return captures;
}

async function openPageAndCapture(tabId, backendUrl, pageName, phase, filterName, filterValue) {
  await addLog(`Opening page: ${pageName}`);
  const clickResult = await visionClickLabel(tabId, backendUrl, pageName);
  await sleep(1800);

  const note = clickResult.ok
    ? `Vision-clicked "${pageName}" at ${clickResult.point?.x},${clickResult.point?.y}`
    : `Vision click for "${pageName}" failed`;
  await addLog(note);

  return await captureAllSlices(tabId, phase, pageName, filterName, filterValue, note);
}

async function verifyFilterValueChanged(tabId, backendUrl, filterName, expectedValue) {
  const { dataUrl, viewport } = await captureHeaderScreenshot(tabId);
  const labelToCheck = `${filterName} current value`;
  const result = await askBackendForCoordinates(backendUrl, dataUrl, [labelToCheck, expectedValue], viewport);
  const notes = (result.targets || []).map(t => `${t.label}: conf=${t.confidence}`).join(" | ");
  await addLog(`Verification pass: ${notes}`);
  const expected = (result.targets || []).find(t => t.label === expectedValue);
  return !!(expected && expected.confidence >= 0.35);
}

async function resetFilterVision(tabId, backendUrl, filterName, allLabel) {
  await addLog(`Resetting filter "${filterName}" to "${allLabel}"`);
  const openRes = await visionClickLabel(tabId, backendUrl, filterName);
  await sleep(1200);
  if (!openRes.ok) return { ok: false, note: `Could not open filter ${filterName}` };

  const allRes = await visionClickLabel(tabId, backendUrl, allLabel);
  await sleep(1200);

  await sendToTab(tabId, { type: "clickAtPoint", x: 8, y: 8 }); // click away
  await sleep(800);

  return {
    ok: allRes.ok,
    note: allRes.ok ? `Reset ${filterName} via vision` : `Reset click failed for ${filterName}`
  };
}

async function applyFilterOptionVision(tabId, backendUrl, filterName, optionLabel) {
  await addLog(`Selecting ${filterName} = ${optionLabel}`);
  const openRes = await visionClickLabel(tabId, backendUrl, filterName);
  await sleep(1200);
  if (!openRes.ok) return { ok: false, note: `Could not open filter ${filterName}` };

  let optionRes = await visionClickLabel(tabId, backendUrl, optionLabel);

  if (!optionRes.ok && openRes.point) {
    // try scrolling the dropdown and retry once
    await sendToTab(tabId, {
      type: "scrollDropdownAtPoint",
      x: openRes.point.x,
      y: openRes.point.y + 80,
      step: 120
    });
    await sleep(800);
    optionRes = await visionClickLabel(tabId, backendUrl, optionLabel);
  }

  await sleep(1200);
  await sendToTab(tabId, { type: "clickAtPoint", x: 8, y: 8 }); // click away
  await sleep(800);

  return {
    ok: optionRes.ok,
    note: optionRes.ok ? `Selected ${filterName} = ${optionLabel} via vision` : `Option click failed`
  };
}

async function callBackendAnalyze(backendUrl, payload) {
  const cleanUrl = backendUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.error || "Backend analyze failed.");
  return json;
}

async function startSweep(payload) {
  const cur = await getStorage(["isRunning"]);
  if (cur.isRunning) throw new Error("A sweep is already running.");

  await setStorage({ isRunning: true, runStatus: "Starting sweep...", runLog: [], lastError: "" });

  try {
    const clientName = payload.clientName || "";
    const dashboardUrl = payload.dashboardUrl || "";
    const backendUrl = payload.backendUrl || "";
    const pageNames = Array.isArray(payload.pageNames) ? payload.pageNames : [];
    const filterConfig = Array.isArray(payload.filterConfig) ? payload.filterConfig : [];

    if (!dashboardUrl) throw new Error("Dashboard URL is blank.");
    if (!backendUrl) throw new Error("Backend URL is blank.");
    if (pageNames.length === 0) throw new Error("No page names provided.");
    if (filterConfig.length === 0) throw new Error("No filter config provided.");

    await setStatus("Opening dashboard...");
    const tab = await openOrReuseDashboardTab(dashboardUrl);

    await setStatus("Connecting to dashboard page...");
    await ensureContentScript(tab.id);

    const captures = [];

    await setStatus("Capturing baseline with vision-based tab clicks...");
    for (const pageName of pageNames) {
      const pageCaptures = await openPageAndCapture(tab.id, backendUrl, pageName, "baseline", "baseline", "overall");
      captures.push(...pageCaptures);
    }

    for (const filter of filterConfig) {
      const filterName = filter.filterName;
      const allLabel = filter.allLabel || "All";
      const options = Array.isArray(filter.options) ? filter.options : [];

      await setStatus(`Starting filter (vision): ${filterName}`);

      for (const option of options) {
        await addLog(`Preparing isolated state for ${filterName} = ${option}`);
        const resetRes = await resetFilterVision(tab.id, backendUrl, filterName, allLabel);
        if (!resetRes.ok) {
          await addLog(`SKIPPED_CAPTURE: ${filterName} = ${option} because reset failed`);
          continue;
        }
        const applyRes = await applyFilterOptionVision(tab.id, backendUrl, filterName, option);
        if (!applyRes.ok) {
          await addLog(`SKIPPED_CAPTURE: ${filterName} = ${option} because option selection failed`);
          continue;
        }
        for (const pageName of pageNames) {
          const pc = await openPageAndCapture(tab.id, backendUrl, pageName, "filtered", filterName, option);
          captures.push(...pc);
        }
      }

      await addLog(`Final reset of ${filterName} to ${allLabel}`);
      await resetFilterVision(tab.id, backendUrl, filterName, allLabel);
    }

    if (captures.length === 0) throw new Error("No captures were produced.");

    await setStatus("Sending captures to backend for chart extraction, strategic report, and chat dataset build...");
    const result = await callBackendAnalyze(backendUrl, {
      clientName, dashboardUrl,
      pages: pageNames, filters: filterConfig, captures
    });

    await setStorage({
      lastRunAt: new Date().toISOString(),
      lastReportUrl: result.latestReportUrl || "",
      lastDataUrl: result.latestDataUrl || "",
      lastSummary: result.summary || "",
      runStatus: "Sweep complete. Strategic report and chat dataset are ready.",
      isRunning: false
    });
    await addLog("Sweep complete.");
    await addLog(`Latest data URL: ${result.latestDataUrl}`);
    await addLog(`Latest report URL: ${result.latestReportUrl}`);
  } catch (err) {
    await setStorage({ isRunning: false, runStatus: `Run failed: ${err.message}`, lastError: err.message });
    await addLog(`ERROR: ${err.message}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "logStatus") {
    addLog(message.line || "Status update");
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "startSweep") {
    startSweep(message.payload).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === "resetLogs") {
    resetRunLog().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
