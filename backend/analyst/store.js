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

function addFileToRun({ workspaceName, runId, fileName, page, filterType, filterValue, note, dataUrl }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);
  if (idx === -1) throw new Error("Run not found");

  const saved = saveBase64Image({ workspaceName, runId, fileName, dataUrl });
  const fileRecord = {
    fileId: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fileName: fileName || saved.storedFileName,
    storedFileName: saved.storedFileName,
    imagePath: saved.imagePath,
    publicPath: saved.publicPath,
    page: page || "",
    filterType: filterType || "",
    filterValue: filterValue || "",
    note: note || "",
    uploadedAt: new Date().toISOString()
  };

  runs[idx].files.push(fileRecord);
  runs[idx].fileCount = runs[idx].files.length;
  runs[idx].status = "collecting";
  runs[idx].progress = {
    ...(runs[idx].progress || defaultProgress()),
    phase: "collecting",
    message: `${runs[idx].fileCount} screenshot(s) added`,
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
  const summary = typeof analysis.summary === "string" ? analysis.summary.trim() : "";
  return numericRows > 0 || textRows > 0 || summary.length > 0;
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
