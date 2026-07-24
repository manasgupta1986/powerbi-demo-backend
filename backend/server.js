const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "40mb" }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const LATEST_DATA_PATH = path.join(DATA_DIR, "latest-data.json");
const LATEST_REPORT_PATH = path.join(REPORTS_DIR, "latest-report.html");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const MAX_AI_SLICES = Math.max(1, Math.min(6, Number(process.env.MAX_AI_SLICES || 4)));

const extractionStatus = new Map();

function setExtractionStatus(runId, stateId, patch) {
  const key = `${runId}::${stateId}`;
  const prev = extractionStatus.get(key) || {
    runId, stateId, stage: "queued", progress: 0, message: "",
    startedAt: nowIso(), updatedAt: nowIso(), finishedAt: "", error: ""
  };
  const next = { ...prev, ...patch, updatedAt: nowIso() };
  extractionStatus.set(key, next);
  return next;
}
function getExtractionStatus(runId, stateId) {
  return extractionStatus.get(`${runId}::${stateId}`) || null;
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(RUNS_DIR, { recursive: true });
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
}

function safeFileName(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 160) || "item";
}
function stripDataUrlPrefix(d) {
  const raw = String(d || ""); const i = raw.indexOf(",");
  return i >= 0 ? raw.slice(i + 1) : raw;
}
function escapeHtml(v) {
  return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
async function readJsonIfExists(p, f = null) {
  try { const r = await fsp.readFile(p, "utf8"); return JSON.parse(r); } catch { return f; }
}
async function writeJson(p, d) { await fsp.writeFile(p, JSON.stringify(d, null, 2), "utf8"); }
function nowIso() { return new Date().toISOString(); }

function getRunDir(runId) { return path.join(RUNS_DIR, safeFileName(runId)); }
function getRunMetaPath(runId) { return path.join(getRunDir(runId), "run.json"); }
function getStatesRoot(runId) { return path.join(getRunDir(runId), "states"); }
function getStateDir(runId, stateId) { return path.join(getStatesRoot(runId), safeFileName(stateId)); }
function getStateMetaPath(runId, stateId) { return path.join(getStateDir(runId, stateId), "state.json"); }
function getStateExtractionPath(runId, stateId) { return path.join(getStateDir(runId, stateId), "extraction.json"); }
function getStateImagesDir(runId, stateId) { return path.join(getStateDir(runId, stateId), "images"); }

async function saveRunMetaFromMeta(meta) {
  const runDir = getRunDir(meta.runId);
  await fsp.mkdir(runDir, { recursive: true });
  const runMetaPath = getRunMetaPath(meta.runId);
  const existing = (await readJsonIfExists(runMetaPath, null)) || {};
  const next = {
    runId: meta.runId,
    clientName: meta.clientName || existing.clientName || "",
    dashboardUrl: meta.dashboardUrl || existing.dashboardUrl || "",
    mode: existing.mode || "GUIDED_CAPTURE_MANUAL_SET_AUTO_SCROLL",
    startedAt: existing.startedAt || nowIso(),
    finishedAt: existing.finishedAt || "",
    lastUpdatedAt: nowIso()
  };
  await writeJson(runMetaPath, next);
  return next;
}

async function initStateMeta(meta, totalSlices) {
  const stateDir = getStateDir(meta.runId, meta.stateId);
  await fsp.mkdir(getStateImagesDir(meta.runId, meta.stateId), { recursive: true });
  const stateMeta = {
    runId: meta.runId, stateId: meta.stateId, stepId: meta.stepId || "",
    clientName: meta.clientName || "", dashboardUrl: meta.dashboardUrl || "",
    pageName: meta.pageName || "", stateType: meta.stateType || "baseline",
    filterName: meta.filterName || "", filterValue: meta.filterValue || "",
    capturedAt: meta.capturedAt || nowIso(),
    expectedSliceCount: totalSlices || 0,
    sliceCount: 0,
    slices: []
  };
  await writeJson(getStateMetaPath(meta.runId, meta.stateId), stateMeta);
  return stateMeta;
}

async function appendSlice(runId, stateId, sliceBody) {
  const imagesDir = getStateImagesDir(runId, stateId);
  await fsp.mkdir(imagesDir, { recursive: true });
  const idx = sliceBody.sliceIndex || 0;
  const fileName = `slice_${String(idx).padStart(2, "0")}.png`;
  const filePath = path.join(imagesDir, fileName);
  const base64 = stripDataUrlPrefix(sliceBody.imageDataUrl || "");
  if (base64) await fsp.writeFile(filePath, Buffer.from(base64, "base64"));

  const stateMetaPath = getStateMetaPath(runId, stateId);
  const stateMeta = await readJsonIfExists(stateMetaPath, null);
  if (!stateMeta) throw new Error("State not initialized. Call /capture-state/start first.");

  const persisted = {
    sliceIndex: idx,
    scrollY: sliceBody.scrollY || 0,
    viewportWidth: sliceBody.viewportWidth || 0,
    viewportHeight: sliceBody.viewportHeight || 0,
    totalScrollHeight: sliceBody.totalScrollHeight || 0,
    clientHeight: sliceBody.clientHeight || 0,
    capturedAt: sliceBody.capturedAt || nowIso(),
    imageFile: fileName,
    imagePath: filePath
  };

  stateMeta.slices = Array.isArray(stateMeta.slices) ? stateMeta.slices : [];
  const existingIdx = stateMeta.slices.findIndex(s => s.sliceIndex === idx);
  if (existingIdx >= 0) stateMeta.slices[existingIdx] = persisted;
  else stateMeta.slices.push(persisted);
  stateMeta.sliceCount = stateMeta.slices.length;
  stateMeta.lastUpdatedAt = nowIso();
  await writeJson(stateMetaPath, stateMeta);
  return stateMeta;
}

function selectRepresentativeSlices(slices, maxCount) {
  const arr = Array.isArray(slices) ? slices : [];
  if (arr.length <= maxCount) return arr;
  const indexes = new Set();
  indexes.add(0); indexes.add(arr.length - 1); indexes.add(Math.floor(arr.length / 2));
  while (indexes.size < Math.min(maxCount, arr.length)) {
    const ratio = indexes.size / Math.max(1, maxCount - 1);
    indexes.add(Math.min(arr.length - 1, Math.floor(ratio * (arr.length - 1))));
  }
  const picked = [...indexes].sort((a, b) => a - b).slice(0, maxCount);
  return picked.map((i) => arr[i]);
}

async function loadStateSlicesAsDataUrls(runId, stateId, stateMeta) {
  const arr = [];
  for (const s of stateMeta.slices || []) {
    try {
      const buf = await fsp.readFile(s.imagePath);
      const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      arr.push({ ...s, imageDataUrl: dataUrl });
    } catch { arr.push({ ...s, imageDataUrl: "" }); }
  }
  return arr;
}

function buildExtractionFallback(stateMeta) {
  return {
    aiEnabled: false, extractedAt: nowIso(),
    stateSummary: {
      pageName: stateMeta.pageName || "", stateType: stateMeta.stateType || "baseline",
      filterName: stateMeta.filterName || "", filterValue: stateMeta.filterValue || "",
      note: "AI extraction not available. Stored metadata only."
    },
    weekMappings: [], charts: [],
    executiveSummary: [
      stateMeta.stateType === "baseline"
        ? `${stateMeta.pageName} baseline captured with ${stateMeta.sliceCount || 0} slices.`
        : `${stateMeta.pageName} with ${stateMeta.filterName} = ${stateMeta.filterValue} captured with ${stateMeta.sliceCount || 0} slices.`
    ],
    limitations: ["OPENAI_API_KEY not configured, so screenshot value extraction did not run."]
  };
}

async function callOpenAIChatJSON({ model, messages, temperature = 0.1 }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model, temperature, response_format: { type: "json_object" }, messages })
  });
  if (!res.ok) {
    const t = await safeReadText(res);
    throw new Error(`OpenAI JSON call failed: HTTP ${res.status}${t ? `: ${t}` : ""}`);
  }
  const j = await res.json();
  return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
}
async function callOpenAIChatText({ model, messages, temperature = 0.2 }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model, temperature, messages })
  });
  if (!res.ok) {
    const t = await safeReadText(res);
    throw new Error(`OpenAI text call failed: HTTP ${res.status}${t ? `: ${t}` : ""}`);
  }
  const j = await res.json();
  return j?.choices?.[0]?.message?.content || "";
}

function normalizeExtractionResult(raw, stateMeta) {
  const charts = Array.isArray(raw?.charts) ? raw.charts : [];
  const weekMappings = Array.isArray(raw?.weekMappings) ? raw.weekMappings : [];
  const executiveSummary = Array.isArray(raw?.executiveSummary) ? raw.executiveSummary : [];
  const limitations = Array.isArray(raw?.limitations) ? raw.limitations : [];
  const safeCharts = charts.map((chart, i) => {
    const dps = Array.isArray(chart?.datapoints) ? chart.datapoints : [];
    return {
      chartId: chart?.chartId || `chart_${i + 1}`,
      title: chart?.title || `Chart ${i + 1}`,
      chartType: chart?.chartType || "",
      xAxisLabel: chart?.xAxisLabel || "",
      yAxisLabel: chart?.yAxisLabel || "",
      unit: chart?.unit || "",
      seriesNames: Array.isArray(chart?.seriesNames) ? chart.seriesNames : [],
      datapoints: dps.map(dp => ({
        seriesName: dp?.seriesName || "",
        appName: dp?.appName || dp?.seriesName || "",
        xLabel: dp?.xLabel || "",
        weekCode: dp?.weekCode || "",
        inferredStartDate: dp?.inferredStartDate || null,
        value: typeof dp?.value === "number" ? dp.value : null,
        unit: dp?.unit || chart?.unit || "",
        confidence: typeof dp?.confidence === "number" ? dp.confidence : null,
        note: dp?.note || ""
      })),
      insights: Array.isArray(chart?.insights) ? chart.insights : []
    };
  });
  return {
    aiEnabled: true, extractedAt: nowIso(),
    stateSummary: {
      pageName: stateMeta.pageName || "", stateType: stateMeta.stateType || "baseline",
      filterName: stateMeta.filterName || "", filterValue: stateMeta.filterValue || "",
      chartCount: safeCharts.length
    },
    weekMappings: weekMappings.map(m => ({
      weekCode: m?.weekCode || "",
      inferredStartDate: m?.inferredStartDate || null,
      confidence: typeof m?.confidence === "number" ? m.confidence : null,
      evidence: m?.evidence || ""
    })),
    charts: safeCharts, executiveSummary, limitations
  };
}

async function analyzeStateWithAI(stateMeta, slicesWithDataUrls) {
  if (!OPENAI_API_KEY) return buildExtractionFallback(stateMeta);
  const rep = selectRepresentativeSlices(slicesWithDataUrls, MAX_AI_SLICES);
  const content = [{
    type: "text",
    text:
      `You are analyzing dashboard screenshots for structured data extraction.\n` +
      `Result must be based ONLY on the screenshots and the supplied state metadata.\n\n` +
      `State metadata:\n- clientName: ${stateMeta.clientName || ""}\n- pageName: ${stateMeta.pageName || ""}\n- stateType: ${stateMeta.stateType || "baseline"}\n- filterName: ${stateMeta.filterName || ""}\n- filterValue: ${stateMeta.filterValue || ""}\n\n` +
      `Return strict JSON with charts, datapoints, weekMappings, executiveSummary, limitations.\n` +
      `Rules: extract approximate numbers when possible, preserve week codes exactly, do not invent values, stay closed-book.`
  }];
  for (const s of rep) if (s?.imageDataUrl) content.push({ type: "image_url", image_url: { url: s.imageDataUrl } });
  const raw = await callOpenAIChatJSON({
    model: OPENAI_VISION_MODEL, temperature: 0.1,
    messages: [
      { role: "system", content: "You are a careful data extraction assistant. Return strict JSON only." },
      { role: "user", content }
    ]
  });
  return normalizeExtractionResult(raw, stateMeta);
}

async function saveExtraction(runId, stateId, extraction) {
  await writeJson(getStateExtractionPath(runId, stateId), extraction);
}

function flattenExtractedRows(stateMeta, extraction) {
  const rows = [];
  for (const chart of (extraction?.charts || [])) {
    for (const dp of (chart?.datapoints || [])) {
      rows.push({
        runId: stateMeta.runId, stateId: stateMeta.stateId,
        pageName: stateMeta.pageName || "", stateType: stateMeta.stateType || "baseline",
        filterName: stateMeta.filterName || "", filterValue: stateMeta.filterValue || "",
        chartTitle: chart?.title || "", chartType: chart?.chartType || "",
        xAxisLabel: chart?.xAxisLabel || "", yAxisLabel: chart?.yAxisLabel || "",
        unit: dp?.unit || chart?.unit || "",
        seriesName: dp?.seriesName || "",
        appName: dp?.appName || dp?.seriesName || "",
        xLabel: dp?.xLabel || "", weekCode: dp?.weekCode || "",
        inferredStartDate: dp?.inferredStartDate || null,
        value: typeof dp?.value === "number" ? dp.value : null,
        confidence: typeof dp?.confidence === "number" ? dp.confidence : null,
        note: dp?.note || "", capturedAt: stateMeta.capturedAt || ""
      });
    }
  }
  return rows;
}

function buildComparableKey(row) {
  return [row.pageName, row.filterName, row.filterValue, row.chartTitle, row.seriesName || row.appName].join(" | ");
}
function sortRowsChronologically(rows) {
  return [...rows].sort((a, b) => {
    const ad = a.inferredStartDate || ""; const bd = b.inferredStartDate || "";
    if (ad && bd && ad !== bd) return ad.localeCompare(bd);
    const aw = a.weekCode || ""; const bw = b.weekCode || "";
    if (aw !== bw) return aw.localeCompare(bw);
    return String(a.xLabel || "").localeCompare(String(b.xLabel || ""));
  });
}
function buildHeuristicReport(latestData) {
  const rows = latestData?.extractedRows || [];
  const client = latestData?.clientName || "the client";
  const states = latestData?.states || [];
  if (!rows.length) {
    return [
      `Report for ${client}:`,
      `The latest run captured ${states.length} state(s), but no numeric chart datapoints were extracted yet.`
    ].join("\n\n");
  }
  const groups = new Map();
  for (const r of rows) {
    const k = buildComparableKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const lines = [];
  for (const [, groupRows] of groups.entries()) {
    const o = sortRowsChronologically(groupRows).filter(r => typeof r.value === "number");
    if (o.length >= 2) {
      const f = o[0]; const l = o[o.length - 1];
      const d = +(l.value - f.value).toFixed(2);
      lines.push(`${l.seriesName || l.appName || "Series"} in ${l.chartTitle || "chart"} moved from ${f.value}${f.unit || ""} to ${l.value}${l.unit || ""} (${d >= 0 ? "+" : ""}${d}${l.unit || ""}).`);
    }
  }
  return [
    `Report for ${client}:`,
    `The latest run includes ${latestData.totalStates || 0} state(s), ${latestData.totalSlices || 0} slice(s), and ${rows.length} extracted datapoint(s).`,
    lines.length ? lines.slice(0, 8).join(" ") : `Not enough comparable numeric datapoints yet.`
  ].join("\n\n");
}

function buildAskFallback(latestData, question) {
  const rows = latestData?.extractedRows || [];
  const q = String(question || "").trim().toLowerCase();
  if (!latestData) return "I do not have any captured dashboard data yet.";
  if (q.includes("summary") || q.includes("overview"))
    return `The latest run contains ${latestData.totalStates || 0} state(s), ${latestData.totalSlices || 0} slice(s), and ${rows.length} extracted datapoint(s).`;
  if (q.includes("how many states")) return `${latestData.totalStates || 0} state(s).`;
  if (q.includes("how many slices")) return `${latestData.totalSlices || 0} slice(s).`;
  const matched = rows.filter(r => {
    const t = [r.pageName, r.filterName, r.filterValue, r.chartTitle, r.seriesName, r.appName, r.weekCode, r.xLabel].join(" ").toLowerCase();
    return q && (t.includes(q) || q.split(/\s+/).some(tok => tok && t.includes(tok)));
  });
  if (matched.length) {
    const s = matched.slice(0, 8).map(r => {
      const series = r.seriesName || r.appName || "series";
      const point = r.weekCode || r.xLabel || "point";
      const value = typeof r.value === "number" ? `${r.value}${r.unit || ""}` : "unreadable";
      const scope = r.filterName ? `${r.pageName} / ${r.filterName}=${r.filterValue}` : `${r.pageName} baseline`;
      return `${scope} → ${series} at ${point}: ${value}`;
    });
    return `Matching datapoints: ${s.join("; ")}.`;
  }
  return rows.length ? `Not found in extracted dataset.` : `No numeric extraction rows are available yet.`;
}

function buildCondensedDataset(latestData, limit = 350) {
  const rows = latestData?.extractedRows || [];
  return {
    runId: latestData?.runId || "", clientName: latestData?.clientName || "",
    totalStates: latestData?.totalStates || 0, totalSlices: latestData?.totalSlices || 0,
    weekMappings: latestData?.weekMappings || [],
    states: (latestData?.states || []).map(s => ({
      pageName: s.pageName, stateType: s.stateType,
      filterName: s.filterName, filterValue: s.filterValue,
      sliceCount: s.sliceCount, capturedAt: s.capturedAt
    })),
    extractedRows: rows.slice(0, limit)
  };
}
async function generateClientAwareReport(latestData) {
  const rows = latestData?.extractedRows || [];
  if (!OPENAI_API_KEY || !rows.length) return buildHeuristicReport(latestData);
  const ds = buildCondensedDataset(latestData, 300);
  try {
    const text = await callOpenAIChatText({
      model: OPENAI_TEXT_MODEL, temperature: 0.2,
      messages: [
        { role: "system", content: "You write concise business analysis from structured dashboard data only. Do not use external knowledge. Use numeric values whenever available. Frame the report from the named client's perspective." },
        { role: "user", content: `Write a strategic report for client "${latestData.clientName || ""}". Use ONLY the provided dataset. Focus on trends across visible week codes. Mention numeric movement explicitly.\n\nDataset JSON:\n${JSON.stringify(ds)}` }
      ]
    });
    return text || buildHeuristicReport(latestData);
  } catch { return buildHeuristicReport(latestData); }
}
async function answerClosedBook(latestData, question) {
  const rows = latestData?.extractedRows || [];
  if (!OPENAI_API_KEY || !rows.length) return buildAskFallback(latestData, question);
  const ds = buildCondensedDataset(latestData, 300);
  try {
    const text = await callOpenAIChatText({
      model: OPENAI_TEXT_MODEL, temperature: 0.1,
      messages: [
        { role: "system", content: "Answer questions using ONLY the provided dashboard dataset. If the answer is not in the data, say that clearly. Be numeric when possible." },
        { role: "user", content: `Question: ${question}\n\nDataset JSON:\n${JSON.stringify(ds)}` }
      ]
    });
    return text || buildAskFallback(latestData, question);
  } catch { return buildAskFallback(latestData, question); }
}

function buildReportHtml(latestData, reportText) {
  const states = latestData?.states || [];
  const rows = latestData?.extractedRows || [];
  const stateRows = states.length
    ? states.map(s => {
        const label = s.stateType === "baseline" ? `${s.pageName} — Baseline` : `${s.pageName} — ${s.filterName} = ${s.filterValue}`;
        return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(s.sliceCount || 0))}</td><td>${escapeHtml(s.capturedAt || "")}</td></tr>`;
      }).join("")
    : `<tr><td colspan="3">No states available.</td></tr>`;
  const dpRows = rows.length
    ? rows.slice(0, 120).map(r => `<tr><td>${escapeHtml(r.pageName || "")}</td><td>${escapeHtml(r.filterName ? `${r.filterName} = ${r.filterValue}` : "Baseline")}</td><td>${escapeHtml(r.chartTitle || "")}</td><td>${escapeHtml(r.seriesName || r.appName || "")}</td><td>${escapeHtml(r.weekCode || r.xLabel || "")}</td><td>${escapeHtml(r.inferredStartDate || "")}</td><td>${escapeHtml(typeof r.value === "number" ? String(r.value) : "")}${escapeHtml(r.unit || "")}</td><td>${escapeHtml(typeof r.confidence === "number" ? String(r.confidence) : "")}</td></tr>`).join("")
    : `<tr><td colspan="8">No extracted numeric datapoints yet.</td></tr>`;
  const paragraphs = String(reportText || "").split(/\n{2,}/).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>PowerBI Guided Capture Report</title>
<style>body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111827}h1{margin-bottom:8px}h2{margin-top:0}.muted{color:#6b7280;margin-bottom:20px}.card{border:1px solid #d1d5db;border-radius:12px;padding:16px;margin-bottom:18px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:10px;text-align:left;font-size:13px;vertical-align:top}th{background:#f3f4f6}.small{font-size:12px;color:#6b7280}p{line-height:1.55}</style>
</head><body>
<h1>PowerBI Guided Capture Report</h1>
<div class="muted">Client: ${escapeHtml(latestData?.clientName || "Unknown")} • Run: ${escapeHtml(latestData?.runId || "")} • States: ${escapeHtml(String(latestData?.totalStates || 0))} • Slices: ${escapeHtml(String(latestData?.totalSlices || 0))} • Extracted datapoints: ${escapeHtml(String(rows.length))}</div>
<div class="card"><h2>Strategic Summary</h2>${paragraphs || "<p>No report text available yet.</p>"}</div>
<div class="card"><h2>Captured States</h2><table><thead><tr><th>State</th><th>Slices</th><th>Captured At</th></tr></thead><tbody>${stateRows}</tbody></table></div>
<div class="card"><h2>Extracted Datapoints</h2><div class="small">Showing up to 120 rows.</div><table><thead><tr><th>Page</th><th>State</th><th>Chart</th><th>Series / App</th><th>Week / X</th><th>Inferred Date</th><th>Value</th><th>Confidence</th></tr></thead><tbody>${dpRows}</tbody></table></div>
</body></html>`;
}

async function buildLatestDataForRun(runId) {
  const runMeta = (await readJsonIfExists(getRunMetaPath(runId), null)) || { runId };
  const statesRoot = getStatesRoot(runId);
  const stateFolders = await fsp.readdir(statesRoot).catch(() => []);
  const states = [];
  const extractedRows = [];
  const weekMappings = [];
  for (const folder of stateFolders) {
    const dir = path.join(statesRoot, folder);
    const stateMeta = await readJsonIfExists(path.join(dir, "state.json"), null);
    const extraction = await readJsonIfExists(path.join(dir, "extraction.json"), null);
    if (!stateMeta) continue;
    states.push({
      stateId: stateMeta.stateId, stepId: stateMeta.stepId || "",
      pageName: stateMeta.pageName || "", stateType: stateMeta.stateType || "baseline",
      filterName: stateMeta.filterName || "", filterValue: stateMeta.filterValue || "",
      capturedAt: stateMeta.capturedAt || "",
      sliceCount: stateMeta.sliceCount || 0,
      aiEnabled: !!extraction?.aiEnabled,
      chartCount: Array.isArray(extraction?.charts) ? extraction.charts.length : 0,
      executiveSummary: Array.isArray(extraction?.executiveSummary) ? extraction.executiveSummary : []
    });
    if (extraction) {
      extractedRows.push(...flattenExtractedRows(stateMeta, extraction));
      if (Array.isArray(extraction.weekMappings)) weekMappings.push(...extraction.weekMappings);
    }
  }
  states.sort((a, b) => String(a.capturedAt || "").localeCompare(String(b.capturedAt || "")));
  return {
    runId: runMeta.runId || runId, clientName: runMeta.clientName || "",
    dashboardUrl: runMeta.dashboardUrl || "", mode: runMeta.mode || "",
    startedAt: runMeta.startedAt || "", finishedAt: runMeta.finishedAt || "",
    updatedAt: nowIso(),
    totalStates: states.length,
    totalSlices: states.reduce((a, s) => a + (s.sliceCount || 0), 0),
    states, extractedRows, weekMappings
  };
}

async function refreshLatestArtifacts(runId) {
  const latestData = await buildLatestDataForRun(runId);
  const reportText = await generateClientAwareReport(latestData);
  latestData.reportText = reportText;
  await writeJson(LATEST_DATA_PATH, latestData);
  await fsp.writeFile(LATEST_REPORT_PATH, buildReportHtml(latestData, reportText), "utf8");
  return latestData;
}

async function safeReadText(res) { try { return await res.text(); } catch { return ""; } }

async function runExtractionInBackground(runId, stateId) {
  try {
    setExtractionStatus(runId, stateId, { stage: "extracting", progress: 20, message: "Preparing screenshots for extraction" });
    const stateMeta = await readJsonIfExists(getStateMetaPath(runId, stateId), null);
    if (!stateMeta) throw new Error("State not found for extraction.");
    const slicesWithData = await loadStateSlicesAsDataUrls(runId, stateId, stateMeta);
    let extraction;
    try {
      extraction = await analyzeStateWithAI(stateMeta, slicesWithData);
      setExtractionStatus(runId, stateId, { stage: "extracting", progress: 70, message: "Extraction returned. Saving results." });
    } catch (err) {
      extraction = { ...buildExtractionFallback(stateMeta), limitations: [`AI extraction failed: ${err.message}`] };
      setExtractionStatus(runId, stateId, { stage: "extracting", progress: 70, message: `Extraction fallback: ${err.message}`, error: err.message });
    }
    await saveExtraction(runId, stateId, extraction);
    setExtractionStatus(runId, stateId, { stage: "reporting", progress: 85, message: "Refreshing report and dataset" });
    await refreshLatestArtifacts(runId);
    setExtractionStatus(runId, stateId, { stage: "done", progress: 100, message: "Extraction complete", finishedAt: nowIso() });
  } catch (err) {
    setExtractionStatus(runId, stateId, { stage: "failed", progress: 100, message: `Extraction pipeline failed: ${err.message}`, error: err.message, finishedAt: nowIso() });
  }
}

app.get("/health", async (req, res) => {
  const latest = await readJsonIfExists(LATEST_DATA_PATH, null);
  res.json({
    ok: true, service: "powerbi-demo-backend", dataDir: DATA_DIR,
    aiEnabled: !!OPENAI_API_KEY, visionModel: OPENAI_VISION_MODEL, textModel: OPENAI_TEXT_MODEL,
    latestRunId: latest?.runId || "",
    totalStates: latest?.totalStates || 0,
    totalSlices: latest?.totalSlices || 0,
    extractedRows: Array.isArray(latest?.extractedRows) ? latest.extractedRows.length : 0
  });
});

app.post("/capture-state/start", async (req, res) => {
  const meta = req.body || {};
  if (!meta.runId || !meta.stateId) return res.status(400).json({ ok: false, error: "Missing runId or stateId." });
  await saveRunMetaFromMeta(meta);
  await initStateMeta(meta, Number(meta.totalSlices || 0));
  setExtractionStatus(meta.runId, meta.stateId, { stage: "receiving", progress: 5, message: "State initialized. Awaiting slices." });
  return res.json({ ok: true });
});

app.post("/capture-state/slice", async (req, res) => {
  const body = req.body || {};
  if (!body.runId || !body.stateId) return res.status(400).json({ ok: false, error: "Missing runId or stateId." });
  if (!body.sliceIndex) return res.status(400).json({ ok: false, error: "Missing sliceIndex." });
  try {
    const stateMeta = await appendSlice(body.runId, body.stateId, body);
    setExtractionStatus(body.runId, body.stateId, {
      stage: "receiving", progress: 10,
      message: `Received slice ${stateMeta.sliceCount}${stateMeta.expectedSliceCount ? ` of ${stateMeta.expectedSliceCount}` : ""}`
    });
    return res.json({ ok: true, sliceCount: stateMeta.sliceCount });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/capture-state/finish", async (req, res) => {
  const { runId, stateId } = req.body || {};
  if (!runId || !stateId) return res.status(400).json({ ok: false, error: "Missing runId or stateId." });
  setExtractionStatus(runId, stateId, { stage: "saved", progress: 15, message: "All slices received. Extraction queued." });
  res.json({ ok: true });
  runExtractionInBackground(runId, stateId).catch(err => {
    setExtractionStatus(runId, stateId, { stage: "failed", progress: 100, message: `Background extraction crashed: ${err.message}`, error: err.message, finishedAt: nowIso() });
  });
});

app.get("/state-status", async (req, res) => {
  const runId = req.query.runId || ""; const stateId = req.query.stateId || "";
  if (!runId || !stateId) return res.status(400).json({ ok: false, error: "Missing runId or stateId." });
  const status = getExtractionStatus(runId, stateId);
  if (!status) return res.status(404).json({ ok: false, error: "No status for that state." });
  return res.json({ ok: true, status });
});

app.post("/finish-run", async (req, res) => {
  const runId = req.body?.runId;
  if (!runId) return res.json({ ok: true });
  const p = getRunMetaPath(runId);
  const m = await readJsonIfExists(p, null);
  if (m) {
    m.finishedAt = req.body?.finishedAt || nowIso();
    m.lastUpdatedAt = nowIso();
    await writeJson(p, m);
    await refreshLatestArtifacts(runId);
  }
  return res.json({ ok: true });
});

app.get("/latest-data", async (req, res) => {
  const latest = await readJsonIfExists(LATEST_DATA_PATH, null);
  if (!latest) return res.status(404).json({ ok: false, error: "No latest data found." });
  return res.json(latest);
});
app.get("/latest-report", async (req, res) => {
  if (!fs.existsSync(LATEST_REPORT_PATH)) return res.status(404).send("No report found yet.");
  return res.sendFile(LATEST_REPORT_PATH);
});
app.post("/ask", async (req, res) => {
  const latest = await readJsonIfExists(LATEST_DATA_PATH, null);
  const q = req.body?.question || "";
  const answer = await answerClosedBook(latest, q);
  return res.json({ ok: true, answer });
});

ensureDirs()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PowerBI backend listening on port ${PORT}`);
      console.log(`DATA_DIR=${DATA_DIR}`);
      console.log(`AI enabled=${!!OPENAI_API_KEY}`);
    });
  })
  .catch(err => { console.error("Failed to initialize backend:", err); process.exit(1); });
