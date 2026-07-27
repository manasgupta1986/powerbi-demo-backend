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
  ensureDir(workspaceDir);
  ensureDir(uploadsDir);
  return { workspaceKey, workspaceDir, uploadsDir };
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
    fileCount: 0,
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

function getRun(workspaceName, runId) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  return runs.find((run) => run.runId === runId) || null;
}

function getExtensionFromDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || "");
  const mime = match ? match[1] : "image/png";

  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".png";
}

function saveBase64Image({ workspaceName, runId, fileName, dataUrl }) {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw new Error("Invalid image dataUrl");
  }

  const { uploadsDir } = getWorkspaceParts(workspaceName);
  const ext = getExtensionFromDataUrl(dataUrl);
  const baseName = safeFilePart(path.parse(fileName || "upload").name);
  const storedFileName = `${runId}_${Date.now()}_${baseName}${ext}`;
  const filePath = path.join(uploadsDir, storedFileName);

  const base64 = dataUrl.split(",")[1];
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));

  return {
    storedFileName,
    filePath
  };
}

function addFileToRun({
  workspaceName,
  runId,
  fileName,
  page,
  filterType,
  filterValue,
  note,
  dataUrl
}) {
  const runsFile = getRunsFile(workspaceName);
  const runs = readJson(runsFile, []);
  const idx = runs.findIndex((run) => run.runId === runId);

  if (idx === -1) {
    throw new Error("Run not found");
  }

  const savedImage = saveBase64Image({
    workspaceName,
    runId,
    fileName,
    dataUrl
  });

  runs[idx].files.push({
    fileName: fileName || "",
    storedFileName: savedImage.storedFileName,
    imagePath: savedImage.filePath,
    page: page || "",
    filterType: filterType || "",
    filterValue: filterValue || "",
    note: note || "",
    uploadedAt: new Date().toISOString()
  });

  runs[idx].fileCount = runs[idx].files.length;

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
  getRun,
  addFileToRun,
  finishRun
};
