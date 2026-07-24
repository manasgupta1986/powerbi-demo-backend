const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "120mb" }));

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

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(RUNS_DIR, { recursive: true });
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
}

function safeFileName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "item";
}

function stripDataUrlPrefix(dataUrl) {
  const raw = String(dataUrl || "");
  const idx = raw.indexOf(",");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function nowIso() { return new Date().toISOString(); }

function getRunDir(runId) { return path.join(RUNS_DIR, safeFileName(runId)); }
function getRunMetaPath(runId) { return path.join(getRunDir(runId), "run.json"); }
function getStatesRoot(runId) { return path.join(getRunDir(runId), "states"); }
function getStateDir(runId, stateId) { return path.join(getStatesRoot(runId), safeFileName(stateId)); }
function getStateMetaPath(runId, stateId) { return path.join(getStateDir(runId, stateId), "state.json"); }
function getStateExtractionPath(runId, stateId) { return path.join(getStateDir(runId, stateId), "extraction.json"); }
function getStateImagesDir(runId, stateId) { return path.join(getStateDir(runId, stateId), "images"); }

async function saveRunMetaFromPayload(payload) {
  const runDir = getRunDir(payload.runId);
  await fsp.mkdir(runDir, { recursive: true });

  const runMetaPath = getRunMetaPath(payload.runId);
  const existing = (await readJsonIfExists(runMetaPath, null)) || {};

  const next = {
    runId: payload.runId,
    clientName: payload.clientName || existing.clientName || "",
    dashboardUrl: payload.dashboardUrl || existing.dashboardUrl || "",
    mode: payload.mode || existing.mode || "GUIDED_CAPTURE_MANUAL_SET_AUTO_SCROLL",
    startedAt: existing.startedAt || payload.startedAt || nowIso(),
    finishedAt: existing.finishedAt || "",
    lastUpdatedAt: nowIso()
  };

  await writeJson(runMetaPath, next);
  return next;
}

async function saveSlices(runId, stateId, slices) {
  const imagesDir = getStateImagesDir(runId, stateId);
  await fsp.mkdir(imagesDir, { recursive: true });

  const savedSlices = [];

  for (const slice of slices || []) {
    const index = slice.sliceIndex || savedSlices.length + 1;
    const fileName = `slice_${String(index).padStart(2, "0")}.png`;
    const filePath = path.join(imagesDir, fileName);
    const base64 = stripDataUrlPrefix(slice.imageDataUrl || "");

    if (base64) {
      await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
    }

    savedSlices.push({
      sliceIndex: index,
      scrollY: slice.scrollY || 0,
      viewportWidth: slice.viewportWidth || 0,
      viewportHeight: slice.viewportHeight || 0,
      totalScrollHeight: slice.totalScrollHeight || 0,
      clientHeight: slice.clientHeight || 0,
      capturedAt: slice.capturedAt || nowIso(),
      imageFile: fileName,
      imagePath: filePath
    });
  }

  return savedSlices;
}

async function saveStateMeta(payload, savedSlices) {
  const stateDir = getStateDir(payload.runId, payload.stateId);
  await fsp.mkdir(stateDir, { recursive: true });

  const stateMeta = {
    runId: payload.runId,
    stateId: payload.stateId,
    stepId: payload.stepId || "",
    clientName: payload.clientName || "",
    dashboardUrl: payload.dashboardUrl || "",
    pageName: payload.pageName || "",
    stateType: payload.stateType || "baseline",
    filterName: payload.filterName || "",
    filterValue: payload.filterValue || "",
    capturedAt: payload.capturedAt || nowIso(),
    sliceCount: savedSlices.length,
    slices: savedSlices
  };

  await writeJson(getStateMetaPath(payload.runId, payload.stateId), stateMeta);
  return stateMeta;
}

function selectRepresentativeSlices(slices, maxCount) {
  const arr = Array.isArray(slices) ? slices : [];
  if (arr.length <= maxCount) return arr;

  const indexes = new Set();
  indexes.add(0);
  indexes.add(arr.length - 1);
  indexes.add(Math.floor(arr.length / 2));

  while (indexes.size < Math.min(maxCount, arr.length)) {
    const ratio = indexes.size / Math.max(1, maxCount - 1);
    indexes.add(Math.min(arr.length - 1, Math.floor(ratio * (arr.length - 1))));
  }

  const picked = [...indexes].sort((a, b) => a - b).slice(0, maxCount);
  return picked.map((i) => arr[i]);
}

function buildExtractionFallback(stateMeta) {
  return {
    aiEnabled: false,
    extractedAt: nowIso(),
    stateSummary: {
      pageName: stateMeta.pageName || "",
      stateType: stateMeta.stateType || "baseline",
      filterName: stateMeta.filterName || "",
      filterValue: stateMeta.filterValue || "",
      note: "AI extraction not available. Stored metadata only."
    },
    weekMappings: [],
    charts: [],
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
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages
    })
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`OpenAI JSON call failed: HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function callOpenAIChatText({ model, messages, temperature = 0.2 }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`OpenAI text call failed: HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }

  const json = await res.json();
  return json?.choices?.[0]?.message?.content || "";
}

function normalizeExtractionResult(raw, stateMeta) {
  const charts = Array.isArray(raw?.charts) ? raw.charts : [];
  const weekMappings = Array.isArray(raw?.weekMappings) ? raw.weekMappings : [];
  const executiveSummary = Array.isArray(raw?.executiveSummary) ? raw.executiveSummary : [];
  const limitations = Array.isArray(raw?.limitations) ? raw.limitations : [];

  const safeCharts = charts.map((chart, chartIndex) => {
    const datapoints = Array.isArray(chart?.datapoints) ? chart.datapoints : [];
    return {
      chartId: chart?.chartId || `chart_${chartIndex + 1}`,
      title: chart?.title || `Chart ${chartIndex + 1}`,
      chartType: chart?.chartType || "",
      xAxisLabel: chart?.xAxisLabel || "",
      yAxisLabel: chart?.yAxisLabel || "",
      unit: chart?.unit || "",
      seriesNames: Array.isArray(chart?.seriesNames) ? chart.seriesNames : [],
      datapoints: datapoints.map((dp) => ({
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
    aiEnabled: true,
    extractedAt: nowIso(),
    stateSummary: {
      pageName: stateMeta.pageName || "",
      stateType: stateMeta.stateType || "baseline",
      filterName: stateMeta.filterName || "",
      filterValue: stateMeta.filterValue || "",
      chartCount: safeCharts.length
    },
    weekMappings: weekMappings.map((m) => ({
      weekCode: m?.weekCode || "",
      inferredStartDate: m?.inferredStartDate || null,
      confidence: typeof m?.confidence === "number" ? m.confidence : null,
      evidence: m?.evidence || ""
    })),
    charts: safeCharts,
    executiveSummary,
    limitations
  };
}

async function analyzeStateWithAI(payload, stateMeta) {
  if (!OPENAI_API_KEY) return buildExtractionFallback(stateMeta);

  const representative = selectRepresentativeSlices(payload.slices || [], MAX_AI_SLICES);

  const content = [
    {
      type: "text",
      text:
        `You are analyzing dashboard screenshots for structured data extraction.\n` +
        `The result must be based ONLY on the screenshots and the supplied state metadata.\n` +
        `Do NOT use outside knowledge.\n\n` +
        `State metadata:\n` +
        `- clientName: ${payload.clientName || ""}\n` +
        `- pageName: ${payload.pageName || ""}\n` +
        `- stateType: ${payload.stateType || "baseline"}\n` +
        `- filterName: ${payload.filterName || ""}\n` +
        `- filterValue: ${payload.filterValue || ""}\n\n` +
        `Return strict JSON with this structure:\n` +
        `{\n` +
        `  "weekMappings": [{"weekCode":"2026-W1","inferredStartDate":"2026-01-05","confidence":0.7,"evidence":"..."}],\n` +
        `  "charts": [\n` +
        `    {\n` +
        `      "chartId":"chart_1",\n` +
        `      "title":"...",\n` +
        `      "chartType":"line|bar|stacked bar|table|other",\n` +
        `      "xAxisLabel":"...",\n` +
        `      "yAxisLabel":"...",\n` +
        `      "unit":"%|share|index|count|currency|other",\n` +
        `      "seriesNames":["..."],\n` +
        `      "datapoints":[\n` +
        `        {\n` +
        `          "seriesName":"...",\n` +
        `          "appName":"...",\n` +
        `          "xLabel":"...",\n` +
        `          "weekCode":"...",\n` +
        `          "inferredStartDate":"YYYY-MM-DD or null",\n` +
        `          "value":12.3,\n` +
        `          "unit":"%",\n` +
        `          "confidence":0.8,\n` +
        `          "note":"approximate OCR/visual estimate if needed"\n` +
        `        }\n` +
        `      ],\n` +
        `      "insights":["short factual numeric observations only"]\n` +
        `    }\n` +
        `  ],\n` +
        `  "executiveSummary":["short factual bullet style statements with numbers if visible"],\n` +
        `  "limitations":["what could not be read clearly"]\n` +
        `}\n\n` +
        `Rules:\n` +
        `- Extract approximate numeric values where possible.\n` +
        `- If a chart is unreadable, omit uncertain datapoints instead of inventing values.\n` +
        `- Preserve week codes exactly if visible.\n` +
        `- Only infer dates if there is visible evidence in the screenshots.\n` +
        `- Stay closed-book.`
    }
  ];

  for (const slice of representative) {
    if (slice?.imageDataUrl) {
      content.push({
        type: "image_url",
        image_url: { url: slice.imageDataUrl }
      });
    }
  }

  const raw = await callOpenAIChatJSON({
    model: OPENAI_VISION_MODEL,
    temperature: 0.1,
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
  const charts = Array.isArray(extraction?.charts) ? extraction.charts : [];

  for (const chart of charts) {
    const datapoints = Array.isArray(chart?.datapoints) ? chart.datapoints : [];
    for (const dp of datapoints) {
      rows.push({
        runId: stateMeta.runId,
        stateId: stateMeta.stateId,
        pageName: stateMeta.pageName || "",
        stateType: stateMeta.stateType || "baseline",
        filterName: stateMeta.filterName || "",
        filterValue: stateMeta.filterValue || "",
        chartTitle: chart?.title || "",
        chartType: chart?.chartType || "",
        xAxisLabel: chart?.xAxisLabel || "",
        yAxisLabel: chart?.yAxisLabel || "",
        unit: dp?.unit || chart?.unit || "",
        seriesName: dp?.seriesName || "",
        appName: dp?.appName || dp?.seriesName || "",
        xLabel: dp?.xLabel || "",
        weekCode: dp?.weekCode || "",
        inferredStartDate: dp?.inferredStartDate || null,
        value: typeof dp?.value === "number" ? dp.value : null,
        confidence: typeof dp?.confidence === "number" ? dp.confidence : null,
        note: dp?.note || "",
        capturedAt: stateMeta.capturedAt || ""
      });
    }
  }

  return rows;
}

function buildComparableKey(row) {
  return [
    row.pageName || "",
    row.filterName || "",
    row.filterValue || "",
    row.chartTitle || "",
    row.seriesName || row.appName || ""
  ].join(" | ");
}

function sortRowsChronologically(rows) {
  return [...rows].sort((a, b) => {
    const ad = a.inferredStartDate || "";
    const bd = b.inferredStartDate || "";
    if (ad && bd && ad !== bd) return ad.localeCompare(bd);

    const aw = a.weekCode || "";
    const bw = b.weekCode || "";
    if (aw !== bw) return aw.localeCompare(bw);

    return String(a.xLabel || "").localeCompare(String(b.xLabel || ""));
  });
}

function buildHeuristicReport(latestData) {
  const rows = Array.isArray(latestData?.extractedRows) ? latestData.extractedRows : [];
  const client = latestData?.clientName || "the client";
  const states = latestData?.states || [];

  if (!rows.length) {
    return [
      `Report for ${client}:`,
      `The latest run captured ${states.length} state(s), but no numeric chart datapoints were extracted yet.`,
      `Stored states are available for review, and chart-value extraction can improve as screenshot clarity and coverage increase.`
    ].join("\n\n");
  }

  const groups = new Map();
  for (const row of rows) {
    const key = buildComparableKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const movementLines = [];
  for (const [key, groupRows] of groups.entries()) {
    const ordered = sortRowsChronologically(groupRows).filter((r) => typeof r.value === "number");
    if (ordered.length >= 2) {
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const delta = +(last.value - first.value).toFixed(2);
      movementLines.push(
        `${last.seriesName || last.appName || "Series"} in ${last.chartTitle || "chart"} moved from ${first.value}${first.unit || ""} to ${last.value}${last.unit || ""} (${delta >= 0 ? "+" : ""}${delta}${last.unit || ""}) across the observed period.`
      );
    }
  }

  return [
    `Report for ${client}:`,
    `The latest run includes ${latestData.totalStates || 0} state(s), ${latestData.totalSlices || 0} slice(s), and ${rows.length} extracted datapoint(s).`,
    movementLines.length
      ? movementLines.slice(0, 8).join(" ")
      : `Numeric datapoints were extracted, but there were not enough comparable points to compute trend movement robustly.`,
    `This report is based only on captured dashboard screenshots.`
  ].join("\n\n");
}

function buildAskFallback(latestData, question) {
  const rows = Array.isArray(latestData?.extractedRows) ? latestData.extractedRows : [];
  const states = latestData?.states || [];
  const q = String(question || "").trim().toLowerCase();

  if (!latestData) return "I do not have any captured dashboard data yet.";

  if (q.includes("summary") || q.includes("overview") || q.includes("what did we capture") || q.includes("what was captured")) {
    return `The latest run contains ${latestData.totalStates || states.length} state(s), ${latestData.totalSlices || 0} slice(s), and ${rows.length} extracted datapoint(s).`;
  }
  if (q.includes("how many states")) return `The latest run contains ${latestData.totalStates || states.length} captured state(s).`;
  if (q.includes("how many slices")) return `The latest run contains ${latestData.totalSlices || 0} captured slice(s).`;

  const matchedRows = rows.filter((r) => {
    const text = [r.pageName, r.filterName, r.filterValue, r.chartTitle, r.seriesName, r.appName, r.weekCode, r.xLabel].join(" ").toLowerCase();
    return q && (text.includes(q) || q.split(/\s+/).some((token) => token && text.includes(token)));
  });

  if (matchedRows.length) {
    const sample = matchedRows.slice(0, 8).map((r) => {
      const series = r.seriesName || r.appName || "series";
      const point = r.weekCode || r.xLabel || "point";
      const value = typeof r.value === "number" ? `${r.value}${r.unit || ""}` : "unreadable";
      const scope = r.filterName ? `${r.pageName} / ${r.filterName}=${r.filterValue}` : `${r.pageName} baseline`;
      return `${scope} → ${series} at ${point}: ${value}`;
    });

    return `I found matching extracted datapoints: ${sample.join("; ")}.`;
  }

  if (rows.length) {
    return `I could not answer that confidently from the extracted dataset alone. The latest run contains ${rows.length} datapoint(s), but I do not see a direct match for your question in the stored extraction output.`;
  }
  return `I could not answer that from extracted dashboard data. The latest run has stored states, but no numeric extraction rows are available yet.`;
}

function buildCondensedDataset(latestData, limit = 350) {
  const rows = Array.isArray(latestData?.extractedRows) ? latestData.extractedRows : [];
  return {
    runId: latestData?.runId || "",
    clientName: latestData?.clientName || "",
    totalStates: latestData?.totalStates || 0,
    totalSlices: latestData?.totalSlices || 0,
    weekMappings: Array.isArray(latestData?.weekMappings) ? latestData.weekMappings : [],
    states: (latestData?.states || []).map((s) => ({
      pageName: s.pageName || "",
      stateType: s.stateType || "baseline",
      filterName: s.filterName || "",
      filterValue: s.filterValue || "",
      sliceCount: s.sliceCount || 0,
      capturedAt: s.capturedAt || ""
    })),
    extractedRows: rows.slice(0, limit)
  };
}

async function generateClientAwareReport(latestData) {
  const rows = Array.isArray(latestData?.extractedRows) ? latestData.extractedRows : [];
  if (!OPENAI_API_KEY || !rows.length) return buildHeuristicReport(latestData);

  const dataset = buildCondensedDataset(latestData, 300);

  try {
    const text = await callOpenAIChatText({
      model: OPENAI_TEXT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You write concise business analysis from structured dashboard data only. " +
            "Do not use external knowledge. Use numeric values whenever available. " +
            "If a number is approximate, say approximately. " +
            "Frame the report from the named client's perspective."
        },
        {
          role: "user",
          content:
            `Write a strategic report for client "${latestData.clientName || ""}".\n` +
            `Rules:\n` +
            `- Use ONLY the provided dataset.\n` +
            `- Focus on trends over the last 4 weeks where possible.\n` +
            `- Mention numeric movement explicitly.\n` +
            `- If dates are not confidently known, use visible week codes.\n` +
            `- If evidence is thin, say so.\n\n` +
            `Dataset JSON:\n${JSON.stringify(dataset)}`
        }
      ]
    });

    return text || buildHeuristicReport(latestData);
  } catch {
    return buildHeuristicReport(latestData);
  }
}

async function answerClosedBook(latestData, question) {
  const rows = Array.isArray(latestData?.extractedRows) ? latestData.extractedRows : [];
  if (!OPENAI_API_KEY || !rows.length) return buildAskFallback(latestData, question);

  const dataset = buildCondensedDataset(latestData, 300);

  try {
    const text = await callOpenAIChatText({
      model: OPENAI_TEXT_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Answer questions using ONLY the provided dashboard dataset. " +
            "Do not use external knowledge. If the answer is not in the data, say that clearly. " +
            "Be numeric when possible."
        },
        {
          role: "user",
          content: `Question: ${question}\n\nDataset JSON:\n${JSON.stringify(dataset)}`
        }
      ]
    });

    return text || buildAskFallback(latestData, question);
  } catch {
    return buildAskFallback(latestData, question);
  }
}

function buildReportHtml(latestData, reportText) {
  const states = latestData?.states || [];
  const rows = latestData?.extractedRows || [];
  const stateRowsHtml = states.length
    ? states.map((s) => {
        const label = s.stateType === "baseline"
          ? `${s.pageName} — Baseline`
          : `${s.pageName} — ${s.filterName} = ${s.filterValue}`;
        return `
          <tr>
            <td>${escapeHtml(label)}</td>
            <td>${escapeHtml(String(s.sliceCount || 0))}</td>
            <td>${escapeHtml(s.capturedAt || "")}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="3">No states available.</td></tr>`;

  const datapointRowsHtml = rows.length
    ? rows.slice(0, 120).map((r) => `
        <tr>
          <td>${escapeHtml(r.pageName || "")}</td>
          <td>${escapeHtml(r.filterName ? `${r.filterName} = ${r.filterValue}` : "Baseline")}</td>
          <td>${escapeHtml(r.chartTitle || "")}</td>
          <td>${escapeHtml(r.seriesName || r.appName || "")}</td>
          <td>${escapeHtml(r.weekCode || r.xLabel || "")}</td>
          <td>${escapeHtml(r.inferredStartDate || "")}</td>
          <td>${escapeHtml(typeof r.value === "number" ? String(r.value) : "")}${escapeHtml(r.unit || "")}</td>
          <td>${escapeHtml(typeof r.confidence === "number" ? String(r.confidence) : "")}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="8">No extracted numeric datapoints yet.</td></tr>`;

  const reportParagraphs = String(reportText || "")
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml("PowerBI Guided Capture Report")}</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; margin: 24px; color: #111827; }
    h1 { margin-bottom: 8px; }
    h2 { margin-top: 0; }
    .muted { color: #6b7280; margin-bottom: 20px; }
    .card { border: 1px solid #d1d5db; border-radius: 12px; padding: 16px; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #d1d5db; padding: 10px; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #f3f4f6; }
    .small { font-size: 12px; color: #6b7280; }
    p { line-height: 1.55; }
  </style>
</head>
<body>
  <h1>PowerBI Guided Capture Report</h1>
  <div class="muted">
    Client: ${escapeHtml(latestData?.clientName || "Unknown")} •
    Run: ${escapeHtml(latestData?.runId || "")} •
    States: ${escapeHtml(String(latestData?.totalStates || 0))} •
    Slices: ${escapeHtml(String(latestData?.totalSlices || 0))} •
    Extracted datapoints: ${escapeHtml(String((latestData?.extractedRows || []).length))}
  </div>

  <div class="card">
    <h2>Strategic Summary</h2>
    ${reportParagraphs || "<p>No report text available yet.</p>"}
  </div>

  <div class="card">
    <h2>Captured States</h2>
    <table>
      <thead>
        <tr>
          <th>State</th>
          <th>Slices</th>
          <th>Captured At</th>
        </tr>
      </thead>
      <tbody>
        ${stateRowsHtml}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Extracted Datapoints</h2>
    <div class="small">Showing up to 120 extracted rows.</div>
    <table>
      <thead>
        <tr>
          <th>Page</th>
          <th>State</th>
          <th>Chart</th>
          <th>Series / App</th>
          <th>Week / X</th>
          <th>Inferred Date</th>
          <th>Value</th>
          <th>Confidence</th>
        </tr>
      </thead>
      <tbody>
        ${datapointRowsHtml}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

async function buildLatestDataForRun(runId) {
  const runMeta = (await readJsonIfExists(getRunMetaPath(runId), null)) || {
    runId,
    clientName: "",
    dashboardUrl: "",
    mode: "GUIDED_CAPTURE_MANUAL_SET_AUTO_SCROLL",
    startedAt: "",
    finishedAt: "",
    lastUpdatedAt: nowIso()
  };

  const statesRoot = getStatesRoot(runId);
  const stateFolders = await fsp.readdir(statesRoot).catch(() => []);

  const states = [];
  const extractedRows = [];
  const weekMappings = [];

  for (const folder of stateFolders) {
    const stateDir = path.join(statesRoot, folder);
    const stateMeta = await readJsonIfExists(path.join(stateDir, "state.json"), null);
    const extraction = await readJsonIfExists(path.join(stateDir, "extraction.json"), null);

    if (!stateMeta) continue;

    states.push({
      stateId: stateMeta.stateId,
      stepId: stateMeta.stepId || "",
      pageName: stateMeta.pageName || "",
      stateType: stateMeta.stateType || "baseline",
      filterName: stateMeta.filterName || "",
      filterValue: stateMeta.filterValue || "",
      capturedAt: stateMeta.capturedAt || "",
      sliceCount: stateMeta.sliceCount || 0,
      aiEnabled: !!extraction?.aiEnabled,
      chartCount: Array.isArray(extraction?.charts) ? extraction.charts.length : 0,
      executiveSummary: Array.isArray(extraction?.executiveSummary) ? extraction.executiveSummary : []
    });

    if (extraction) {
      extractedRows.push(...flattenExtractedRows(stateMeta, extraction));
      if (Array.isArray(extraction.weekMappings)) {
        weekMappings.push(...extraction.weekMappings);
      }
    }
  }

  states.sort((a, b) => String(a.capturedAt || "").localeCompare(String(b.capturedAt || "")));

  return {
    runId: runMeta.runId || runId,
    clientName: runMeta.clientName || "",
    dashboardUrl: runMeta.dashboardUrl || "",
    mode: runMeta.mode || "",
    startedAt: runMeta.startedAt || "",
    finishedAt: runMeta.finishedAt || "",
    updatedAt: nowIso(),
    totalStates: states.length,
    totalSlices: states.reduce((a, s) => a + (s.sliceCount || 0), 0),
    states,
    extractedRows,
    weekMappings
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

async function safeReadText(res) {
  try { return await res.text(); } catch { return ""; }
}

app.get("/health", async (req, res) => {
  const latest = await readJsonIfExists(LATEST_DATA_PATH, null);
  res.json({
    ok: true,
    service: "powerbi-demo-backend",
    dataDir: DATA_DIR,
    aiEnabled: !!OPENAI_API_KEY,
    visionModel: OPENAI_VISION_MODEL,
    textModel: OPENAI_TEXT_MODEL,
    latestRunId: latest?.runId || "",
    totalStates: latest?.totalStates || 0,
    totalSlices: latest?.totalSlices || 0,
    extractedRows: Array.isArray(latest?.extractedRows) ? latest.extractedRows.length : 0
  });
});

app.post("/capture-state", async (req, res) => {
  const payload = req.body || {};

  if (!payload.runId) return res.status(400).json({ ok: false, error: "Missing runId." });
  if (!payload.stateId) return res.status(400).json({ ok: false, error: "Missing stateId." });
  if (!Array.isArray(payload.slices) || !payload.slices.length) {
    return res.status(400).json({ ok: false, error: "Missing slices." });
  }

  await saveRunMetaFromPayload(payload);
  const savedSlices = await saveSlices(payload.runId, payload.stateId, payload.slices);
  const stateMeta = await saveStateMeta(payload, savedSlices);

  let extraction;
  try {
    extraction = await analyzeStateWithAI(payload, stateMeta);
  } catch (err) {
    extraction = { ...buildExtractionFallback(stateMeta), limitations: [`AI extraction failed: ${err.message}`] };
  }

  await saveExtraction(payload.runId, payload.stateId, extraction);
  const latestData = await refreshLatestArtifacts(payload.runId);

  return res.json({
    ok: true,
    runId: payload.runId,
    stateId: payload.stateId,
    savedSlices: savedSlices.length,
    extractedCharts: Array.isArray(extraction?.charts) ? extraction.charts.length : 0,
    extractedRows: Array.isArray(latestData?.extractedRows) ? latestData.extractedRows.length : 0,
    latestData
  });
});

app.post("/finish-run", async (req, res) => {
  const runId = req.body?.runId;
  if (!runId) return res.json({ ok: true });

  const runMetaPath = getRunMetaPath(runId);
  const runMeta = await readJsonIfExists(runMetaPath, null);
  if (runMeta) {
    runMeta.finishedAt = req.body?.finishedAt || nowIso();
    runMeta.lastUpdatedAt = nowIso();
    await writeJson(runMetaPath, runMeta);
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
  const question = req.body?.question || "";
  const answer = await answerClosedBook(latest, question);
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
  .catch((err) => {
    console.error("Failed to initialize backend:", err);
    process.exit(1);
  });
