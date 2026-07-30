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


const WEEK_LABEL_RE = /\b(20\d{2})-W(\d{1,2})\b/g;

function parseWeekLabel(label) {
  const match = String(label || "").match(/\b(20\d{2})-W(\d{1,2})\b/);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  return { label: `${year}-W${String(week).padStart(2, "0")}`, year, week, index: year * 53 + week };
}

function collectParsedWeeks(analysis) {
  const parsed = [];
  const pushParsed = (value) => {
    const item = parseWeekLabel(value);
    if (item) parsed.push(item);
  };

  for (const hint of Array.isArray(analysis?.time_hints) ? analysis.time_hints : []) {
    for (const visible of Array.isArray(hint?.visible_weeks) ? hint.visible_weeks : []) pushParsed(visible?.week_label);
  }
  for (const row of Array.isArray(analysis?.numeric_rows) ? analysis.numeric_rows : []) pushParsed(row?.time_period);
  for (const row of Array.isArray(analysis?.text_rows) ? analysis.text_rows : []) pushParsed(row?.time_period);

  const unique = new Map();
  for (const item of parsed) unique.set(item.label, item);
  return Array.from(unique.values()).sort((a, b) => a.index - b.index);
}

function pickAuthoritativeWeekCluster(parsedWeeks) {
  if (!parsedWeeks.length) return null;
  const clusters = [];
  let current = [parsedWeeks[0]];
  for (let i = 1; i < parsedWeeks.length; i += 1) {
    if ((parsedWeeks[i].index - current[current.length - 1].index) > 4) {
      clusters.push(current);
      current = [parsedWeeks[i]];
    } else {
      current.push(parsedWeeks[i]);
    }
  }
  clusters.push(current);
  clusters.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return b[b.length - 1].index - a[a.length - 1].index;
  });
  return clusters[0];
}

function deriveAuthoritativeWeekSupport(analysis) {
  const parsedWeeks = collectParsedWeeks(analysis);
  if (!parsedWeeks.length) return null;
  const cluster = pickAuthoritativeWeekCluster(parsedWeeks) || parsedWeeks;
  const labels = cluster.map((item) => item.label);
  return {
    earliest: labels[0],
    latest: labels[labels.length - 1],
    labels,
    label_set: labels,
    range_label: `${labels[0]} to ${labels[labels.length - 1]}`,
    all_detected_labels: parsedWeeks.map((item) => item.label)
  };
}

function weekLabelInSupport(value, support) {
  if (!support || !Array.isArray(support.labels) || !support.labels.length) return true;
  const parsed = parseWeekLabel(value);
  if (!parsed) return true;
  return support.labels.includes(parsed.label);
}

function filterRowsToSupport(rows, support, fieldName) {
  return (Array.isArray(rows) ? rows : []).filter((row) => weekLabelInSupport(row?.[fieldName], support));
}

function filterTimeHintsToSupport(timeHints, support) {
  if (!support) return Array.isArray(timeHints) ? timeHints : [];
  return (Array.isArray(timeHints) ? timeHints : []).map((hint) => ({
    ...hint,
    visible_weeks: (Array.isArray(hint?.visible_weeks) ? hint.visible_weeks : []).filter((item) => weekLabelInSupport(item?.week_label, support))
  })).filter((hint) => Array.isArray(hint.visible_weeks) && hint.visible_weeks.length);
}

function buildSafeTitle(originalTitle, clientName, support) {
  const fallback = `${clientName || "Client"} Executive BI Report`;
  const base = String(originalTitle || fallback)
    .replace(/\s*\((?:[^()]*\b20\d{2}-W\d{1,2}\b[^()]*)\)\s*$/i, "")
    .trim() || fallback;
  if (!support?.range_label) return base;
  return `${base} (${support.range_label})`;
}

function normalizeEntityName(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

function deriveVisibleEntitySupport(analysis) {
  const entities = Array.isArray(analysis?.visible_entities) ? analysis.visible_entities : [];
  const unique = new Map();
  for (const entity of entities) {
    const key = normalizeEntityName(entity?.name);
    if (!key) continue;
    if (!unique.has(key)) unique.set(key, String(entity.name || "").trim());
  }
  const visibleEntityNames = Array.from(unique.values());
  return {
    visible_entities: entities,
    visible_entity_names: visibleEntityNames,
    visible_entity_name_set: visibleEntityNames.map((item) => normalizeEntityName(item))
  };
}

function buildReportPayload(run, analysis) {
  const authoritativeWeekSupport = deriveAuthoritativeWeekSupport(analysis);
  const visibleEntitySupport = deriveVisibleEntitySupport(analysis);
  const filteredTimeHints = filterTimeHintsToSupport(analysis.time_hints || [], authoritativeWeekSupport);
  const filteredNumericRows = filterRowsToSupport(analysis.numeric_rows || [], authoritativeWeekSupport, "time_period");
  const filteredTextRows = filterRowsToSupport(analysis.text_rows || [], authoritativeWeekSupport, "time_period");
  const safeReport = analysis.report || {
    title: "",
    executive_summary: [],
    top_insights: [],
    recommended_actions: [],
    data_quality_notes: []
  };

  return {
    runId: run.runId,
    workspaceName: run.workspaceName,
    clientName: run.clientName || "",
    createdAt: analysis.createdAt || run.createdAt,
    numericRowCount: filteredNumericRows.length,
    textRowCount: filteredTextRows.length,
    timeHintCount: filteredTimeHints.length,
    hasUsableData: hasUsableData(analysis),
    summary: analysis.summary || "",
    authoritative_visible_weeks: authoritativeWeekSupport,
    visible_entities: visibleEntitySupport.visible_entities,
    visible_entity_names: visibleEntitySupport.visible_entity_names,
    visibleEntityCount: visibleEntitySupport.visible_entity_names.length,
    report: {
      ...safeReport,
      title: buildSafeTitle(safeReport.title, run.clientName || run.workspaceName, authoritativeWeekSupport)
    },
    time_hints: filteredTimeHints,
    numeric_rows: filteredNumericRows,
    text_rows: filteredTextRows
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
  <div class="meta">Run created ${payload.createdAt} · Numeric rows ${payload.numericRowCount} · Text rows ${payload.textRowCount} · Time hints ${payload.timeHintCount}${payload.authoritative_visible_weeks?.range_label ? ` · Visible weeks ${payload.authoritative_visible_weeks.range_label}` : ""}${payload.visibleEntityCount ? ` · Visible entities ${payload.visibleEntityCount}` : ""}</div>
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
