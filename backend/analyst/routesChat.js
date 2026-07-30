const express = require("express");
const router = express.Router();

const { getAnalysis, getLatestCompletedAnalysis, getRun } = require("./store");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function buildError(code, message) {
  return { ok: false, error: code, message };
}

function hasUsableData(analysis) {
  const numeric = Array.isArray(analysis?.numeric_rows) ? analysis.numeric_rows.length : 0;
  const text = Array.isArray(analysis?.text_rows) ? analysis.text_rows.length : 0;
  const hints = Array.isArray(analysis?.time_hints) ? analysis.time_hints.length : 0;
  const topInsights = Array.isArray(analysis?.report?.top_insights) ? analysis.report.top_insights.length : 0;
  return numeric > 0 || text > 0 || hints > 0 || topInsights > 0 || Boolean((analysis?.summary || "").trim());
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
    if (!unique.has(key)) unique.set(key, {
      name: String(entity.name || "").trim(),
      normalized_name: key,
      entity_type: String(entity.entity_type || "").trim(),
      pages: [],
      filters: []
    });
    const current = unique.get(key);
    if (entity?.page && !current.pages.includes(entity.page)) current.pages.push(entity.page);
    const filterLabel = [entity?.filter_type, entity?.filter_value].filter(Boolean).join(": ");
    if (filterLabel && !current.filters.includes(filterLabel)) current.filters.push(filterLabel);
  }
  const list = Array.from(unique.values());
  return {
    visible_entities: list,
    visible_entity_names: list.map((item) => item.name),
    visible_entity_name_set: list.map((item) => item.normalized_name)
  };
}

router.post("/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json(buildError("server_config", "OPENAI_API_KEY is missing on the backend"));

    const { workspaceName = "default-workspace", runId, question } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json(buildError("bad_request", "question is required"));

    let resolvedRun = null;
    let analysis = null;
    if (runId) {
      resolvedRun = getRun(workspaceName, runId);
      if (!resolvedRun) return res.status(404).json(buildError("not_found", "Run not found"));
      analysis = getAnalysis(workspaceName, runId);
      if (!analysis) {
        if (["queued", "extracting", "started", "upload_complete", "collecting"].includes(resolvedRun.status)) return res.status(409).json(buildError("extraction_pending", "Extraction is still running for this run"));
        if (resolvedRun.status === "failed") return res.status(409).json(buildError("extraction_failed", resolvedRun.error || "Extraction failed for this run"));
      }
    } else {
      const latest = getLatestCompletedAnalysis(workspaceName);
      if (!latest) return res.status(404).json(buildError("extraction_pending", "No completed run is available yet"));
      resolvedRun = latest.run;
      analysis = latest.analysis;
    }

    if (!analysis) return res.status(409).json(buildError("extraction_pending", "No analysis is available yet for this run"));
    if (!hasUsableData(analysis)) return res.status(409).json(buildError("no_numeric_rows", "Analysis completed but no usable data was extracted."));

    const authoritativeWeekSupport = deriveAuthoritativeWeekSupport(analysis);
    const filteredTimeHints = filterTimeHintsToSupport(analysis.time_hints || [], authoritativeWeekSupport);
    const filteredNumericRows = filterRowsToSupport(analysis.numeric_rows || [], authoritativeWeekSupport, "time_period");
    const filteredTextRows = filterRowsToSupport(analysis.text_rows || [], authoritativeWeekSupport, "time_period");

    const visibleEntitySupport = deriveVisibleEntitySupport(analysis);

    const grounding = {
      runId: resolvedRun.runId,
      clientName: resolvedRun.clientName || "",
      createdAt: resolvedRun.createdAt,
      finishedAt: resolvedRun.finishedAt,
      authoritative_visible_weeks: authoritativeWeekSupport,
      authoritative_supported_week_labels: authoritativeWeekSupport?.labels || [],
      visible_entities: visibleEntitySupport.visible_entities,
      visible_entity_names: visibleEntitySupport.visible_entity_names,
      visible_entity_name_set: visibleEntitySupport.visible_entity_name_set,
      time_hints: filteredTimeHints,
      numeric_rows: filteredNumericRows,
      text_rows: filteredTextRows,
      summary: analysis.summary || "",
      report: {
        ...(analysis.report || {}),
        title: buildSafeTitle(analysis.report?.title, resolvedRun.clientName || resolvedRun.workspaceName, authoritativeWeekSupport)
      }
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "You answer only from the supplied extracted dashboard data for the selected run. Treat authoritative_visible_weeks and authoritative_supported_week_labels as the highest-priority evidence for time windows. If older or conflicting year-week labels fall outside authoritative_visible_weeks, treat them as stale extraction noise and ignore them. Never say a week is unavailable if it appears in authoritative_supported_week_labels. Only discuss apps, brands, or products whose normalized names appear in visible_entity_name_set. If the question asks about an entity outside visible_entity_name_set, say it is not visibly present in the uploaded screenshots for this run. Use top_insights as primary grounding when relevant. Use baseline vs filtered-cut comparisons when discussing what is hurting the business. Never hallucinate missing dimensions such as categories. If exact values are unavailable but the direction of risk is visible, say so clearly."
          },
          { role: "user", content: `Grounding JSON:\n${JSON.stringify(grounding, null, 2)}\n\nQuestion: ${String(question).trim()}` }
        ]
      })
    });

    const raw = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(500).json(buildError("chat_failed", raw?.error?.message || "Chat request failed"));
    const answer = raw?.choices?.[0]?.message?.content || "No answer returned.";
    return res.json({ ok: true, runId: resolvedRun.runId, createdAt: resolvedRun.createdAt, finishedAt: resolvedRun.finishedAt, answer });
  } catch (error) {
    return res.status(500).json(buildError("chat_failed", error.message || "Chat failed"));
  }
});

module.exports = router;
