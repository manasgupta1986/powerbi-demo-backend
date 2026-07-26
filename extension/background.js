const STORAGE_KEY = "pb_guided_v1";

const PAGE_OPTIONS = [
  "Traffic Engagement",
  "Purchase Matrix",
  "Purchase Funnel"
];

const FILTER_CONFIG = {
  Zone: ["East", "North", "South", "West"],
  NCCS: ["A", "B"],
  Tier: ["Tier 1", "Tier 2", "Tier 3 & lower"],
  Gender: ["Male", "Female"],
  "Age Band": ["Below 18", "18-24", "25-35", "35-44", "45-54", "55+"]
};

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("sidePanel setPanelBehavior failed:", error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.warn("sidePanel open failed:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || "Unexpected error" });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_UI_STATE":
      return buildUiState(await loadState());
    case "START_GUIDED_RUN":
      return startGuidedRun(message);
    case "CAPTURE_CURRENT_STEP":
      return captureCurrentStep();
    case "SKIP_CURRENT_STEP":
      return skipCurrentStep();
    case "FINISH_RUN":
      return finishRun();
    case "RESET_LOCAL_SESSION":
      await chrome.storage.local.remove(STORAGE_KEY);
      return buildUiState(await loadState());
    default:
      return buildUiState(await loadState());
  }
}

async function startGuidedRun(payload) {
  const clientName = String(payload.clientName || "").trim();
  const backendUrl = String(payload.backendUrl || "").trim();
  const dashboardUrl = String(payload.dashboardUrl || "").trim();

  if (!clientName) throw new Error("Client name is required.");
  if (!backendUrl) throw new Error("Backend URL is required.");

  const state = {
    session: {
      runId: makeRunId(),
      clientName,
      backendUrl,
      dashboardUrl,
      status: "running",
      currentIndex: 0,
      queue: buildQueue(),
      startedAt: new Date().toISOString()
    },
    lastCapture: null
  };

  await saveState(state);
  return buildUiState(state);
}

async function captureCurrentStep() {
  const state = await loadState();
  const session = state.session || {};
  const currentStep = getCurrentStep(state);

  if (!session.runId) throw new Error("No guided run has been started yet.");
  if (session.status === "completed") throw new Error("This run is already complete.");
  if (!currentStep) {
    session.status = "completed";
    await saveState(state);
    return buildUiState(state);
  }
  if (!session.backendUrl) throw new Error("Backend URL is missing.");

  const tab = await findPowerBITab(session.dashboardUrl);
  if (!tab) {
    throw new Error('No Power BI dashboard tab is open. Open the Power BI dashboard tab in this window and try again.');
  }

  await focusTab(tab.id, tab.windowId);
  await sleep(600);

  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const startResponse = await postJson(joinUrl(session.backendUrl, "/capture-state/start"), {
    runId: session.runId,
    clientName: session.clientName,
    dashboardUrl: session.dashboardUrl,
    pageName: currentStep.pageName,
    filterName: currentStep.filterName,
    filterValue: currentStep.filterValue
  });

  const runId = startResponse.runId || session.runId;
  const stateId = startResponse.stateId;

  await postJson(joinUrl(session.backendUrl, "/capture-state/slice"), {
    runId,
    stateId,
    sliceIndex: 0,
    imageBase64: screenshot,
    scrollY: 0
  });

  const finishResponse = await postJson(joinUrl(session.backendUrl, "/capture-state/finish"), {
    runId,
    stateId
  });

  session.runId = runId;
  session.currentIndex = Number(session.currentIndex || 0) + 1;
  if (session.currentIndex >= session.queue.length) session.status = "completed";

  state.lastCapture = {
    runId,
    stateId,
    status: finishResponse.status || "queued",
    statusUrl: finishResponse.statusUrl || "",
    reportUrl: finishResponse.reportUrl || "",
    latestDataUrl: finishResponse.latestDataUrl || "",
    summaryAvailable: false,
    message: "Upload complete. Extraction queued."
  };

  await saveState(state);
  return buildUiState(state);
}

async function skipCurrentStep() {
  const state = await loadState();
  const session = state.session || {};

  if (!session.queue?.length) return buildUiState(state);
  if (session.status === "completed") return buildUiState(state);

  session.currentIndex = Number(session.currentIndex || 0) + 1;
  if (session.currentIndex >= session.queue.length) session.status = "completed";

  await saveState(state);
  return buildUiState(state);
}

async function finishRun() {
  const state = await loadState();
  if (state.session) state.session.status = "completed";
  await saveState(state);
  return buildUiState(state);
}

function buildQueue() {
  const queue = [];
  for (const pageName of PAGE_OPTIONS) {
    for (const [filterName, values] of Object.entries(FILTER_CONFIG)) {
      for (const filterValue of values) {
        queue.push({ pageName, filterName, filterValue });
      }
    }
  }
  return queue;
}

function getCurrentStep(state) {
  const queue = state?.session?.queue || [];
  const idx = Number(state?.session?.currentIndex || 0);
  return queue[idx] || null;
}

function getNextStep(state) {
  const queue = state?.session?.queue || [];
  const idx = Number(state?.session?.currentIndex || 0) + 1;
  return queue[idx] || null;
}

function buildUiState(state) {
  const session = state.session || {};
  const queue = session.queue || [];
  const currentIndex = Number(session.currentIndex || 0);
  const totalSteps = queue.length;
  const completedSteps = Math.min(currentIndex, totalSteps);

  return {
    ok: true,
    session,
    totalSteps,
    completedSteps,
    currentStep: getCurrentStep(state),
    nextStep: getNextStep(state),
    lastCapture: state.lastCapture || null
  };
}

async function loadState() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return data[STORAGE_KEY] || { session: null, lastCapture: null };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function findPowerBITab(dashboardUrl) {
  const tabs = await chrome.tabs.query({});
  const preferredHost = safeHostname(dashboardUrl);

  const preferred = tabs.find((tab) => {
    const url = String(tab.url || "");
    return preferredHost ? url.includes(preferredHost) : false;
  });
  if (preferred) return preferred;

  const fallback = tabs.find((tab) => String(tab.url || "").includes("app.powerbi.com"));
  return fallback || null;
}

async function focusTab(tabId, windowId) {
  if (windowId) {
    await chrome.windows.update(windowId, { focused: true });
  }
  await chrome.tabs.update(tabId, { active: true });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Request failed: ${response.status}`);
  }
  return data;
}

function joinUrl(base, p) {
  if (!p) return base;
  if (/^https?:\/\//i.test(p)) return p;
  return `${String(base).replace(/\/+$/, "")}/${String(p).replace(/^\/+/, "")}`;
}

function makeRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
