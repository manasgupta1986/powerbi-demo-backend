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

function renderMessage(role, content) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = content;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

async function persistChatHistory(history) {
  await chrome.storage.local.set({ chatHistory: history });
}

async function getChatHistory() {
  const { chatHistory } = await chrome.storage.local.get(["chatHistory"]);
  return Array.isArray(chatHistory) ? chatHistory : [];
}

function drawChat(history) {
  const box = $("chatMessages");
  box.innerHTML = "";
  if (!history.length) {
    renderMessage("assistant", "Ask questions about the captured dashboard data. I will answer only from the stored screenshots-derived dataset.");
    return;
  }
  history.forEach((m) => renderMessage(m.role, m.content));
}

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

  const history = await getChatHistory();
  drawChat(history);
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
    .map((s) => s.trim())
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
  await chrome.tabs.create({ url: `${cleanUrl}/latest-report` });
}

async function sendChat() {
  const question = $("chatInput").value.trim();
  if (!question) return;

  const { backendUrl } = await chrome.storage.local.get(["backendUrl"]);
  if (!backendUrl) {
    alert("Please enter Backend URL first.");
    return;
  }

  const cleanUrl = backendUrl.replace(/\/+$/, "");
  const history = await getChatHistory();
  const nextHistory = [...history, { role: "user", content: question }];
  await persistChatHistory(nextHistory);
  drawChat(nextHistory);
  $("chatInput").value = "";

  const response = await fetch(`${cleanUrl}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      history: nextHistory
    })
  });

  const json = await response.json();
  const answer = response.ok && json.ok
    ? json.answer
    : (json.error || "The chat request failed.");

  const finalHistory = [...nextHistory, { role: "assistant", content: answer }];
  await persistChatHistory(finalHistory);
  drawChat(finalHistory);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettingsIntoForm();

  $("saveBtn").addEventListener("click", saveSettings);
  $("loadLatestBtn").addEventListener("click", loadLatestSavedRun);
  $("openReportBtn").addEventListener("click", openLatestSavedReport);
  $("runSweepBtn").addEventListener("click", runNewSweep);
  $("sendChatBtn").addEventListener("click", sendChat);

  $("chatInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      sendChat();
    }
  });

  setInterval(refreshStatusFromStorage, 1500);
});
