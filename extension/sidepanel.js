const STORAGE_KEY = "dm_analyst_console_v2";
const POLL_INTERVAL_MS = 3000;

const DEFAULT_PROMPT = `
Analyze these tagged dashboard screenshots.

For each screenshot:
- identify the visible numerical values
- preserve the page and filter metadata
- if exact values are not printed, estimate them from the axis scale, segment height, total bar height, and legend colors
- do not guess unsupported numbers
- note uncertainties clearly

Then produce:
1. a structured extracted dataset
2. a concise executive summary
3. key findings
4. recommendations
5. data-quality notes
`.trim();

const PAGE_OPTIONS = [
  "Traffic Engagement",
  "Purchase Matrix",
  "Purchase Funnel"
];

const FILTER_OPTIONS = {
  Zone: ["East", "North", "South", "West"],
  NCCS: ["A", "B"],
  Tier: ["Tier 1", "Tier 2", "Tier 3 & lower"],
  Gender: ["Male", "Female"],
  "Age Band": ["Below 18", "18-24", "25-35", "35-44", "45-54", "55+"]
};

const state = {
  settings: {
    backendUrl: "https://powerbi-demo-backend.onrender.com",
    workspaceName: "default-workspace",
    clientName: "",
    operatorName: "",
    defaultPage: "Traffic Engagement",
    defaultFilterType: "Zone",
    promptOverride: DEFAULT_PROMPT,
    promptCollapsed: false
  },
  activeTab: "tab-collect",
  queue: [],
  currentRunId: null,
  selectedReportRunId: null,
  uploadInProgress: false,
  analysisInProgress: false,
  latestStatus: null,
  latestReportPayload: null,
  runHistory: [],
  chatByRun: {}
};

const els = {};

document.addEventListener("DOMContentLoaded", async () => {
  cacheDom();
  bindEvents();
  await loadState();
  applyStateToDom();
  renderAll();

  await checkBackend();
  await refreshRunHistory();

  if (!state.currentRunId) {
    autoSelectBestRun();
  }

  if (state.currentRunId) {
    await refreshAnalysisStatusSilently();
  }

  await refreshReportForSelectedRun();
  renderAll();
});

function cacheDom() {
  Object.assign(els, {
    backendStatus: document.getElementById("backendStatus"),
    workspaceBadge: document.getElementById("workspaceBadge"),
    backendUrl: document.getElementById("backendUrl"),
    workspaceName: document.getElementById("workspaceName"),
    clientName: document.getElementById("clientName"),
    operatorName: document.getElementById("operatorName"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    checkBackendBtn: document.getElementById("checkBackendBtn"),

    currentRunStatus: document.getElementById("currentRunStatus"),
    currentRunSummary: document.getElementById("currentRunSummary"),
    startNewRunBtn: document.getElementById("startNewRunBtn"),
    continueLatestBtn: document.getElementById("continueLatestBtn"),

    queueCount: document.getElementById("queueCount"),
    defaultPage: document.getElementById("
