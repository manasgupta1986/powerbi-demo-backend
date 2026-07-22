async function appendRunLog(line) {
  const existing = await chrome.storage.local.get(['runLog']);
  const runLog = Array.isArray(existing.runLog) ? existing.runLog : [];
  runLog.push(`${new Date().toLocaleTimeString()} ${line}`);
  await chrome.storage.local.set({ runLog: runLog.slice(-200) });
}

async function setStatus(runStatus, lastSummary = undefined) {
  const update = { runStatus };
  if (lastSummary !== undefined) update.lastSummary = lastSummary;
  await chrome.storage.local.set(update);
  await appendRunLog(runStatus);
}

async function openSidePanelForTab(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (e) {
    console.warn('Could not open side panel', e?.message || e);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBackendUrl(url) {
  return (url || '').trim().replace(/\/$/, '');
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await sleep(1000);
  } catch (err) {
    console.warn('Content script injection warning:', err?.message || err);
  }
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Dashboard tab load timed out'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openOrReuseDashboardTab(dashboardUrl) {
  const tabs = await chrome.tabs.query({ url: ['https://app.powerbi.com/*'] });
  let target = tabs.find(tab => tab.url === dashboardUrl);

  if (!target) {
    target = await chrome.tabs.create({ url: dashboardUrl, active: true });
    await waitForTabComplete(target.id);
    await sleep(5000);
  } else {
    await chrome.tabs.update(target.id, { active: true, url: dashboardUrl });
    await waitForTabComplete(target.id);
    await sleep(4000);
  }

  await ensureContentScript(target.id);
  return target;
}

async function sendSweepToTab(tabId, payload) {
  await ensureContentScript(tabId);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        action: 'runFilterSweep',
        pageNames: payload.pageNames,
        timeFilterText: payload.timeFilterText,
        filters: payload.filters
      });
      if (result) return result;
    } catch (err) {
      const message = String(err?.message || err || '');
      await appendRunLog(`Message attempt ${attempt} failed: ${message}`);

      if (message.includes('Receiving end does not exist')) {
        await ensureContentScript(tabId);
      }

      if (attempt === 3) throw err;
      await sleep(2500);
    }
  }

  throw new Error('Could not communicate with the dashboard tab');
}

async function startSweep(payload) {
  const backendUrl = normalizeBackendUrl(payload.backendUrl);
  if (!backendUrl) throw new Error('Backend URL missing');

  await chrome.storage.local.set({ runLog: [], latestRunMeta: null, lastSummary: '' });
  await setStatus('Status: opening dashboard tab for visible screenshot sweep...');
  await appendRunLog('Important: keep the Power BI dashboard tab visible while the screenshot sweep runs.');
  const dashboardTab = await openOrReuseDashboardTab(payload.dashboardUrl);

  await setStatus('Status: dashboard opened. Starting screenshot sweep...');
  const captureResponse = await sendSweepToTab(dashboardTab.id, payload);

  if (!captureResponse?.ok) {
    throw new Error(captureResponse?.error || 'Dashboard capture failed');
  }

  const count = captureResponse.captures?.length || 0;
  await setStatus(`Status: ${count} captures collected. Generating summary report...`);

  const response = await fetch(`${backendUrl}/run-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: payload.clientName,
      dashboardUrl: payload.dashboardUrl,
      captures: captureResponse.captures,
      meta: {
        pageNames: payload.pageNames,
        timeFilterText: payload.timeFilterText,
        filters: payload.filters
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend error: ${text}`);
  }

  const data = await response.json();

  try {
    const latestResponse = await fetch(`${backendUrl}/latest-data`);
    const latestRunMeta = await latestResponse.json();
    await chrome.storage.local.set({ latestRunMeta });
  } catch (e) {
    await appendRunLog(`Could not refresh latest saved run metadata: ${e?.message || e}`);
  }

  await setStatus('Status: analysis complete. Summary report ready.', data.summary || 'Summary created');
  return data;
}

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onStartup?.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    await openSidePanelForTab(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openSidePanel') {
    const tabId = sender?.tab?.id || message.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab available' });
      return;
    }
    openSidePanelForTab(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'captureVisibleState') {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 45 }, async (dataUrl) => {
      const err = chrome.runtime.lastError;
      if (err) {
        await setStatus(`Status: screenshot capture failed. ${err.message}`);
        sendResponse({ ok: false, error: err.message });
        return;
      }
      sendResponse({ ok: true, imageDataUrl: dataUrl });
    });
    return true;
  }

  if (message.action !== 'startSweep') return;

  startSweep(message.payload)
    .then(() => sendResponse({ ok: true }))
    .catch(async err => {
      await setStatus(`Status: run failed. ${err.message}`);
      sendResponse({ ok: false, error: err.message });
    });

  return true;
});
