const express = require("express");
const router = express.Router();

const { getRun, getAnalysis, getLatestCompletedAnalysis, updateRunStatus } = require("./store");
const { analyzeRunWithOpenAI } = require("./openaiAnalyze");

function hasUsableData(analysis) {
  if (!analysis) return false;
  const numericRows = Array.isArray(analysis.numeric_rows) ? analysis.numeric_rows.length : 0;
  const textRows = Array.isArray(analysis.text_rows) ? analysis.text_rows.length : 0;
  const timeHints = Array.isArray(analysis.time_hints) ? analysis.time_hints.length : 0;
  const topInsights = Array.isArray(analysis.report?.top_insights) ? analysis.report.top_insights.length : 0;
  const summary = typeof analysis.summary === "string" ? analysis.summary.trim() : "";
  return numericRows > 0 || textRows > 0 || timeHints > 0 || topInsights > 0 || summary.length > 0;
}

router.post("/analyze/start", async (req, res) => {
  try {
    const { workspaceName, runId, promptOverride } = req.body || {};
    if (!workspaceName) return res.status(400).json({ ok: false, error: "workspaceName is required" });
    if (!runId) return res.status(400).json({ ok: false, error: "runId is required" });

    const run = getRun(workspaceName, runId);
    if (!run) return res.status(404).json({ ok: false, error: "Run not found" });
    if (!Array.isArray(run.files) || !run.files.length) {
      return res.status(400).json({ ok: false, error: "No uploaded screenshots found for this run" });
    }

    updateRunStatus({ workspaceName, runId, status: "queued", error: null });

    Promise.resolve()
      .then(() => analyzeRunWithOpenAI({ workspaceName, runId, promptOverride }))
      .catch((error) => {
        try {
          updateRunStatus({ workspaceName, runId, status: "failed", error: error.message || "Analysis failed" });
        } catch (innerError) {
          console.error("Failed to write failed status:", innerError);
        }
        console.error("Async analysis failed:", error);
      });

    return res.json({
      ok: true,
      runId,
      status: "queued",
      statusUrl: `/analyst/analyze/status?workspaceName=${encodeURIComponent(workspaceName)}&runId=${encodeURIComponent(runId)}`,
      latestDataUrl: `/analyst/analyze/latest?workspaceName=${encodeURIComponent(workspaceName)}`
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to start analysis" });
  }
});

router.get("/analyze/status", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName;
    const runId = req.query.runId;
    if (!workspaceName) return res.status(400).json({ ok: false, error: "workspaceName is required" });
    if (!runId) return res.status(400).json({ ok: false, error: "runId is required" });

    const run = getRun(workspaceName, runId);
    if (!run) return res.status(404).json({ ok: false, error: "Run not found" });
    const analysis = getAnalysis(workspaceName, runId);
    const usable = hasUsableData(analysis);

    const activeStatuses = new Set(["queued", "extracting", "collecting", "upload_complete", "started"]);
    const staleAfterMs = Math.max(60000, Number(process.env.ANALYST_PROGRESS_STALE_AFTER_MS || 180000));
    const now = Date.now();
    const progressUpdatedAtMs = run.progress?.updatedAt ? Date.parse(run.progress.updatedAt) : NaN;
    const staleMs = Number.isFinite(progressUpdatedAtMs) ? Math.max(0, now - progressUpdatedAtMs) : null;
    const isActive = activeStatuses.has(run.status);
    const isStalled = isActive && (!run.progress || !Number.isFinite(progressUpdatedAtMs) || staleMs >= staleAfterMs);

    let progress = run.progress || null;
    if (!progress && isActive) {
      progress = {
        phase: run.status,
        message: "No backend heartbeat has been written yet. This usually means old backend code is deployed or the worker is stuck before progress initialization.",
        estimatedSecondsRemaining: null,
        currentFileName: null,
        currentFileIndex: 0,
        totalFiles: run.fileCount || 0,
        currentSliceIndex: 0,
        totalSlicesForFile: 0,
        processedSlices: 0,
        totalSlices: 0,
        currentBatchIndex: 0,
        totalBatches: 0,
        updatedAt: null,
        isStalled: true,
        staleSeconds: null
      };
    } else if (progress && isStalled) {
      progress = {
        ...progress,
        message: `No backend heartbeat for ${Math.floor((staleMs || 0) / 1000)}s during ${progress.phase || run.status}. Check Render logs or retry this run.`,
        estimatedSecondsRemaining: null,
        isStalled: true,
        staleSeconds: Math.floor((staleMs || 0) / 1000)
      };
    }

    return res.json({
      ok: true,
      workspaceName,
      runId,
      status: run.status,
      error: run.error || null,
      numericRowCount: analysis?.numeric_rows?.length || 0,
      textRowCount: analysis?.text_rows?.length || 0,
      timeHintCount: analysis?.time_hints?.length || 0,
      topInsightCount: analysis?.report?.top_insights?.length || 0,
      hasUsableData: usable,
      usableStatus: analysis ? (usable ? "usable" : "needs_review") : "unknown",
      stalled: Boolean(progress?.isStalled),
      progress: progress
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch analysis status" });
  }
});

router.get("/analyze/latest", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const latest = getLatestCompletedAnalysis(workspaceName);
    const usable = hasUsableData(latest?.analysis);
    return res.json({
      ok: true,
      workspaceName,
      latest: latest || null,
      hasUsableData: usable,
      usableStatus: latest?.analysis ? (usable ? "usable" : "needs_review") : "unknown",
      progress: latest?.run?.progress || null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch latest analysis" });
  }
});

module.exports = router;
