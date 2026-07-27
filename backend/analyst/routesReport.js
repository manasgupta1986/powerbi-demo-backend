const express = require("express");
const router = express.Router();

const { getAnalysis, getLatestCompletedAnalysis, getRun, listRuns } = require("./store");

function hasUsableData(analysis) {
  if (!analysis) return false;
  const numericRows = Array.isArray(analysis.numeric_rows) ? analysis.numeric_rows.length : 0;
  const textRows = Array.isArray(analysis.text_rows) ? analysis.text_rows.length : 0;
  const summary = typeof analysis.summary === "string" ? analysis.summary.trim() : "";
  return numericRows > 0 || textRows > 0 || summary.length > 0;
}

function buildReportPayload(run, analysis) {
  return {
    runId: run.runId,
    workspaceName: run.workspaceName,
    createdAt: analysis.createdAt || run.createdAt,
    numericRowCount: analysis.numeric_rows?.length || 0,
    textRowCount: analysis.text_rows?.length || 0,
    hasUsableData: hasUsableData(analysis),
    summary: analysis.summary || "",
    report: analysis.report || {
      title: "",
      executive_summary: [],
      key_findings: [],
      recommendations: [],
      data_quality_notes: []
    },
    numeric_rows: analysis.numeric_rows || [],
    text_rows: analysis.text_rows || []
  };
}

function renderList(title, items) {
  if (!Array.isArray(items) || !items.length) return `<p class="empty">None</p>`;
  return `<section><h2>${title}</h2><ul>${items.map((item) => `<li>${String(item)}</li>`).join("")}</ul></section>`;
}

router.get("/report/history", (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const runs = listRuns(workspaceName, 50).map((run) => ({
      runId: run.runId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      status: run.status,
      error: run.error,
      fileCount: run.fileCount || 0,
      numericRowCount: run.numericRowCount || 0,
      textRowCount: run.textRowCount || 0,
      hasUsableData: Boolean(run.hasUsableData)
    }));
    return res.json({ ok: true, workspaceName, runs });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch report history" });
  }
});

router.get("/report/latest", (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const latest = getLatestCompletedAnalysis(workspaceName);
    if (!latest) return res.json({ ok: true, workspaceName, report: null });
    return res.json({ ok: true, workspaceName, report: buildReportPayload(latest.run, latest.analysis) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch latest report" });
  }
});

router.get("/report/run", (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const runId = req.query.runId;
    if (!runId) return res.status(400).json({ ok: false, error: "runId is required" });
    const run = getRun(workspaceName, runId);
    if (!run) return res.status(404).json({ ok: false, error: "Run not found" });
    const analysis = getAnalysis(workspaceName, runId);
    if (!analysis) return res.json({ ok: true, workspaceName, report: null, run });
    return res.json({ ok: true, workspaceName, report: buildReportPayload(run, analysis), run });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Failed to fetch report" });
  }
});

router.get("/report/html", (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const runId = req.query.runId;
    if (!runId) return res.status(400).send("runId is required");

    const run = getRun(workspaceName, runId);
    const analysis = run ? getAnalysis(workspaceName, runId) : null;
    if (!run || !analysis) return res.status(404).send("Report not found");

    const payload = buildReportPayload(run, analysis);
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${payload.report.title || "Analyst Report"}</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; padding: 32px; color: #152238; }
    h1 { margin-bottom: 4px; }
    .meta { color: #63708a; margin-bottom: 20px; }
    section { margin-bottom: 22px; }
    ul { line-height: 1.5; }
    .empty { color: #7b879c; }
  </style>
</head>
<body>
  <h1>${payload.report.title || "Analyst Report"}</h1>
  <div class="meta">Run: ${payload.runId} · Numeric rows: ${payload.numericRowCount} · Text rows: ${payload.textRowCount} · Usable: ${payload.hasUsableData ? "Yes" : "Needs review"}</div>
  <section><h2>Summary</h2><p>${payload.summary || "No summary available."}</p></section>
  ${renderList("Executive Summary", payload.report.executive_summary)}
  ${renderList("Key Findings", payload.report.key_findings)}
  ${renderList("Recommendations", payload.report.recommendations)}
  ${renderList("Data Quality Notes", payload.report.data_quality_notes)}
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    return res.status(500).send(error.message || "Failed to render report html");
  }
});

module.exports = router;
