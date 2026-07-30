const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default-workspace";
}

function safeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "file";
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function parseStructuredFilename(fileName, fallbackPage, fallbackFilterType, fallbackFilterValue) {
  const stem = String(path.parse(fileName || "").name || "").trim();
  const cleanedStem = stem.replace(/\s+/g, " " ).trim();
  const sequenceMatch = cleanedStem.match(/(?:^|[ _-])(\d{1,3})$/);
  const sequence = sequenceMatch ? Number(sequenceMatch[1]) : null;
  const stemWithoutSequence = sequenceMatch ? cleanedStem.slice(0, sequenceMatch.index).trim().replace(/[ _-]+$/, "") : cleanedStem;
  const rawParts = stemWithoutSequence.includes("__")
    ? stemWithoutSequence.split("__")
    : stemWithoutSequence.split(/_(?=[A-Za-z])/g);
  const parts = rawParts.map((part) => String(part || "").trim()).filter(Boolean);
  const section = parts[0] || fallbackPage || "";
  const filterPart = parts.slice(1).find(Boolean) || "";
  const filterText = normalizeToken(filterPart);

  let inferredFilterType = fallbackFilterType || "";
  let inferredFilterValue = fallbackFilterValue || "";

  if (/^all zones?$/.test(filterText)) {
    inferredFilterType = inferredFilterType || "Zone";
    inferredFilterValue = inferredFilterValue || "All";
  } else {
    const patterns = [
      [/^zone (.+)$/i, "Zone"],
      [/^nccs (.+)$/i, "NCCS"],
      [/^tier (.+)$/i, "Tier"],
      [/^gender (.+)$/i, "Gender"],
      [/^age band (.+)$/i, "Age Band"]
    ];
    for (const [pattern, label] of patterns) {
      const match = filterText.match(pattern);
      if (!match) continue;
      inferredFilterType = inferredFilterType || label;
      inferredFilterValue = inferredFilterValue || String(match[1] || "").trim();
      break;
    }
  }

  const normalizedPage = section || fallbackPage || "";
  const normalizedFilterType = inferredFilterType || "";
  const normalizedFilterValue = inferredFilterValue || "";
  const groupKey = slugify([normalizedPage, normalizedFilterType, normalizedFilterValue].filter(Boolean).join("__") || normalizedPage || stemWithoutSequence || fileName || "group");

  return {
    normalizedPage,
    normalizedFilterType,
    normalizedFilterValue,
    groupKey,
    groupSequence: Number.isFinite(sequence) ? sequence : null,
    parsedFromFileName: Boolean(parts.length || sequenceMatch),
    fileStem: stemWithoutSequence
  };
}

function getWorkspaceParts(workspaceName) {
  const workspaceKey = slugify(workspaceName || "default-workspace");
  const workspaceDir = path.join(DATA_DIR, "analyst", workspaceKey);
  const uploadsDir = path.join(workspaceDir, "uploads");
  const analysisDir = path.join(workspaceDir, "analysis");
  ensureDir(workspaceDir);
  ensureDir(uploadsDir);
  ensureDir(analysisDir);
  return { workspaceKey, workspaceDir, uploadsDir, analysisDir };
}

function getRunsFile(workspaceName) {
  const { workspaceDir } = getWorkspaceParts(workspaceName);
  return path.join(workspaceDir, "runs.json");
}

function getAnalysisFile(workspaceName, runId) {
  const { analysisDir } = getWorkspaceParts(workspaceName);
  return path.join(analysisDir, `${runId}.json`);
}

function getExtensionFromDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || "");
  const mime = match ? match[1] : "image/png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".png";
}

function defaultProgress() {
  return {
    phase: "idle",
    message: "Waiting to start",
    estimatedSecondsRemaining: null,
    currentFileName: null,
    currentFileIndex: 0,
    totalFiles: 0,
    currentSliceIndex: 0,
    totalSlicesForFile: 0,
    processedSlices: 0,
    totalSlices: 0,
    currentBatchIndex: 0,
    totalBatches: 0,
    updatedAt: new Date().toISOString()
  };
}

function createRun({ workspaceName, clientName = "", operatorName = "" }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const run = {
    runId: `run_${Date.now()}`,
    workspaceName: workspaceName || "default-workspace",
    clientName,
    operatorName,
    status: "started",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    fileCount: 0,
    numericRowCount: 0,
    textRowCount: 0,
    timeHintCount: 0,
    topInsightCount: 0,
    hasUsableData: false,
    progress: defaultProgress(),
    files: []
  };
  runs.unshift(run);
  writeJson(runsFile, runs);
  return run;
}

function listRuns(workspaceName, limit = 20) {
  return readJson(getRunsFile(workspaceName), []).slice(0, limit);
}

function getLatestRun(workspaceName) {
  return listRuns(workspaceName, 1)[0] || null;
}

function getRun(workspaceName, runId) {
  return readJson(getRunsFile(workspaceName), []).find((run) => run.runId === runId) || null;
}

function saveBase64Image({ workspaceName, runId, fileName, dataUrl }) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw new Error("Invalid image dataUrl");
  }

  const { uploadsDir } = getWorkspaceParts(workspaceName);
  const runDir = path.join(uploadsDir, runId);
  ensureDir(runDir);

  const ext = getExtensionFromDataUrl(dataUrl);
  const baseName = safeFilePart(path.parse(fileName || `upload_${Date.now()}`).name);
  const storedFileName = `${Date.now()}_${baseName}${ext}`;
  const imagePath = path.join(runDir, storedFileName);
  const base64 = dataUrl.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  fs.writeFileSync(imagePath, Buffer.from(base64, "base64"));

  return {
    storedFileName,
    imagePath,
    publicPath: `/static/analyst/${slugify(workspaceName)}/uploads/${runId}/${storedFileName}`
  };
}


function addFileToRun({ workspaceName, runId, fileName, page, comparisonMode, filterType, filterValue, note, dataUrl }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);
  if (idx === -1) throw new Error("Run not found");

  const saved = saveBase64Image({ workspaceName, runId, fileName, dataUrl });
  const normalizedComparisonMode = comparisonMode === "baseline" ? "baseline" : "cut";
  const parsedName = parseStructuredFilename(fileName, page, filterType, filterValue);
  const parsedAllZones = parsedName.normalizedFilterType === "Zone" && parsedName.normalizedFilterValue === "All";
  const resolvedPage = page || parsedName.normalizedPage || "";
  const resolvedFilterType = parsedAllZones ? "Zone" : (filterType || parsedName.normalizedFilterType || (normalizedComparisonMode === "baseline" ? "Baseline" : ""));
  const resolvedFilterValue = parsedAllZones ? "All" : (filterValue || parsedName.normalizedFilterValue || (normalizedComparisonMode === "baseline" ? "Overall" : ""));
  const fileRecord = {
    fileId: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fileName: fileName || saved.storedFileName,
    storedFileName: saved.storedFileName,
    imagePath: saved.imagePath,
    publicPath: saved.publicPath,
    page: resolvedPage,
    comparisonMode: normalizedComparisonMode,
    filterType: resolvedFilterType,
    filterValue: resolvedFilterValue,
    note: note || "",
    groupKey: parsedName.groupKey,
    groupSequence: parsedName.groupSequence,
    parsedFromFileName: parsedName.parsedFromFileName,
    fileStem: parsedName.fileStem,
    uploadedAt: new Date().toISOString()
  };

  runs[idx].files.push(fileRecord);
  runs[idx].files.sort((a, b) => {
    const left = Number.isFinite(Number(a.groupSequence)) ? Number(a.groupSequence) : Number.MAX_SAFE_INTEGER;
    const right = Number.isFinite(Number(b.groupSequence)) ? Number(b.groupSequence) : Number.MAX_SAFE_INTEGER;
    if (a.groupKey === b.groupKey && left !== right) return left - right;
    if (a.groupKey !== b.groupKey) return String(a.groupKey || "").localeCompare(String(b.groupKey || ""));
    return String(a.fileName || "").localeCompare(String(b.fileName || ""));
  });
  runs[idx].fileCount = runs[idx].files.length;
  runs[idx].status = "collecting";
  runs[idx].progress = {
    ...(runs[idx].progress || defaultProgress()),
    phase: "collecting",
    message: `${runs[idx].fileCount} screenshot(s) added across ${new Set(runs[idx].files.map((file) => file.groupKey || file.page || file.fileName)).size} group(s)`,
    totalFiles: runs[idx].fileCount,
    updatedAt: new Date().toISOString()
  };
  writeJson(runsFile, runs);
  return runs[idx];
}

function finishRun({ workspaceName, runId }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);
  if (idx === -1) throw new Error("Run not found");

  runs[idx].status = "upload_complete";
  runs[idx].progress = {
    ...(runs[idx].progress || defaultProgress()),
    phase: "upload_complete",
    message: `${runs[idx].files.length} screenshot(s) ready for analysis`,
    totalFiles: runs[idx].files.length,
    updatedAt: new Date().toISOString()
  };
  writeJson(runsFile, runs);
  return runs[idx];
}

function updateRunStatus({ workspaceName, runId, status, error = null }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);
  if (idx === -1) throw new Error("Run not found");

  runs[idx].status = status;
  runs[idx].error = error;
  if (status === "failed") {
    runs[idx].progress = {
      ...(runs[idx].progress || defaultProgress()),
      phase: "failed",
      message: error || "Analysis failed",
      estimatedSecondsRemaining: null,
      updatedAt: new Date().toISOString()
    };
  }
  writeJson(runsFile, runs);
  return runs[idx];
}

function updateRunProgress({ workspaceName, runId, progress }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);
  if (idx === -1) throw new Error("Run not found");

  runs[idx].progress = {
    ...(runs[idx].progress || defaultProgress()),
    ...(progress || {}),
    updatedAt: new Date().toISOString()
  };
  writeJson(runsFile, runs);
  return runs[idx];
}

function computeUsability(analysis) {
  if (!analysis) return false;
  const numericRows = Array.isArray(analysis.numeric_rows) ? analysis.numeric_rows.length : 0;
  const textRows = Array.isArray(analysis.text_rows) ? analysis.text_rows.length : 0;
  const timeHints = Array.isArray(analysis.time_hints) ? analysis.time_hints.length : 0;
  const topInsights = Array.isArray(analysis.report?.top_insights) ? analysis.report.top_insights.length : 0;
  const summary = typeof analysis.summary === "string" ? analysis.summary.trim() : "";
  return numericRows > 0 || textRows > 0 || timeHints > 0 || topInsights > 0 || summary.length > 0;
}

function saveAnalysis({ workspaceName, runId, analysis }) {
  writeJson(getAnalysisFile(workspaceName, runId), analysis);
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);
  if (idx !== -1) {
    runs[idx].status = "completed";
    runs[idx].error = null;
    runs[idx].finishedAt = new Date().toISOString();
    runs[idx].numericRowCount = Array.isArray(analysis.numeric_rows) ? analysis.numeric_rows.length : 0;
    runs[idx].textRowCount = Array.isArray(analysis.text_rows) ? analysis.text_rows.length : 0;
    runs[idx].timeHintCount = Array.isArray(analysis.time_hints) ? analysis.time_hints.length : 0;
    runs[idx].topInsightCount = Array.isArray(analysis.report?.top_insights) ? analysis.report.top_insights.length : 0;
    runs[idx].hasUsableData = computeUsability(analysis);
    runs[idx].progress = {
      ...(runs[idx].progress || defaultProgress()),
      phase: "completed",
      message: runs[idx].hasUsableData ? "Analysis completed with usable data" : "Analysis completed but needs review",
      estimatedSecondsRemaining: 0,
      updatedAt: new Date().toISOString()
    };
    writeJson(runsFile, runs);
  }
  return analysis;
}

function getAnalysis(workspaceName, runId) {
  return readJson(getAnalysisFile(workspaceName, runId), null);
}

function getLatestCompletedAnalysis(workspaceName) {
  const runs = listRuns(workspaceName, 50);
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const analysis = getAnalysis(workspaceName, run.runId);
    if (analysis) return { run, analysis };
  }
  return null;
}

module.exports = {
  createRun,
  listRuns,
  getLatestRun,
  getRun,
  addFileToRun,
  finishRun,
  updateRunStatus,
  updateRunProgress,
  saveAnalysis,
  getAnalysis,
  getLatestCompletedAnalysis
};
