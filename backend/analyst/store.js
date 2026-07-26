const fs = require("fs");
const path = require("path");

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "..", "data");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
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

function getWorkspaceParts(workspaceName) {
  const workspaceKey = slugify(workspaceName || "default-workspace");
  const workspaceDir = path.join(DATA_DIR, "analyst", workspaceKey);
  ensureDir(workspaceDir);
  return { workspaceKey, workspaceDir };
}

function getRunsFile(workspaceName) {
  const { workspaceDir } = getWorkspaceParts(workspaceName);
  return path.join(workspaceDir, "runs.json");
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
    files: []
  };

  runs.unshift(run);
  writeJson(runsFile, runs);
  return run;
}

function getLatestRun(workspaceName) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  return runs.length ? runs[0] : null;
}

function addFileToRun({
  workspaceName,
  runId,
  fileName,
  page,
  filterType,
  filterValue,
  note
}) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);

  if (idx === -1) {
    throw new Error("Run not found");
  }

  runs[idx].files.push({
    fileName: fileName || "",
    page: page || "",
    filterType: filterType || "",
    filterValue: filterValue || "",
    note: note || "",
    uploadedAt: new Date().toISOString()
  });

  writeJson(runsFile, runs);
  return runs[idx];
}

function finishRun({ workspaceName, runId }) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);

  if (idx === -1) {
    throw new Error("Run not found");
  }

  runs[idx].status = "upload_complete";
  runs[idx].finishedAt = new Date().toISOString();

  writeJson(runsFile, runs);
  return runs[idx];
}

module.exports = {
  createRun,
  getLatestRun,
  addFileToRun,
  finishRun
};
