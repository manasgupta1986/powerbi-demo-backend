const qs = id => document.getElementById(id);

async function getSettings() {
  return await chrome.storage.local.get([
    'clientName',
    'dashboardUrl',
    'backendUrl',
    'pageNames',
    'timeFilterText',
    'filterConfig',
    'runStatus',
    'lastSummary',
    'latestRunMeta',
    'runLog'
  ]);
}

function normalizeBackendUrl(url) {
  return (url || '').trim().replace(/\/$/, '');
}

function renderLatestInfo(latest) {
  if (!latest || !latest.createdAt) {
    qs('latestInfo').textContent = 'No saved run found yet. Run the morning sweep first, then use Load latest saved run before the client meeting.';
    return;
  }

  const uniqueFilters = [...new Set((latest.captures || []).map(x => x.filterName).filter(Boolean))];
  const uniqueTabs = [...new Set((latest.captures || []).map(x => x.pageName).filter(Boolean))];
  qs('latestInfo').textContent = [
    `Latest saved run: ${latest.createdAt}`,
    `Client: ${latest.clientName || 'Unknown'}`,
    `Tabs covered: ${uniqueTabs.join(', ') || 'Unknown'}`,
    `Filters covered: ${uniqueFilters.join(', ') || 'Unknown'}`,
    `Saved states: ${(latest.captures || []).length}`,
    latest.reportUrl ? `Saved report: ${latest.reportUrl}` : ''
  ].filter(Boolean).join('\n');
}

async function saveSettingsToStorage() {
  const data = {
    clientName: qs('clientName').value.trim(),
    dashboardUrl: qs('dashboardUrl').value.trim(),
    backendUrl: qs('backendUrl').value.trim(),
    pageNames: qs('pageNames').value.trim(),
    timeFilterText: qs('timeFilterText').value.trim(),
    filterConfig: qs('filterConfig').value.trim()
  };

  try {
    JSON.parse(data.filterConfig || '[]');
  } catch (err) {
    qs('status').textContent = `Status: filter JSON is invalid. ${err.message}`;
    return;
  }

  await chrome.storage.local.set(data);
  qs('status').textContent = 'Status: settings saved';
}

async function refreshRunStatus() {
  const data = await chrome.storage.local.get(['runStatus', 'lastSummary', 'latestRunMeta', 'runLog']);
  if (data.runStatus) qs('status').textContent = data.runStatus;
  if (data.lastSummary) qs('answer').textContent = data.lastSummary;
  if (data.latestRunMeta) renderLatestInfo(data.latestRunMeta);
  qs('runLog').textContent = Array.isArray(data.runLog) && data.runLog.length
    ? data.runLog.join('\n')
    : 'Run log will appear here.';
}

async function loadSettingsIntoForm() {
  const data = await getSettings();
  if (data.clientName) qs('clientName').value = data.clientName;
  if (data.dashboardUrl) qs('dashboardUrl').value = data.dashboardUrl;
  if (data.backendUrl) qs('backendUrl').value = data.backendUrl;
  if (data.pageNames) qs('pageNames').value = data.pageNames;
  if (data.timeFilterText !== undefined) qs('timeFilterText').value = data.timeFilterText;
  if (data.filterConfig) qs('filterConfig').value = data.filterConfig;
  if (data.runStatus) qs('status').textContent = data.runStatus;
  if (data.lastSummary) qs('answer').textContent = data.lastSummary;
  if (data.latestRunMeta) renderLatestInfo(data.latestRunMeta);
  if (Array.isArray(data.runLog) && data.runLog.length) {
    qs('runLog').textContent = data.runLog.join('\n');
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function loadLatestSavedRun() {
  const backendUrl = normalizeBackendUrl(qs('backendUrl').value.trim());
  if (!backendUrl) {
    qs('status').textContent = 'Status: backend URL is required';
    return;
  }

  qs('status').textContent = 'Status: loading latest saved run...';
  const response = await fetch(`${backendUrl}/latest-data`);
  const data = await response.json();

  if (!data || !data.createdAt) {
    qs('status').textContent = 'Status: no saved run found yet';
    qs('latestInfo').textContent = 'No saved run available. Run the sweep once in the morning.';
    return;
  }

  await chrome.storage.local.set({
    latestRunMeta: data,
    runStatus: `Status: latest saved run loaded (${data.createdAt})`,
    lastSummary: data.summary || 'Saved summary loaded'
  });

  renderLatestInfo(data);
  qs('status').textContent = `Status: latest saved run loaded (${data.createdAt})`;
  qs('answer').textContent = data.summary || 'Saved summary loaded';
}

async function runAnalysis() {
  const activeTab = await getActiveTab();
  const pageNames = qs('pageNames').value.split(',').map(x => x.trim()).filter(Boolean);
  const clientName = qs('clientName').value.trim() || 'Client Demo';
  const dashboardUrl = qs('dashboardUrl').value.trim() || activeTab?.url || '';
  const backendUrl = normalizeBackendUrl(qs('backendUrl').value.trim());
  const timeFilterText = qs('timeFilterText').value.trim();

  if (!dashboardUrl) {
    qs('status').textContent = 'Status: dashboard URL is required';
    return;
  }

  if (!backendUrl) {
    qs('status').textContent = 'Status: backend URL is required';
    return;
  }

  let filters = [];
  try {
    filters = JSON.parse(qs('filterConfig').value.trim() || '[]');
  } catch (err) {
    qs('status').textContent = `Status: filter JSON is invalid. ${err.message}`;
    return;
  }

  await chrome.storage.local.set({ runStatus: 'Status: starting new sweep...', lastSummary: '', runLog: [] });
  qs('status').textContent = 'Status: starting new sweep...';
  qs('runLog').textContent = 'Run log will appear here.';

  const response = await chrome.runtime.sendMessage({
    action: 'startSweep',
    payload: {
      clientName,
      dashboardUrl,
      backendUrl,
      pageNames,
      timeFilterText,
      filters
    }
  });

  if (!response?.ok) {
    qs('status').textContent = `Status: could not start sweep. ${response?.error || ''}`;
    return;
  }
}

async function openReport() {
  const backendUrl = normalizeBackendUrl(qs('backendUrl').value.trim());
  if (!backendUrl) {
    qs('status').textContent = 'Status: backend URL is required';
    return;
  }
  chrome.tabs.create({ url: `${backendUrl}/latest-report` });
}

async function askDashboard() {
  const question = qs('question').value.trim();
  const backendUrl = normalizeBackendUrl(qs('backendUrl').value.trim());

  if (!backendUrl) {
    qs('answer').textContent = 'Please enter the backend URL first.';
    return;
  }

  if (!question) {
    qs('answer').textContent = 'Please type a question first.';
    return;
  }

  qs('answer').textContent = 'Thinking...';
  const response = await fetch(`${backendUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  const data = await response.json();
  qs('answer').textContent = data.answer || 'No answer returned';
}

qs('saveSettings').addEventListener('click', saveSettingsToStorage);
qs('loadLatest').addEventListener('click', loadLatestSavedRun);
qs('openReport').addEventListener('click', openReport);
qs('runAnalysis').addEventListener('click', runAnalysis);
qs('askBtn').addEventListener('click', askDashboard);
chrome.storage.onChanged.addListener(() => refreshRunStatus());
setInterval(refreshRunStatus, 2000);
loadSettingsIntoForm();
refreshRunStatus();
