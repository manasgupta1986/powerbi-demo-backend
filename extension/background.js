function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setStorage(values) {
  return chrome.storage.local.set(values);
}

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function resetRunLog() {
  await setStorage({
    isRunning: false,
    runStatus: "Idle",
    runLog: [],
    lastError: ""
  });
}

async function addLog(line) {
  const stamp = new Date().toLocaleTimeString();
  const row = `[${stamp}] ${line}`;
  const current = await getStorage(["runLog"]);
  const runLog = Array.isArray(current.runLog) ? current.runLog : [];
  runLog.push(row);
  await setStorage({ runLog });
}

async function setStatus(status) {
  await setStorage({ runStatus: status });
  await addLog(status);
}

chrome.runtime.onInstalled.addListener(async () => {
  await resetRunLog();
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
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
  const existingTabs = await chrome.tabs.query({ url: ["https://app.powerbi.com/*"] });

  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
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
    if (pong && pong.ok) return true;
  } catch (err) {
    // ignore and inject below
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  await sleep(1500);

  const pong2 = await chrome.tabs.sendMessage(tabId, { type: "ping" });
  if (pong2 && pong2.ok) return true;

  throw new Error("Could not connect to content script.");
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function captureVisibleState(tabId, meta) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(1800);

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });

  const textResp = await sendToTab(tabId, { type: "getVisibleText" });

  return {
    phase: meta.phase || "unknown",
    pageName: meta.pageName || "",
    filterName: meta.filterName || "",
    filterValue: meta.filterValue || "",
    verificationNote: meta.verificationNote || "",
    visibleText: textResp?.visibleText || "",
    screenshotDataUrl
  };
}

async function openPageAndCapture(tabId, pageName, phase, filterName, filterValue) {
  await addLog(`Opening page: ${pageName}`);

  const pageResp = await sendToTab(tabId, {
    type: "switchPage",
    pageName
  });

  await sleep(2200);

  const note = pageResp?.note || `Attempted to open page ${pageName}`;
  await addLog(note);

  const capture = await captureVisibleState(tabId, {
    phase,
    pageName,
    filterName,
    filterValue,
    verificationNote: note
  });

  await addLog(`Screenshot captured for ${pageName} | ${filterName || "baseline"} | ${filterValue || "overall"}`);
  return capture;
}

async function callBackendAnalyze(backendUrl, payload) {
  const cleanUrl = backendUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(json.error || "Backend analyze failed.");
  }
  return json;
}

async function startSweep(payload) {
  const currently = await getStorage(["isRunning"]);
  if (currently.isRunning) throw new Error("A sweep is already running.");

  await setStorage({
    isRunning: true,
    runStatus: "Starting sweep...",
    runLog: [],
    lastError: ""
  });

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
    const dashboardTab = await openOrReuseDashboardTab(dashboardUrl);

    await setStatus("Connecting to dashboard page...");
    await ensureContentScript(dashboardTab.id);

    const captures = [];

    await setStatus("Capturing baseline screenshots across all pages...");
    for (const pageName of pageNames) {
      const capture = await openPageAndCapture(dashboardTab.id, pageName, "baseline", "baseline", "overall");
      captures.push(capture);
    }

    for (const filter of filterConfig) {
      const filterName = filter.filterName;
      const allLabel = filter.allLabel || "All";
      const options = Array.isArray(filter.options) ? filter.options : [];

      await setStatus(`Starting filter: ${filterName}`);

      for (const option of options) {
        await addLog(`Preparing isolated state for ${filterName} = ${option}`);

        const resetResp = await sendToTab(dashboardTab.id, {
          type: "resetFilter",
          filterName,
          allLabel
        });
        await addLog(resetResp?.note || `Reset attempted for ${filterName}`);
        await sleep(1500);

        const applyResp = await sendToTab(dashboardTab.id, {
          type: "applyFilterOption",
          filterName,
          optionLabel: option,
          allLabel
        });
        await addLog(applyResp?.note || `Apply attempted for ${filterName} = ${option}`);
        await sleep(1800);

        for (const pageName of pageNames) {
          const capture = await openPageAndCapture(dashboardTab.id, pageName, "filtered", filterName, option);
          captures.push(capture);
        }
      }

      await addLog(`Final reset of ${filterName} to ${allLabel}`);
      const finalReset = await sendToTab(dashboardTab.id, {
        type: "resetFilter",
        filterName,
        allLabel
      });
      await addLog(finalReset?.note || `Final reset attempted for ${filterName}`);
      await sleep(1500);
    }

    await setStatus("Sending captures to backend for chart extraction, strategic report, and chat dataset build...");

    const result = await callBackendAnalyze(backendUrl, {
      clientName,
      dashboardUrl,
      pages: pageNames,
      filters: filterConfig,
      captures
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
    await setStorage({
      isRunning: false,
      runStatus: `Run failed: ${err.message}`,
      lastError: err.message
    });
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
    startSweep(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === "resetLogs") {
    resetRunLog()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
