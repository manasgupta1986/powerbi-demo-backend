const fs = require("fs");
const path = require("path");

const {
  getRun,
  updateRunStatus,
  saveAnalysis
} = require("./store");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const DEFAULT_ANALYSIS_PROMPT = `
You are analyzing tagged dashboard screenshots from a business intelligence workflow.

Your job:
1. Read every screenshot carefully.
2. Use the filename and tag context as strong grounding signals.
3. Extract visible numerical values chart by chart.
4. Preserve uncertainty instead of inventing values.
5. Build an executive summary across the uploaded screenshots.

Important rules:
- Treat page, filter type, and filter value as authoritative metadata.
- If a value is unclear, mark it as uncertain and explain why.
- Do not infer numbers not visible in the screenshot.
- Include source file names for all extracted metrics.
- Highlight patterns, leaders, laggards, and notable deltas only when grounded in visible evidence.

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

function normalizeAnalysis(raw, run) {
  const safe = raw && typeof raw === "object" ? raw : {};

  return {
    runId: run.runId,
    workspaceName: run.workspaceName,
    createdAt: new Date().toISOString(),
    numeric_rows: ensureArray(safe.numeric_rows).map((row) => ({
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
    text_rows: ensureArray(safe.text_rows).map((row) => ({
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
  } catch (error) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("OpenAI response was not valid JSON");
    }
    return JSON.parse(match[0]);
  }
}

async function analyzeRunWithOpenAI({
  workspaceName,
  runId,
  promptOverride
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing on the backend");
  }

  const run = getRun(workspaceName, runId);
  if (!run) {
    throw new Error("Run not found");
  }

  if (!Array.isArray(run.files) || !run.files.length) {
    throw new Error("No uploaded screenshots found for this run");
  }

  updateRunStatus({
    workspaceName,
    runId,
    status: "extracting",
    error: null
  });

  const metadataBlock = run.files
    .map((file, index) => {
      return [
        `${index + 1}.`,
        `source_file=${file.fileName}`,
        `page=${file.page}`,
        `filter_type=${file.filterType}`,
        `filter_value=${file.filterValue}`,
        `note=${file.note || ""}`
      ].join(" ");
    })
    .join("\n");

  const userContent = [
    {
      type: "text",
      text: [
        promptOverride || DEFAULT_ANALYSIS_PROMPT,
        "",
        "Screenshot metadata:",
        metadataBlock
      ].join("\n")
    }
  ];

  for (const file of run.files) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: filePathToDataUrl(file.imagePath),
        detail: "high"
      }
    });
  }

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
          content:
            "You are a meticulous BI analyst. Extract only visible values from screenshots. Never fabricate numbers. Return valid JSON only."
        },
        {
          role: "user",
          content: userContent
        }
      ]
    })
  });

  const raw = await response.json();

  if (!response.ok) {
    throw new Error(raw?.error?.message || "OpenAI analysis request failed");
  }

  const content = raw?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty analysis response");
  }

  const parsed = parseJsonSafe(content);
  const normalized = normalizeAnalysis(parsed, run);

  saveAnalysis({
    workspaceName,
    runId,
    analysis: normalized
  });

  return normalized;
}

module.exports = {
  analyzeRunWithOpenAI,
  DEFAULT_ANALYSIS_PROMPT
};
