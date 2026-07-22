function $(id) {
  return document.getElementById(id);
}

const DEFAULT_FILTER_JSON = `[
  {
    "filterName": "Gender",
    "allLabel": "Select All",
    "options": ["Male", "Female"]
  }
]`;

async function loadSettingsIntoForm() {
  const data = await chrome.storage.local.get([
    "clientName",
    "dashboardUrl",
    "backendUrl",
    "pageNamesRaw",
    "filterConfigRaw",
    "runStatus",
    "runLog",
    "lastSummary"
  ]);

  $("clientName").value = data.clientName || "";
  $("dashboardUrl").value = data.dashboardUrl || "";
  $("backendUrl").value = data.backendUrl || "";
  $("pageNames").value = data.pageNamesRaw || "";
  $("filterConfig").value = data.filterConfigRaw || DEFAULT_FILTER_JSON;

  renderStatus(data.runStatus || "Idle", data.runLog || []);
  $("summaryBox").textContent = data.lastSummary || "No saved summary loaded yet.";
}

async function saveSettings() {
  const clientName = $("clientName").value.trim();
  const dashboardUrl = $("dashboardUrl").value.trim();
  const backendUrl = $("backendUrl").value.trim();
  const pageNamesRaw = $("pageNames").value.trim();
  const filterConfigRaw = $("filterConfig").value.trim();

  let filterConfig = [];
  try {
    filterConfig = JSON.parse(filterConfigRaw);
  } catch (err) {
    alert("Filter sweep config JSON is invalid. Please fix it before saving.");
    throw err;
  }

  const pageNames = pageNamesRaw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  await chrome.storage.local.set({
    clientName,
    dashboardUrl,
    backendUrl,
    pageNamesRaw,
    pageNames,
    filterConfigRaw,
    filterConfig
  });

  alert("Settings saved.");
}

function renderStatus(status, runLog) {
  const logText = Array.isArray(runLog) ? runLog.join("\n") : "";
  $("statusBox").textContent = `${status || "Idle"}\n\n${logText}`;
}

async function refreshStatusFromStorage() {
  const data = await chrome.storage.local.get([
    "runStatus",
    "runLog",
    "lastSummary"
  ]);

  renderStatus(data.runStatus || "Idle", data.runLog || []);
  $("summaryBox").textContent = data.lastSummary || $("summaryBox").textContent;
}

async function runNewSweep() {
  await saveSettings();

  const data = await chrome.storage.local.get([
    "clientName",
    "dashboardUrl",
    "backendUrl",
    "pageNames",
    "filterConfig"
  ]);

  chrome.runtime.sendMessage({
    type: "startSweep",
    payload: {
      clientName: data.clientName || "",
      dashboardUrl: data.dashboardUrl || "",
      backendUrl: data.backendUrl || "",
      pageNames: data.pageNames || [],
      filterConfig: data.filterConfig || []
    }
  });
}

async function loadLatestSavedRun() {
  await saveSettings();

  const { backendUrl } = await chrome.storage.local.get(["backendUrl"]);
  if (!backendUrl) {
    alert("Please enter Backend URL first.");
    return;
  }

  const cleanUrl = backendUrl.replace(/\/+$/, "");
  const response = await fetch(`${cleanUrl}/latest-data`);
  const json = await response.json();

  if (!response.ok || !json.ok) {
    alert(json.error || "Could not load latest saved run.");
    return;
  }

  const data = json.data || {};
  const summary = data.summary || "No summary found.";

  await chrome.storage.local.set({
    lastSummary: summary,
    lastLoadedRun: data,
    lastRunAt: data.createdAt || ""
  });

  $("summaryBox").textContent = summary;
  alert("Latest saved run loaded.");
}

async function openLatestSavedReport() {
  await saveSettings();

  const { backendUrl } = await chrome.storage.local.get(["backendUrl"]);
  if (!backendUrl) {
    alert("Please enter Backend URL first.");
    return;
  }

  const cleanUrl = backendUrl.replace(/\/+$/, "");
  await chrome.tabs.create({
    url: `${cleanUrl}/latest-report`
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettingsIntoForm();

  $("saveBtn").addEventListener("click", saveSettings);
  $("loadLatestBtn").addEventListener("click", loadLatestSavedRun);
  $("openReportBtn").addEventListener("click", openLatestSavedReport);
  $("runSweepBtn").addEventListener("click", runNewSweep);

  setInterval(refreshStatusFromStorage, 1500);
});
