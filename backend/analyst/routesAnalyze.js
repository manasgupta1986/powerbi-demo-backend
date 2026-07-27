const express = require("express");
const router = express.Router();

const {
  getRun,
  getAnalysis,
  getLatestCompletedAnalysis,
  updateRunStatus
} = require("./store");

const {
  analyzeRunWithOpenAI
} = require("./openaiAnalyze");

router.post("/analyze/start", async (req, res) => {
  try {
    const { workspaceName, runId, promptOverride } = req.body || {};

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

    const run = getRun(workspaceName, runId);

    if (!run) {
      return res.status(404).json({
        ok: false,
        error: "Run not found"
      });
    }

    updateRunStatus({
      workspaceName,
      runId,
      status: "queued",
      error: null
    });

    Promise.resolve()
      .then(() =>
        analyzeRunWithOpenAI({
          workspaceName,
          runId,
          promptOverride
        })
      )
      .catch((error) => {
        try {
          updateRunStatus({
            workspaceName,
            runId,
            status: "failed",
            error: error.message || "Analysis failed"
          });
        } catch (innerError) {
          console.error("Failed to write failed status:", innerError);
        }
        console.error("Async analysis failed:", error);
      });

    return res.json({
      ok: true,
      runId,
      status: "queued",
      statusUrl: `/analyst/analyze/status?workspaceName=${encodeURIComponent(
        workspaceName
      )}&runId=${encodeURIComponent(runId)}`,
      latestDataUrl: `/analyst/analyze/latest?workspaceName=${encodeURIComponent(
        workspaceName
      )}`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to start analysis"
    });
  }
});

router.get("/analyze/status", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName;
    const runId = req.query.runId;

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

    const run = getRun(workspaceName, runId);

    if (!run) {
      return res.status(404).json({
        ok: false,
        error: "Run not found"
      });
    }

    const analysis = getAnalysis(workspaceName, runId);

    return res.json({
      ok: true,
      workspaceName,
      runId,
      status: run.status,
      error: run.error || null,
      numericRowCount: analysis?.numeric_rows?.length || 0,
      textRowCount: analysis?.text_rows?.length || 0,
      hasSummary: Boolean(analysis?.summary),
      hasReport: Boolean(analysis?.report),
      analysis: analysis || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch analysis status"
    });
  }
});

router.get("/analyze/latest", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const latest = getLatestCompletedAnalysis(workspaceName);

    return res.json({
      ok: true,
      workspaceName,
      latest: latest || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch latest analysis"
    });
  }
});

module.exports = router;

