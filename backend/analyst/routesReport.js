const express = require("express");
const router = express.Router();

const { getAnalysis, getLatestCompletedAnalysis, getRun, listRuns } = require("./store");

function hasUsableData(analysis) {
  if (!analysis) return false;
  const numericRows = Array.isArray(analysis.numeric_rows) ? analysis.numeric_rows.length : 0;
  const textRows = Array.isArray(analysis.text_rows) ? analysis.text_rows.length : 0;
  const timeHints = Array.isArray(analysis.time_hints) ? analysis.time_hints.length : 0;
  const topInsights = Array.isArray(analysis.report?.top_insights) ? analysis.report.top_insights.length : 0;
  const summary = typeof analysis.summary === "string" ? analysis.summary.trim() : "";
  return numericRows > 0 || textRows > 0 || timeHints > 0 || topInsights > 0 || summary.length > 0;
}

function buildReportPayload(run, analysis) {
  return {
    runId: run.runId,
    workspaceName: run.workspaceName,
    clientName: run.clientName || "",
    createdAt: analysis.createdAt || run.createdAt,
    numericRowCount: analysis.numeric_rows?.length || 0,
    textRowCount: analysis.text_rows?.length || 0,
    timeHintCount: analysis.time_hints?.length || 0,
    hasUsableData: hasUsableData(analysis),
    summary: analysis.summary || "",
    report: analysis.report || {
      title: "",
      executive_summary: [],
      top_insights: [],
      recommended_actions: [],
      data_quality_notes: []
    },
    time_hints: analysis.time_hints || [],
    numeric_rows: analysis.numeric_rows || [],
    text_rows: analysis.text_rows || []
  };
}

function listSection(title, items) {
  if (!Array.isArray(items) || !items.length) return `<section><h2>${title}</h2><p class="empty">None</p></section>`;
  return `<section><h2>${title}</h2><ul>${items.map((item) => `<li>${String(item)}</li>`).join("")}</ul></section>`;
}

function insightCards(items) {
  if (!Array.isArray(items) || !items.length) return `<section><h2>Top Priority Insights</h2><p class="empty">No ranked insights available.</p></section>`;
  return `<section><h2>Top Priority Insights</h2>${items.map((item, index) => `
    <article class="insight-card">
      <div class="insight-rank">Priority ${index + 1}</div>
      <h3>${String(item.title || "Untitled insight")}</h3>
      <div class="insight-meta">Severity: ${String(item.severity || "")} · Score: ${Number(item.priority_score || 0)}</div>
      <p>${String(item.why_it_matters || "")}</p>
      ${Array.isArray(item.evidence) && item.evidence.length ? `<div><strong>Evidence</strong><ul>${item.evidence.map((ev) => `<li>${String(ev)}</li>`).join("")}</ul></div>` : ""}
      ${item.recommended_action ? `<div><strong>Recommended action</strong><p>${String(item.recommended_action)}</p></div>` : ""}
      ${item.chart_recommendation ? `<div><strong>Suggested visual</strong><p>${String(item.chart_recommendation)}</p></div>` : ""}
    </article>
  `).join("")}</section>`;
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
      timeHintCount: run.timeHintCount || 0,
      topInsightCount: run.topInsightCount || 0,
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
    body { font-family: Inter, Arial, sans-serif; padding: 32px; color: #152238; max-width: 1000px; margin: 0 auto; }
    h1 { margin-bottom: 4px; }
    h2 { margin-top: 28px; }
    h3 { margin-bottom: 8px; }
    .meta { color: #63708a; margin-bottom: 18px; }
    .empty { color: #7b879c; }
    .insight-card { border: 1px solid #d8e1f0; border-radius: 14px; padding: 16px; margin-bottom: 14px; background: #f9fbff; }
    .insight-rank { font-size: 12px; font-weight: 700; color: #4c6fff; margin-bottom: 6px; text-transform: uppercase; }
    .insight-meta { color: #63708a; font-size: 13px; margin-bottom: 10px; }
    p, li { line-height: 1.5; }
  </style>
</head>
<body>
  <h1>${payload.report.title || `${payload.clientName || "Client"} Executive Summary`}</h1>
  <div class="meta">Run created ${payload.createdAt} · Numeric rows ${payload.numericRowCount} · Text rows ${payload.textRowCount} · Time hints ${payload.timeHintCount}</div>
  ${listSection("Executive Summary", payload.report.executive_summary)}
  ${insightCards(payload.report.top_insights)}
  ${listSection("Recommended Actions", payload.report.recommended_actions)}
  ${listSection("Data Quality Notes", payload.report.data_quality_notes)}
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    return res.status(500).send(error.message || "Failed to render report html");
  }
});

module.exports = router;
