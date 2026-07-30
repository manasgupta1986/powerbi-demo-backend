const path = require("path");
const sharp = require("sharp");

const { getRun, updateRunStatus, updateRunProgress, saveAnalysis } = require("./store");
const { createSlicesForImage } = require("./imageSlicer");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const MAX_IMAGES_PER_BATCH = Math.max(1, Number(process.env.ANALYST_MAX_IMAGES_PER_BATCH || 3));
const MAX_SLICES_PER_FILE = Math.max(1, Number(process.env.ANALYST_MAX_SLICES_PER_FILE || 6));
const MAX_AXIS_SLICES_PER_FILE = Math.max(1, Number(process.env.ANALYST_MAX_AXIS_SLICES_PER_FILE || 3));
const DEFAULT_VISION_MAX_WIDTH = Math.max(700, Number(process.env.ANALYST_VISION_MAX_WIDTH || 1100));
const DEFAULT_VISION_DETAIL = process.env.ANALYST_VISION_DETAIL || "low";
const EST_SECONDS_PER_SLICE = Math.max(3, Number(process.env.ANALYST_EST_SECONDS_PER_SLICE || 8));
const EST_SECONDS_FOR_SUMMARY = Math.max(4, Number(process.env.ANALYST_EST_SECONDS_FOR_SUMMARY || 10));
const ALLOWED_APP_NAMES = ["Ajio", "Amazon", "Amazon Now", "Bigbasket", "Blinkit", "Flipkart", "Flipkart Minutes", "Instamart", "Meesho", "Myntra", "Nykaa", "Shopsy", "Zepto"];

const DEFAULT_ANALYSIS_PROMPT = `
You are analyzing tagged dashboard screenshots from a business intelligence workflow.

Core principles:
- Screenshots belong to page families such as Traffic Engagement or Purchase Funnel.
- Some screenshots are baseline views. Other screenshots are filtered cuts.
- Always understand the baseline first, then compare filtered cuts against that baseline.
- Do not hardcode a fixed narrative template. Instead, identify the most important problems visible in the evidence.
- Surface the top 4 highest-priority insights based on business impact, recent deterioration, competitive threat, breadth across cuts, and confidence.
- Key findings must be insight-led, not chart narration.
- Do not hallucinate categories, cohorts, or dimensions that are not visible.
- Preserve visible week labels and week start dates when present.
- Read the chart title, subtitle, chart type, x-axis, y-axis title, units, and visible tick marks before interpreting the series.
- When the y-axis and line/bar positions make a value reasonably legible, estimate conservative values for visible apps rather than leaving the chart as coverage-only.
- If an exact number is not printed, estimate from the y-axis with explicit confidence and say so in notes.
- Prefer a few grounded numeric estimates (latest point, peak, trough, obvious step-change, dominant share) over many weak guesses.

Return only valid JSON using this structure:
{
  "time_hints": [
    {
      "source_file": "",
      "page": "",
      "filter_type": "",
      "filter_value": "",
      "visible_weeks": [
        {
          "week_label": "",
          "week_start_date": "",
          "confidence": "",
          "notes": ""
        }
      ]
    }
  ],
  "numeric_rows": [
    {
      "source_file": "",
      "page": "",
      "comparison_mode": "",
      "filter_type": "",
      "filter_value": "",
      "time_period": "",
      "week_start_date": "",
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
      "comparison_mode": "",
      "filter_type": "",
      "filter_value": "",
      "time_period": "",
      "week_start_date": "",
      "label": "",
      "text": "",
      "notes": ""
    }
  ],
  "visible_entities": [
    {
      "name": "",
      "entity_type": "",
      "source_file": "",
      "page": "",
      "filter_type": "",
      "filter_value": "",
      "confidence": "",
      "notes": ""
    }
  ],
  "summary": "",
  "report": {
    "title": "",
    "executive_summary": [],
    "top_insights": [
      {
        "title": "",
        "priority_score": 0,
        "severity": "",
        "why_it_matters": "",
        "evidence": [],
        "recommended_action": "",
        "chart_recommendation": ""
      }
    ],
    "recommended_actions": [],
    "data_quality_notes": []
  }
}

Use text_rows to capture chart semantics when helpful, for example:
- label=chart_title
- label=chart_subtitle
- label=chart_type
- label=x_axis_title
- label=y_axis_title
- label=visual_trend

Numeric row rules:
- value may be an estimated number when the y-axis allows a conservative read.
- unit should match the chart (e.g. sessions, users, seconds, %, index).
- confidence must reflect certainty: high only for clearly readable values, medium for solid y-axis estimates, low for rough approximations.
- notes should explicitly say estimated_from_y_axis when the number is estimated rather than printed.
`.trim();

function ensureArray(value) { return Array.isArray(value) ? value : []; }
function ensureString(value) { return typeof value === "string" ? value : ""; }
function ensureNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function normalizeEntityName(value) { return ensureString(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " "); }

const ALLOWED_APP_NAME_MAP = new Map(ALLOWED_APP_NAMES.map((name) => [normalizeEntityName(name), name]));

function canonicalAllowedAppName(value) {
  const normalized = normalizeEntityName(value);
  return ALLOWED_APP_NAME_MAP.get(normalized) || "";
}

function normalizeVisibleEntities(items) {
  return ensureArray(items).map((item) => {
    const canonicalName = canonicalAllowedAppName(item.name);
    return {
      name: canonicalName || ensureString(item.name),
      normalized_name: normalizeEntityName(canonicalName || item.name),
      entity_type: ensureString(item.entity_type),
      source_file: ensureString(item.source_file),
      page: ensureString(item.page),
      filter_type: ensureString(item.filter_type),
      filter_value: ensureString(item.filter_value),
      confidence: ensureString(item.confidence),
      notes: ensureString(item.notes)
    };
  }).filter((item) => item.name && item.normalized_name && ALLOWED_APP_NAME_MAP.has(item.normalized_name));
}

function isoWeekStartDateParts(year, week) {
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const target = new Date(mondayWeek1);
  target.setUTCDate(mondayWeek1.getUTCDate() + ((week - 1) * 7));
  return {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate()
  };
}

function deriveWeekStartDateFromLabel(label) {
  const match = ensureString(label).match(/\b(20\d{2})-W(\d{1,2})\b/);
  if (!match) return "";
  const year = Number(match[1]);
  const week = Number(match[2]);
  const parts = isoWeekStartDateParts(year, week);
  if (!parts) return "";
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

function normalizeReport(report) {
  const safe = report && typeof report === "object" ? report : {};
  return {
    title: ensureString(safe.title),
    executive_summary: ensureArray(safe.executive_summary).map(String),
    top_insights: ensureArray(safe.top_insights).map((item) => ({
      title: ensureString(item.title),
      priority_score: ensureNumber(item.priority_score),
      severity: ensureString(item.severity),
      why_it_matters: ensureString(item.why_it_matters),
      evidence: ensureArray(item.evidence).map(String),
      recommended_action: ensureString(item.recommended_action),
      chart_recommendation: ensureString(item.chart_recommendation)
    })).slice(0, 4),
    recommended_actions: ensureArray(safe.recommended_actions).map(String),
    data_quality_notes: ensureArray(safe.data_quality_notes).map(String)
  };
}

function normalizeTimeHints(hints) {
  return ensureArray(hints).map((hint) => ({
    source_file: ensureString(hint.source_file),
    page: ensureString(hint.page),
    filter_type: ensureString(hint.filter_type),
    filter_value: ensureString(hint.filter_value),
    visible_weeks: ensureArray(hint.visible_weeks).map((item) => ({
      week_label: ensureString(item.week_label),
      week_start_date: ensureString(item.week_start_date) || deriveWeekStartDateFromLabel(item.week_label),
      confidence: ensureString(item.confidence),
      notes: ensureString(item.notes)
    }))
  }));
}

function normalizeRows(rows, mapper) { return ensureArray(rows).map(mapper); }

function normalizeAnalysis(raw, run) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    runId: run.runId,
    workspaceName: run.workspaceName,
    clientName: ensureString(run.clientName),
    createdAt: new Date().toISOString(),
    time_hints: normalizeTimeHints(safe.time_hints),
    visible_entities: normalizeVisibleEntities(safe.visible_entities),
    numeric_rows: normalizeRows(safe.numeric_rows, (row) => ({
      source_file: ensureString(row.source_file),
      page: ensureString(row.page),
      comparison_mode: ensureString(row.comparison_mode),
      filter_type: ensureString(row.filter_type),
      filter_value: ensureString(row.filter_value),
      time_period: ensureString(row.time_period),
      week_start_date: ensureString(row.week_start_date) || deriveWeekStartDateFromLabel(row.time_period),
      metric: ensureString(row.metric),
      value: ensureString(row.value),
      unit: ensureString(row.unit),
      confidence: ensureString(row.confidence),
      notes: ensureString(row.notes)
    })),
    text_rows: normalizeRows(safe.text_rows, (row) => ({
      source_file: ensureString(row.source_file),
      page: ensureString(row.page),
      comparison_mode: ensureString(row.comparison_mode),
      filter_type: ensureString(row.filter_type),
      filter_value: ensureString(row.filter_value),
      time_period: ensureString(row.time_period),
      week_start_date: ensureString(row.week_start_date) || deriveWeekStartDateFromLabel(row.time_period),
      label: ensureString(row.label),
      text: ensureString(row.text),
      notes: ensureString(row.notes)
    })),
    summary: ensureString(safe.summary),
    report: normalizeReport(safe.report)
  };
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); }
  catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("OpenAI response was not valid JSON");
    return JSON.parse(match[0]);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function dedupeRows(rows, keyBuilder) {
  const seen = new Set();
  const output = [];
  for (const row of ensureArray(rows)) {
    const key = keyBuilder(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function selectEvenlySpaced(items, maxCount) {
  if (items.length <= maxCount) return items;
  const selected = [];
  for (let i = 0; i < maxCount; i += 1) {
    const index = Math.round((i * (items.length - 1)) / Math.max(1, maxCount - 1));
    selected.push(items[index]);
  }
  const unique = [];
  const seen = new Set();
  for (const item of selected) {
    const key = `${item.sourceFile}_${item.sliceIndex}_${item.sliceLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function limitSlicesPerFile(sliceInputs) {
  const grouped = new Map();
  for (const slice of sliceInputs) {
    const key = slice.sourceFile || slice.slicePath;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(slice);
  }
  const limited = [];
  for (const slices of grouped.values()) {
    slices.sort((a, b) => a.sliceIndex - b.sliceIndex);
    limited.push(...selectEvenlySpaced(slices, MAX_SLICES_PER_FILE));
  }
  limited.sort((a, b) => a.sourceFile === b.sourceFile ? a.sliceIndex - b.sliceIndex : String(a.sourceFile).localeCompare(String(b.sourceFile)));
  return limited;
}

function axisSlicesPerFile(sliceInputs) {
  const grouped = new Map();
  for (const slice of sliceInputs) {
    const key = slice.sourceFile || slice.slicePath;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(slice);
  }
  const selected = [];
  for (const slices of grouped.values()) {
    slices.sort((a, b) => a.sliceIndex - b.sliceIndex);
    selected.push(...selectEvenlySpaced(slices, MAX_AXIS_SLICES_PER_FILE));
  }
  return selected;
}

async function imagePathToDataUrl(filePath, maxWidth, detailMode) {
  const ext = path.extname(filePath).toLowerCase();
  let mime = "image/jpeg";
  let pipeline = sharp(filePath).rotate();
  const meta = await pipeline.metadata();
  if (meta.width && meta.width > maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  if (ext === ".png") {
    pipeline = pipeline.png({ compressionLevel: detailMode === "low" ? 9 : 6, quality: detailMode === "low" ? 70 : 85 });
    mime = "image/png";
  } else if (ext === ".webp") {
    pipeline = pipeline.webp({ quality: detailMode === "low" ? 65 : 80 });
    mime = "image/webp";
  } else {
    pipeline = pipeline.jpeg({ quality: detailMode === "low" ? 68 : 82, mozjpeg: true });
    mime = "image/jpeg";
  }
  const buffer = await pipeline.toBuffer();
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function buildEstimatedSeconds(totalSlices, processedSlices, totalBatches, currentPhase) {
  const remainingSlices = Math.max(0, totalSlices - processedSlices);
  const base = remainingSlices * EST_SECONDS_PER_SLICE;
  if (currentPhase === "summarizing") return EST_SECONDS_FOR_SUMMARY;
  if (processedSlices >= totalSlices && totalBatches > 0) return EST_SECONDS_FOR_SUMMARY;
  return base + EST_SECONDS_FOR_SUMMARY;
}


function inferPageGroups(files) {
  const map = new Map();
  for (const file of files) {
    const key = file.groupKey || [file.page, file.filterType, file.filterValue].filter(Boolean).join("__") || file.fileName || "Unknown";
    if (!map.has(key)) {
      map.set(key, {
        group_key: key,
        page: file.page || "Unknown",
        filter_type: file.filterType || "",
        filter_value: file.filterValue || "",
        baseline: null,
        cuts: [],
        ordered_files: []
      });
    }
    const group = map.get(key);
    group.ordered_files.push({
      file_name: file.fileName,
      comparison_mode: file.comparisonMode,
      group_sequence: Number.isFinite(Number(file.groupSequence)) ? Number(file.groupSequence) : null
    });
    if (file.comparisonMode === "baseline" && !group.baseline) group.baseline = file;
    else group.cuts.push(file);
  }
  return Array.from(map.values()).map((group) => ({
    ...group,
    ordered_files: group.ordered_files.sort((a, b) => {
      const left = Number.isFinite(Number(a.group_sequence)) ? Number(a.group_sequence) : Number.MAX_SAFE_INTEGER;
      const right = Number.isFinite(Number(b.group_sequence)) ? Number(b.group_sequence) : Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return String(a.file_name || "").localeCompare(String(b.file_name || ""));
    })
  }));
}

async function buildSliceInputs(run, workspaceName) {
  const slices = [];
  const totalFiles = Array.isArray(run.files) ? run.files.length : 0;

  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
    const file = run.files[fileIndex];
    updateRunProgress({ workspaceName, runId: run.runId, progress: {
      phase: "slicing",
      message: `Slicing ${file.fileName}`,
      currentFileName: file.fileName,
      currentFileIndex: fileIndex + 1,
      totalFiles,
      currentSliceIndex: 0,
      totalSlicesForFile: 0,
      processedSlices: slices.length,
      totalSlices: slices.length,
      currentBatchIndex: 0,
      totalBatches: 0,
      estimatedSecondsRemaining: buildEstimatedSeconds(slices.length + 1, 0, 0, "slicing")
    }});

    const fileDir = path.dirname(file.imagePath);
    const sliceOutputDir = path.join(fileDir, "slices", path.parse(file.storedFileName || file.fileName || "upload").name);
    const sliced = await createSlicesForImage({ imagePath: file.imagePath, outputDir: sliceOutputDir, prefix: path.parse(file.storedFileName || file.fileName || "upload").name });

    for (const slice of sliced.slices) {
      slices.push({
        sourceFile: file.fileName,
        page: file.page,
        comparisonMode: file.comparisonMode,
        filterType: file.filterType,
        filterValue: file.filterValue,
        note: file.note || "",
        groupKey: file.groupKey || [file.page, file.filterType, file.filterValue].filter(Boolean).join("__"),
        groupSequence: file.groupSequence,
        sliceLabel: slice.sliceLabel,
        sliceIndex: slice.sliceIndex,
        slicePath: slice.slicePath,
        totalSlicesForFile: sliced.sliceCount,
        fileIndex: fileIndex + 1,
        totalFiles
      });
    }

    updateRunProgress({ workspaceName, runId: run.runId, progress: {
      phase: "slicing",
      message: `Created ${sliced.sliceCount} slice(s) for ${file.fileName}`,
      currentFileName: file.fileName,
      currentFileIndex: fileIndex + 1,
      totalFiles,
      currentSliceIndex: sliced.sliceCount,
      totalSlicesForFile: sliced.sliceCount,
      processedSlices: slices.length,
      totalSlices: slices.length,
      currentBatchIndex: 0,
      totalBatches: 0,
      estimatedSecondsRemaining: buildEstimatedSeconds(slices.length, 0, 0, "slicing")
    }});
  }

  return limitSlicesPerFile(slices);
}

async function callOpenAIJson({ apiKey, messages }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.1, response_format: { type: "json_object" }, messages })
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw?.error?.message || "OpenAI request failed");
  const content = raw?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response");
  return parseJsonSafe(content);
}

function isTooLargeError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("request too large") || message.includes("tokens per min") || message.includes("too many tokens");
}

async function extractAxisHints({ apiKey, run, slices, workspaceName }) {
  const axisSlices = axisSlicesPerFile(slices);
  if (!axisSlices.length) return [];

  updateRunProgress({ workspaceName, runId: run.runId, progress: {
    phase: "axis_read",
    message: "Reading visible week labels from chart axes",
    currentFileName: axisSlices[0]?.sourceFile || null,
    currentFileIndex: axisSlices[0]?.fileIndex || 0,
    totalFiles: run.files.length,
    currentSliceIndex: axisSlices[0]?.sliceIndex || 0,
    totalSlicesForFile: axisSlices[0]?.totalSlicesForFile || 0,
    processedSlices: 0,
    totalSlices: axisSlices.length,
    currentBatchIndex: 0,
    totalBatches: 1,
    estimatedSecondsRemaining: Math.max(6, axisSlices.length * 4)
  }});

  const content = [{ type: "text", text: [
    "Read only visible weekly labels from these chart slices.",
    "Focus on labels such as YYYY-Wnn and any visible week start dates following a dash.",
    "When a visible week label like YYYY-Wnn is present, it corresponds to the start date of that week. If the date is not printed in the chart, leave week_start_date blank and the backend will derive it deterministically.",
    "Return JSON only using this structure:",
    '{"time_hints":[{"source_file":"","page":"","filter_type":"","filter_value":"","visible_weeks":[{"week_label":"","week_start_date":"","confidence":"","notes":""}]}]}'
  ].join("\n") }];

  for (const slice of axisSlices) {
    content.push({ type: "text", text: `source_file=${slice.sourceFile} page=${slice.page} comparison_mode=${slice.comparisonMode} filter_type=${slice.filterType} filter_value=${slice.filterValue} group_key=${slice.groupKey || ""} slice_label=${slice.sliceLabel}` });
    content.push({ type: "image_url", image_url: { url: await imagePathToDataUrl(slice.slicePath, 1200, "low"), detail: "low" } });
  }

  const parsed = await callOpenAIJson({ apiKey, messages: [
    { role: "system", content: `You read time-axis labels from dashboard chart screenshots. Extract only visible weekly labels and week start dates. Visible year-week labels correspond to week-start dates. If a date is not printed in the chart, leave week_start_date blank instead of guessing. Return JSON only.` },
    { role: "user", content }
  ]});

  return normalizeTimeHints(parsed.time_hints || []);
}

async function extractBatchOnce({ apiKey, batch, promptText, detailMode, maxWidth, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices, timeHints, pageGroups }) {
  const first = batch[0];
  updateRunProgress({ workspaceName, runId: run.runId, progress: {
    phase: "extracting",
    message: `Extracting batch ${batchIndex} of ${batchCount} from ${first.sourceFile}`,
    currentFileName: first.sourceFile,
    currentFileIndex: first.fileIndex,
    totalFiles: first.totalFiles,
    currentSliceIndex: first.sliceIndex,
    totalSlicesForFile: first.totalSlicesForFile,
    processedSlices: processedSlicesBeforeBatch,
    totalSlices,
    currentBatchIndex: batchIndex,
    totalBatches: batchCount,
    estimatedSecondsRemaining: buildEstimatedSeconds(totalSlices, processedSlicesBeforeBatch, batchCount, "extracting")
  }});

  const metadataLines = batch.map((slice, index) => [
    `${index + 1}.`,
    `source_file=${slice.sourceFile}`,
    `page=${slice.page}`,
    `comparison_mode=${slice.comparisonMode}`,
    `filter_type=${slice.filterType}`,
    `filter_value=${slice.filterValue}`,
    `slice_label=${slice.sliceLabel}`,
    `group_key=${slice.groupKey || ""}`,
    `group_sequence=${slice.groupSequence ?? ""}`,
    `slice_index=${slice.sliceIndex}`,
    `slices_for_file=${slice.totalSlicesForFile}`,
    `note=${slice.note || ""}`
  ].join(" ")).join("\n");

  const userContent = [{ type: "text", text: [
    promptText,
    "",
    `Client/platform name: ${run.clientName || "Not provided"}`,
    `This is extraction batch ${batchIndex} of ${batchCount}.`,
    "Return JSON only.",
    "Focus on rows visible in these images only.",
    "Use baseline screenshots as the anchor for interpreting filtered cuts under the same page or group key.",
    "First read the chart title, subtitle, chart type, legend, x-axis labels, y-axis title, units, and tick marks.",
    "Understand what the chart is trying to say before extracting rows.",
    "When a line, bar, stacked bar, or area segment can be read against the y-axis, extract conservative estimated numeric_rows for visible apps.",
    "Prioritize latest visible period, obvious peaks/troughs, major trend breaks, and dominant shares rather than forcing every point.",
    "If a number is estimated from the y-axis, set confidence accordingly and include estimated_from_y_axis in notes.",
    "For 100% stacked or share charts, percentages or share estimates are acceptable only when visually supportable.",
    "Add text_rows for chart_title, chart_subtitle, chart_type, x_axis_title, y_axis_title, and major visual trend statements when visible.",
    `Extract visible entity names only when they are directly readable in legends, labels, tables, titles, or KPI text.`,
    `Only allow these app names: ${ALLOWED_APP_NAMES.join(", ")}.`,
    "Never infer sibling apps, brands, or products that are not visibly present.",
    "If a detected name is not in the allowed app list, drop it instead of normalizing it to something else.",
    "Do not mention dimensions that are not visibly present.",
    "Page grouping context:",
    JSON.stringify(pageGroups, null, 2),
    "Axis week hints already detected:",
    JSON.stringify(timeHints, null, 2),
    "Slice metadata:",
    metadataLines
  ].join("\n") }];

  for (const slice of batch) {
    userContent.push({ type: "image_url", image_url: { url: await imagePathToDataUrl(slice.slicePath, maxWidth, detailMode), detail: detailMode } });
  }

  return callOpenAIJson({ apiKey, messages: [
    { role: "system", content: `You are a meticulous BI analyst. Extract only visually supported values from the provided chart slices. Preserve baseline-vs-cut context, week labels, and visible dimensions only. Build a visible_entities allowlist from names directly visible in the images. Only allow these app names: ${ALLOWED_APP_NAMES.join(", ")}. Never infer unseen apps, brands, or products. If a name is outside the allowed list, exclude it. Read chart title, subtitle, chart type, x-axis, y-axis title, units, tick marks, and legend before extracting. When the y-axis supports it, produce conservative numeric estimates with explicit confidence and notes such as estimated_from_y_axis. Return JSON only.` },
    { role: "user", content: userContent }
  ]});
}

async function extractBatchAdaptive({ apiKey, batch, promptText, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices, timeHints, pageGroups }) {
  try {
    return await extractBatchOnce({ apiKey, batch, promptText, detailMode: DEFAULT_VISION_DETAIL, maxWidth: DEFAULT_VISION_MAX_WIDTH, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices, timeHints, pageGroups });
  } catch (error) {
    if (!isTooLargeError(error)) throw error;
    updateRunProgress({ workspaceName, runId: run.runId, progress: {
      phase: "extracting",
      message: `Request too large, reducing batch size for ${batch[0]?.sourceFile || "current file"}`,
      estimatedSecondsRemaining: buildEstimatedSeconds(totalSlices, processedSlicesBeforeBatch, batchCount, "extracting")
    }});

    if (batch.length > 1) {
      const midpoint = Math.ceil(batch.length / 2);
      const left = await extractBatchAdaptive({ apiKey, batch: batch.slice(0, midpoint), promptText, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices, timeHints, pageGroups });
      const right = await extractBatchAdaptive({ apiKey, batch: batch.slice(midpoint), promptText, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch: processedSlicesBeforeBatch + batch.slice(0, midpoint).length, totalSlices, timeHints, pageGroups });
      return {
        numeric_rows: [...ensureArray(left.numeric_rows), ...ensureArray(right.numeric_rows)],
        text_rows: [...ensureArray(left.text_rows), ...ensureArray(right.text_rows)],
        visible_entities: [...ensureArray(left.visible_entities), ...ensureArray(right.visible_entities)],
        summary: "",
        report: { title: "", executive_summary: [], top_insights: [], recommended_actions: [], data_quality_notes: [] }
      };
    }

    return extractBatchOnce({ apiKey, batch, promptText, detailMode: "low", maxWidth: 850, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices, timeHints, pageGroups });
  }
}

async function summarizeCombinedRows({ apiKey, run, numericRows, textRows, visibleEntities, promptText, workspaceName, timeHints, pageGroups }) {
  updateRunProgress({ workspaceName, runId: run.runId, progress: {
    phase: "ranking_insights",
    message: `Ranking top business priorities for ${run.clientName || run.workspaceName}`,
    currentFileName: null,
    currentFileIndex: Array.isArray(run.files) ? run.files.length : 0,
    totalFiles: Array.isArray(run.files) ? run.files.length : 0,
    currentSliceIndex: 0,
    totalSlicesForFile: 0,
    processedSlices: numericRows.length + textRows.length,
    totalSlices: numericRows.length + textRows.length,
    currentBatchIndex: 0,
    totalBatches: 0,
    estimatedSecondsRemaining: EST_SECONDS_FOR_SUMMARY
  }});

  const compactPayload = {
    runId: run.runId,
    workspaceName: run.workspaceName,
    clientName: run.clientName || "",
    screenshotCount: Array.isArray(run.files) ? run.files.length : 0,
    page_groups: pageGroups,
    time_hints: timeHints,
    visible_entities: visibleEntities,
    numeric_rows: numericRows,
    text_rows: textRows
  };

  const summaryPrompt = [
    "Create the final report from the extracted rows below.",
    "The audience is CMI and category leads for the named client/platform.",
    "Do not use a rigid fixed template. Instead, identify and rank the top 4 highest-priority business insights.",
    "Use baseline screenshots as the reference point and evaluate how filtered cuts differ from baseline.",
    "Rank insights by business harm, urgency, breadth, recent deterioration, competitive threat, and confidence.",
    "Top insights must be truly insight-led, not chart narration.",
    "Do not invent dimensions not present in the evidence.",
    "If numeric_rows include conservative estimated values from the y-axis, use them with the stated confidence instead of ignoring them.",
    "Read chart_title, chart_subtitle, chart_type, x_axis_title, y_axis_title, and visual_trend text_rows to understand what each chart means.",
    "Do not reduce the report to coverage-only if charts visibly show trends, rank order, peaks, declines, duration, retention, switching, or distribution patterns.",
    "Only say that evidence is limited to coverage when the extracted rows genuinely lack metric or directional content.",
    `Only discuss apps, brands, or products that appear in visible_entities for this run. The only valid app names are: ${ALLOWED_APP_NAMES.join(", ")}.`,
    "If an entity is absent from visible_entities, treat it as out of scope and do not mention it.",
    "Do not introduce any app name outside the approved list even if the model associates it with the category.",
    "Use week_start_date as the calendar start date for each visible week when discussing date ranges. If a week label is visible, rely on its derived or extracted week_start_date instead of inventing a different calendar period.",
    "If later weeks are visible in time_hints, use them correctly in recent-trend commentary.",
    "Start effectively at executive summary. Avoid a long generic introductory paragraph.",
    "Return JSON only using the same top-level structure.",
    "Keep numeric_rows and text_rows aligned to supplied rows.",
    "",
    "Original extraction instruction:",
    promptText
  ].join("\n");

  return callOpenAIJson({ apiKey, messages: [
    { role: "system", content: `You are a BI reporting assistant. Build a concise executive report only from the extracted rows, time hints, visible_entities allowlist, and baseline-vs-cut grouping context. Only mention entities present in visible_entities for this run, and only from this approved app list: ${ALLOWED_APP_NAMES.join(", ")}. Use week_start_date as the calendar start date for visible weeks and never substitute a stale year. Use conservative numeric estimates from the y-axis when they were extracted with confidence, and write actionable insights from the chart meaning rather than generic coverage statements. Return JSON only.` },
    { role: "user", content: `${summaryPrompt}\n\nExtracted rows JSON:\n${JSON.stringify(compactPayload)}` }
  ]});
}

async function analyzeRunWithOpenAI({ workspaceName, runId, promptOverride }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing on the backend");

  const run = getRun(workspaceName, runId);
  if (!run) throw new Error("Run not found");
  if (!Array.isArray(run.files) || !run.files.length) throw new Error("No uploaded screenshots found for this run");

  updateRunStatus({ workspaceName, runId, status: "extracting", error: null });
  updateRunProgress({ workspaceName, runId, progress: {
    phase: "grouping",
    message: `Grouping ${run.files.length} screenshot(s) into baseline and cuts`,
    currentFileName: null,
    currentFileIndex: 0,
    totalFiles: run.files.length,
    currentSliceIndex: 0,
    totalSlicesForFile: 0,
    processedSlices: 0,
    totalSlices: 0,
    currentBatchIndex: 0,
    totalBatches: 0,
    estimatedSecondsRemaining: run.files.length * EST_SECONDS_PER_SLICE + EST_SECONDS_FOR_SUMMARY
  }});

  const pageGroups = inferPageGroups(run.files);
  const sliceInputs = await buildSliceInputs(run, workspaceName);
  if (!sliceInputs.length) throw new Error("No chart slices could be created from the uploaded screenshots");

  const timeHints = await extractAxisHints({ apiKey, run, slices: sliceInputs, workspaceName });
  const promptText = promptOverride || DEFAULT_ANALYSIS_PROMPT;
  const batches = chunkArray(sliceInputs, MAX_IMAGES_PER_BATCH);
  const totalSlices = sliceInputs.length;
  let processedSlices = 0;

  const collectedNumericRows = [];
  const collectedTextRows = [];
  const collectedVisibleEntities = [];

  for (let i = 0; i < batches.length; i += 1) {
    const partial = await extractBatchAdaptive({ apiKey, batch: batches[i], promptText, batchIndex: i + 1, batchCount: batches.length, run, workspaceName, processedSlicesBeforeBatch: processedSlices, totalSlices, timeHints, pageGroups });
    processedSlices += batches[i].length;
    updateRunProgress({ workspaceName, runId, progress: {
      phase: "extracting",
      message: `Finished batch ${i + 1} of ${batches.length}`,
      currentFileName: batches[i][batches[i].length - 1]?.sourceFile || null,
      currentFileIndex: batches[i][batches[i].length - 1]?.fileIndex || 0,
      totalFiles: run.files.length,
      currentSliceIndex: batches[i][batches[i].length - 1]?.sliceIndex || 0,
      totalSlicesForFile: batches[i][batches[i].length - 1]?.totalSlicesForFile || 0,
      processedSlices,
      totalSlices,
      currentBatchIndex: i + 1,
      totalBatches: batches.length,
      estimatedSecondsRemaining: buildEstimatedSeconds(totalSlices, processedSlices, batches.length, "extracting")
    }});
    collectedNumericRows.push(...ensureArray(partial.numeric_rows));
    collectedTextRows.push(...ensureArray(partial.text_rows));
    collectedVisibleEntities.push(...ensureArray(partial.visible_entities));
  }

  const dedupedTimeHints = dedupeRows(timeHints, (row) => [ensureString(row.source_file), ensureString(row.page), ensureString(row.filter_type), ensureString(row.filter_value), JSON.stringify(ensureArray(row.visible_weeks))].join("|"));
  const dedupedNumericRows = dedupeRows(collectedNumericRows, (row) => [ensureString(row.source_file), ensureString(row.page), ensureString(row.comparison_mode), ensureString(row.filter_type), ensureString(row.filter_value), ensureString(row.time_period), ensureString(row.week_start_date), ensureString(row.metric), ensureString(row.value), ensureString(row.unit), ensureString(row.notes)].join("|"));
  const dedupedTextRows = dedupeRows(collectedTextRows, (row) => [ensureString(row.source_file), ensureString(row.page), ensureString(row.comparison_mode), ensureString(row.filter_type), ensureString(row.filter_value), ensureString(row.time_period), ensureString(row.week_start_date), ensureString(row.label), ensureString(row.text), ensureString(row.notes)].join("|"));
  const dedupedVisibleEntities = dedupeRows(normalizeVisibleEntities(collectedVisibleEntities), (row) => [ensureString(row.normalized_name), ensureString(row.page), ensureString(row.filter_type), ensureString(row.filter_value), ensureString(row.source_file)].join("|"));

  const summarized = await summarizeCombinedRows({ apiKey, run, numericRows: dedupedNumericRows, textRows: dedupedTextRows, visibleEntities: dedupedVisibleEntities, promptText, workspaceName, timeHints: dedupedTimeHints, pageGroups });

  const finalPayload = {
    time_hints: dedupedTimeHints,
    visible_entities: dedupedVisibleEntities,
    numeric_rows: dedupedNumericRows,
    text_rows: dedupedTextRows,
    summary: ensureString(summarized.summary),
    report: normalizeReport(summarized.report)
  };

  const normalized = normalizeAnalysis(finalPayload, run);
  saveAnalysis({ workspaceName, runId, analysis: normalized });
  return normalized;
}

module.exports = { analyzeRunWithOpenAI, DEFAULT_ANALYSIS_PROMPT };
