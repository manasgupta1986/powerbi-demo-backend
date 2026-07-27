const express = require("express");
const router = express.Router();

const {
  listRuns,
  getRun,
  getAnalysis,
  getLatestCompletedAnalysis
} = require("./store");

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureString(value) {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hasUsableData(analysis) {
  if (!analysis) return false;
  const numericRows = ensureArray(analysis.numeric_rows).length;
  const textRows = ensureArray(analysis.text_rows).length;
  const summary = ensureString(analysis.summary).trim();
  return numericRows > 0 || textRows > 0 || summary.length > 0;
}

function buildHistoryItem(workspaceName, run, analysis) {
  const usable = hasUsableData(analysis);

  return {
    runId: run.runId,
    workspaceName,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    clientName: run.clientName || "",
    operatorName: run.operatorName || "",
    fileCount: run.fileCount || 0,
    numericRowCount: analysis
      ? ensureArray(analysis.numeric_rows).length
      : run.numericRowCount || 0,
    textRowCount: analysis
      ? ensureArray(analysis.text_rows).length
      : run.textRowCount || 0,
    hasSummary: Boolean(ensureString(analysis?.summary).trim()),
    hasReport: Boolean(analysis?.report),
    hasUsableData: usable,
    title:
      ensureString(analysis?.report?.title) ||
      `Run ${run.runId}`,
    htmlReportUrl: analysis
      ? `/analyst/report/html?workspaceName=${encodeURIComponent(
          workspaceName
        )}&runId=${encodeURIComponent(run.runId)}`
      : null
  };
}

function renderListSection(title, items) {
  const safeItems = ensureArray(items).map((item) => String(item));
  if (!safeItems.length) return "";

  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <ul>
        ${safeItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderRowsTable(title, rows, columns) {
  const safeRows = ensureArray(rows);
  if (!safeRows.length) return "";

  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              ${columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${safeRows
              .map((row) => {
                return `
                  <tr>
                    ${columns
                      .map((col) => `<td>${escapeHtml(row[col.key])}</td>`)
                      .join("")}
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function buildReportHtml({ workspaceName, runId, analysis, run }) {
  const report = analysis?.report || {};
  const summary = ensureString(analysis?.summary);
  const numericRows = ensureArray(analysis?.numeric_rows);
  const textRows = ensureArray(analysis?.text_rows);

  const title =
    ensureString(report.title) || `Analyst Report - ${workspaceName}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --card: #ffffff;
      --text: #18243d;
      --muted: #5d6b87;
      --border: #dbe3f0;
      --primary: #1f78ff;
      --shadow: 0 8px 24px rgba(16, 35, 70, 0.08);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 18px 48px;
    }
    .hero {
      background: linear-gradient(135deg, #0f1f3b, #18315f);
      color: #fff;
      border-radius: 20px;
      padding: 24px;
      box-shadow: var(--shadow);
      margin-bottom: 18px;
    }
    .hero h1 { margin: 0 0 8px; font-size: 28px; }
    .meta { color: #d5def1; font-size: 14px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-bottom: 18px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 18px;
      margin-bottom: 18px;
    }
    .card h2 { margin: 0 0 12px; font-size: 18px; }
    .summary { white-space: pre-wrap; color: var(--text); }
    ul { margin: 0; padding-left: 20px; }
    li { margin-bottom: 8px; }
    .kpi-row {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .kpi {
      background: #eef4ff;
      color: #0f2b5d;
      border: 1px solid #d8e5ff;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 700;
    }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 900px;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      text-align: left;
      padding: 10px 12px;
      vertical-align: top;
      font-size: 13px;
    }
    th { background: #f1f6ff; color: #20365f; }
    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
      .hero h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">Workspace: ${escapeHtml(workspaceName)}</div>
      <div class="meta">Run ID: ${escapeHtml(runId)}</div>
      <div class="meta">Generated: ${escapeHtml(analysis?.createdAt || run?.finishedAt || run?.createdAt || "")}</div>
      <div class="meta">Generated from uploaded dashboard screenshots and grounded AI extraction.</div>
      <div class="kpi-row">
        <div class="kpi">Numeric rows: ${numericRows.length}</div>
        <div class="kpi">Text rows: ${textRows.length}</div>
        <div class="kpi">Usable data: ${hasUsableData(analysis) ? "Yes" : "Needs review"}</div>
      </div>
    </section>

    <section class="card">
      <h2>Overall Summary</h2>
      <div class="summary">${escapeHtml(summary || "No summary available.")}</div>
    </section>

    <div class="grid">
      ${renderListSection("Executive Summary", report.executive_summary)}
      ${renderListSection("Key Findings", report.key_findings)}
    </div>

    <div class="grid">
      ${renderListSection("Recommendations", report.recommendations)}
      ${renderListSection("Data Quality Notes", report.data_quality_notes)}
    </div>

    ${renderRowsTable("Numeric Rows", numericRows, [
      { key: "source_file", label: "Source File" },
      { key: "page", label: "Page" },
      { key: "filter_type", label: "Filter Type" },
      { key: "filter_value", label: "Filter Value" },
      { key: "metric", label: "Metric" },
      { key: "value", label: "Value" },
      { key: "unit", label: "Unit" },
      { key: "confidence", label: "Confidence" },
      { key: "notes", label: "Notes" }
    ])}

    ${renderRowsTable("Text Rows", textRows, [
      { key: "source_file", label: "Source File" },
      { key: "page", label: "Page" },
      { key: "filter_type", label: "Filter Type" },
      { key: "filter_value", label: "Filter Value" },
      { key: "label", label: "Label" },
      { key: "text", label: "Text" },
      { key: "notes", label: "Notes" }
    ])}
  </div>
</body>
</html>`;
}

router.get("/report/history", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const limit = Number(req.query.limit || 20);
    const runs = listRuns(workspaceName, limit);

    const items = runs.map((run) => {
      const analysis = getAnalysis(workspaceName, run.runId);
      return buildHistoryItem(workspaceName, run, analysis);
    });

    return res.json({
      ok: true,
      workspaceName,
      generatedAt: new Date().toISOString(),
      items
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch report history"
    });
  }
});

router.get("/report/latest", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const latest = getLatestCompletedAnalysis(workspaceName);

    if (!latest || !latest.analysis || !latest.run) {
      return res.status(404).json({
        ok: false,
        error: "No completed analysis found for this workspace"
      });
    }

    return res.json({
      ok: true,
      workspaceName,
      runId: latest.run.runId,
      createdAt: latest.run.createdAt,
      finishedAt: latest.run.finishedAt,
      generatedAt: latest.analysis.createdAt || latest.run.finishedAt || latest.run.createdAt,
      report: latest.analysis.report || {},
      summary: latest.analysis.summary || "",
      numericRowCount: ensureArray(latest.analysis.numeric_rows).length,
      textRowCount: ensureArray(latest.analysis.text_rows).length,
      hasUsableData: hasUsableData(latest.analysis),
      htmlReportUrl: `/analyst/report/html?workspaceName=${encodeURIComponent(
        workspaceName
      )}&runId=${encodeURIComponent(latest.run.runId)}`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch latest report"
    });
  }
});

router.get("/report/run", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const runId = req.query.runId;

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
    if (!analysis) {
      return res.status(404).json({
        ok: false,
        error: "Analysis not found for this run"
      });
    }

    return res.json({
      ok: true,
      workspaceName,
      runId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      generatedAt: analysis.createdAt || run.finishedAt || run.createdAt,
      report: analysis.report || {},
      summary: analysis.summary || "",
      numericRowCount: ensureArray(analysis.numeric_rows).length,
      textRowCount: ensureArray(analysis.text_rows).length,
      hasUsableData: hasUsableData(analysis),
      htmlReportUrl: `/analyst/report/html?workspaceName=${encodeURIComponent(
        workspaceName
      )}&runId=${encodeURIComponent(runId)}`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch run report"
    });
  }
});

router.get("/report/html", async (req, res) => {
  try {
    const workspaceName = req.query.workspaceName || "default-workspace";
    const runId = req.query.runId;

    if (!runId) {
      return res.status(400).send("runId is required");
    }

    const run = getRun(workspaceName, runId);
    if (!run) {
      return res.status(404).send("Run not found");
    }

    const analysis = getAnalysis(workspaceName, runId);
    if (!analysis) {
      return res.status(404).send("Analysis not found for this run");
    }

    const html = buildReportHtml({
      workspaceName,
      runId,
      analysis,
      run
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error) {
    return res.status(500).send(error.message || "Failed to render HTML report");
  }
});

module.exports = router;
