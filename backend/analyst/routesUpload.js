const express = require("express");
const router = express.Router();

const { createRun, addFileToRun, finishRun, getLatestRun, getRun } = require("./store");

router.post("/upload/start", (req, res) => {
  try {
    const { workspaceName, clientName, operatorName } = req.body || {};
    if (!workspaceName) return res.status(400).json({ ok: false, error: "workspaceName is required" });

    const run = createRun({ workspaceName, clientName, operatorName });
    return res.json({
      ok: true,
      runId: run.runId,
      stateId: run.runId,
      status: run.status,
      statusUrl: `/analyst/analyze/status?workspaceName=${encodeURIComponent(workspaceName)}&runId=${encodeURIComponent(run.runId)}`,
      reportUrl: `/analyst/report/run?workspaceName=${encodeURIComponent(workspaceName)}&runId=${encodeURIComponent(run.runId)}`,
      latestDataUrl: `/analyst/upload/latest?workspaceName=${encodeURIComponent(workspaceName)}`,
      run
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to create run" });
  }
});

router.post("/upload/file", (req, res) => {
  try {
    const { workspaceName, runId, fileName, page, comparisonMode, filterType, filterValue, note, dataUrl } = req.body || {};
    if (!workspaceName) return res.status(400).json({ ok: false, error: "workspaceName is required" });
    if (!runId) return res.status(400).json({ ok: false, error: "runId is required" });
    if (!dataUrl) return res.status(400).json({ ok: false, error: "dataUrl is required" });
    if (!page) return res.status(400).json({ ok: false, error: "page is required" });

    const run = addFileToRun({
      workspaceName,
      runId,
      fileName,
      page,
      comparisonMode,
      filterType,
      filterValue,
      note,
      dataUrl
    });

    return res.json({
      ok: true,
      runId,
      fileCount: run.files.length,
      latestFile: run.files[run.files.length - 1]
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to upload screenshot" });
  }
});

router.post("/upload/finish", (req, res) => {
  try {
    const { workspaceName, runId } = req.body || {};
    if (!workspaceName) return res.status(400).json({ ok: false, error: "workspaceName is required" });
    if (!runId) return res.status(400).json({ ok: false, error: "runId is required" });

    const run = finishRun({ workspaceName, runId });
    return res.json({
      ok: true,
      runId,
      stateId: runId,
      run,
      statusUrl: `/analyst/analyze/status?workspaceName=${encodeURIComponent(workspaceName)}&runId=${encodeURIComponent(runId)}`,
      reportUrl: `/analyst/report/run?workspaceName=${encodeURIComponent(workspaceName)}&runId=${encodeURIComponent(runId)}`,
      latestDataUrl: `/analyst/upload/latest?workspaceName=${encodeURIComponent(workspaceName)}`
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to finish upload" });
  }
});

router.get("/upload/latest", (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const run = getLatestRun(workspaceName);
    return res.json({ ok: true, workspaceName, latest: run || null });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch latest upload" });
  }
});

router.get("/upload/run", (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const runId = req.query.runId;
    if (!runId) return res.status(400).json({ ok: false, error: "runId is required" });
    const run = getRun(workspaceName, runId);
    if (!run) return res.status(404).json({ ok: false, error: "Run not found" });
    return res.json({ ok: true, workspaceName, run });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch run" });
  }
});

module.exports = router;
