const express = require("express");
const router = express.Router();

const {
  createRun,
  getLatestRun,
  addFileToRun,
  finishRun
} = require("./store");

router.post("/upload/start", async (req, res) => {
  try {
    const { workspaceName, clientName, operatorName } = req.body || {};

    const run = createRun({
      workspaceName: workspaceName || "default-workspace",
      clientName: clientName || "",
      operatorName: operatorName || ""
    });

    return res.json({
      ok: true,
      runId: run.runId,
      status: run.status,
      workspaceName: run.workspaceName,
      createdAt: run.createdAt
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to start upload session"
    });
  }
});

router.post("/upload/file", async (req, res) => {
  try {
    const {
      workspaceName,
      runId,
      fileName,
      page,
      filterType,
      filterValue,
      note
    } = req.body || {};

    if (!workspaceName) {
      return res.status(400).json({
        ok: false,
        error: "workspaceName is required"
      });
    }

    if (!runId) {
      return res.status(400).json({
        ok: false,
        error: "runId is required"
      });
    }

    const run = addFileToRun({
      workspaceName,
      runId,
      fileName,
      page,
      filterType,
      filterValue,
      note
    });

    return res.json({
      ok: true,
      runId,
      status: run.status,
      fileCount: run.files.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to save uploaded file metadata"
    });
  }
});

router.post("/upload/finish", async (req, res) => {
  try {
    const { workspaceName, runId } = req.body || {};

    if (!workspaceName) {
      return res.status(400).json({
        ok: false,
        error: "workspaceName is required"
      });
    }

    if (!runId) {
      return res.status(400).json({
        ok: false,
        error: "runId is required"
      });
    }

    const run = finishRun({ workspaceName, runId });

    return res.json({
      ok: true,
      runId,
      status: run.status,
      finishedAt: run.finishedAt,
      fileCount: run.files.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to finish upload session"
    });
  }
});

router.get("/upload/latest", async (req, res) => {
  try {
    const workspaceName =
      req.query.workspaceName || "default-workspace";

    const latestRun = getLatestRun(workspaceName);

    return res.json({
      ok: true,
      workspaceName,
      latestRun: latestRun || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch latest upload session"
    });
  }
});

module.exports = router;
