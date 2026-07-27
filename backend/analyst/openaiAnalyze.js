const fs = require("fs");
const path = require("path");

const { getRun, updateRunStatus, saveAnalysis } = require("./store");
const { createSlicesForImage } = require("./imageSlicer");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const DEFAULT_ANALYSIS_PROMPT = `
You are analyzing tagged dashboard screenshots from a business intelligence workflow.

Important: each uploaded dashboard image may have been split into multiple vertical chart slices by the backend.
Treat each slice as a focused sub-view of the same screenshot.

Your job:
1. Read each slice carefully.
2. Use the original file name, page, filter type, filter value, and slice label as grounding metadata.
3. Extract visible numerical values chart by chart.
4. If exact values are not printed, estimate them visually using axis scale, stacked segment height, total bar height, legend colors, and relative proportions.
5. Preserve uncertainty instead of inventing precision.
6. Build one combined executive summary across all slices from all uploaded screenshots.

Important rules:
- Treat page, filter type, and filter value as authoritative metadata.
- Never invent unsupported numbers.
- Prefer rounded approximate values over false precision.
- If a value is estimated from geometry rather than directly read from a label, say so in notes.
- If colors are ambiguous or charts are too compressed, lower confidence and explain why.
- Avoid duplicate rows when multiple slices show overlapping content from the same source screenshot.
- Include source file names for all extracted metrics.
- Use confidence values such as high, medium, or low.

Return ONLY valid JSON with this exact top-level structure:
{
  "numeric_rows": [
    {
      "source_file": "",
      "page": "",
      "filter_type": "",
      "filter_value": "",
      "metric": "",
      "value": "",
      "unit": "",
      "confidence": "",
      "notes": ""
    }
  ],
  "text_rows": [
    {
      "source_file": "",
      "page": "",
      "filter_type": "",
      "filter_value": "",
      "label": "",
      "text": "",
      "notes": ""
    }
  ],
  "summary": "",
  "report": {
    "title": "",
    "executive_summary": [],
    "key_findings": [],
    "recommendations": [],
    "data_quality_notes": []
  }
}
`.trim();

function filePathToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let mime = "image/png";
  if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
  if (ext === ".webp") mime = "image/webp";
  if (ext === ".gif") mime = "image/gif";
  const base64 = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${base64}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeReport(report) {
  const safe = report && typeof report === "object" ? report : {};
  return {
    title: ensureString(safe.title),
    executive_summary: ensureArray(safe.executive_summary).map(String),
    key_findings: ensureArray(safe.key_findings).map(String),
    recommendations: ensureArray(safe.recommendations).map(String),
    data_quality_notes: ensureArray(safe.data_quality_notes).map(String)
  };
}

function normalizeRows(rows, mapper) {
  return ensureArray(rows).map(mapper);
}

function normalizeAnalysis(raw, run) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    runId: run.runId,
    workspaceName: run.workspaceName,
    createdAt: new Date().toISOString(),
    numeric_rows: normalizeRows(safe.numeric_rows, (row) => ({
      source_file: ensureString(row.source_file),
      page: ensureString(row.page),
      filter_type: ensureString(row.filter_type),
      filter_value: ensureString(row.filter_value),
      metric: ensureString(row.metric),
      value: ensureString(row.value),
      unit: ensureString(row.unit),
      confidence: ensureString(row.confidence),
      notes: ensureString(row.notes)
    })),
    text_rows: normalizeRows(safe.text_rows, (row) => ({
      source_file: ensureString(row.source_file),
      page: ensureString(row.page),
      filter_type: ensureString(row.filter_type),
      filter_value: ensureString(row.filter_value),
      label: ensureString(row.label),
      text: ensureString(row.text),
      notes: ensureString(row.notes)
    })),
    summary: ensureString(safe.summary),
    report: normalizeReport(safe.report)
  };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("OpenAI response was not valid JSON");
    return JSON.parse(match[0]);
  }
}

async function buildSliceInputs(run) {
  const slices = [];
  for (const file of run.files) {
    const fileDir = path.dirname(file.imagePath);
    const sliceOutputDir = path.join(fileDir, "slices", path.parse(file.storedFileName || file.fileName || "upload").name);
    const sliced = await createSlicesForImage({
      imagePath: file.imagePath,
      outputDir: sliceOutputDir,
      prefix: path.parse(file.storedFileName || file.fileName || "upload").name
    });
    for (const slice of sliced.slices) {
      slices.push({
        sourceFile: file.fileName,
        page: file.page,
        filterType: file.filterType,
        filterValue: file.filterValue,
        note: file.note || "",
        sliceLabel: slice.sliceLabel,
        sliceIndex: slice.sliceIndex,
        slicePath: slice.slicePath,
        totalSlicesForFile: sliced.sliceCount
      });
    }
  }
  return slices;
}

async function analyzeRunWithOpenAI({ workspaceName, runId, promptOverride }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing on the backend");
  const run = getRun(workspaceName, runId);
  if (!run) throw new Error("Run not found");
  if (!Array.isArray(run.files) || !run.files.length) throw new Error("No uploaded screenshots found for this run");

  updateRunStatus({ workspaceName, runId, status: "extracting", error: null });
  const sliceInputs = await buildSliceInputs(run);
  if (!sliceInputs.length) throw new Error("No chart slices could be created from the uploaded screenshots");

  const metadataBlock = sliceInputs.map((slice, index) => [
    `${index + 1}.`,
    `source_file=${slice.sourceFile}`,
    `page=${slice.page}`,
    `filter_type=${slice.filterType}`,
    `filter_value=${slice.filterValue}`,
    `slice_label=${slice.sliceLabel}`,
    `slice_index=${slice.sliceIndex}`,
    `slices_for_file=${slice.totalSlicesForFile}`,
    `note=${slice.note}`
  ].join(" ")).join("\n");

  const userContent = [{
    type: "text",
    text: [promptOverride || DEFAULT_ANALYSIS_PROMPT, "", "Slice metadata:", metadataBlock].join("\n")
  }];

  sliceInputs.forEach((slice) => {
    userContent.push({
      type: "image_url",
      image_url: { url: filePathToDataUrl(slice.slicePath), detail: "high" }
    });
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a meticulous BI analyst. Extract only visually supported values from chart slices. If exact labels are missing, estimate visually from axes, bars, segments, legends, and relative heights. Never fabricate unsupported numbers. Return valid JSON only."
        },
        { role: "user", content: userContent }
      ]
    })
  });

  const raw = await response.json();
  if (!response.ok) throw new Error(raw?.error?.message || "OpenAI analysis request failed");
  const content = raw?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty analysis response");

  const parsed = parseJsonSafe(content);
  const normalized = normalizeAnalysis(parsed, run);
  saveAnalysis({ workspaceName, runId, analysis: normalized });
  return normalized;
}

module.exports = { analyzeRunWithOpenAI, DEFAULT_ANALYSIS_PROMPT };
