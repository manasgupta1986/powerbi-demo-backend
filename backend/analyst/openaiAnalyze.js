const path = require("path");
const sharp = require("sharp");

const { getRun, updateRunStatus, updateRunProgress, saveAnalysis } = require("./store");
const { createSlicesForImage } = require("./imageSlicer");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const MAX_IMAGES_PER_BATCH = Math.max(1, Number(process.env.ANALYST_MAX_IMAGES_PER_BATCH || 3));
const MAX_SLICES_PER_FILE = Math.max(1, Number(process.env.ANALYST_MAX_SLICES_PER_FILE || 6));
const DEFAULT_VISION_MAX_WIDTH = Math.max(700, Number(process.env.ANALYST_VISION_MAX_WIDTH || 1100));
const DEFAULT_VISION_DETAIL = process.env.ANALYST_VISION_DETAIL || "low";
const EST_SECONDS_PER_SLICE = Math.max(3, Number(process.env.ANALYST_EST_SECONDS_PER_SLICE || 8));
const EST_SECONDS_FOR_SUMMARY = Math.max(4, Number(process.env.ANALYST_EST_SECONDS_FOR_SUMMARY || 10));

const DEFAULT_ANALYSIS_PROMPT = `
You are analyzing tagged dashboard screenshots from a business intelligence workflow.

Important:
- the backend may split each tall dashboard screenshot into multiple focused chart slices
- each slice belongs to one original screenshot and carries metadata
- estimate values visually when labels are missing, but do not invent unsupported precision
- avoid duplicate rows when overlapping slices show the same chart area
- use the client/platform name when forming insights for CMI and category leads

Return only valid JSON using this structure:
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
    clientName: ensureString(run.clientName),
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

  limited.sort((a, b) => {
    if (a.sourceFile === b.sourceFile) return a.sliceIndex - b.sliceIndex;
    return String(a.sourceFile).localeCompare(String(b.sourceFile));
  });
  return limited;
}

async function imagePathToDataUrl(filePath, maxWidth, detailMode) {
  const ext = path.extname(filePath).toLowerCase();
  let mime = "image/jpeg";
  let pipeline = sharp(filePath).rotate();
  const meta = await pipeline.metadata();
  if (meta.width && meta.width > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  }
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

async function buildSliceInputs(run, workspaceName) {
  const slices = [];
  const totalFiles = Array.isArray(run.files) ? run.files.length : 0;

  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex += 1) {
    const file = run.files[fileIndex];
    updateRunProgress({
      workspaceName,
      runId: run.runId,
      progress: {
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
      }
    });

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
        totalSlicesForFile: sliced.sliceCount,
        fileIndex: fileIndex + 1,
        totalFiles
      });
    }

    updateRunProgress({
      workspaceName,
      runId: run.runId,
      progress: {
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
      }
    });
  }

  return limitSlicesPerFile(slices);
}

async function callOpenAIJson({ apiKey, messages }) {
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
      messages
    })
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

async function extractBatchOnce({ apiKey, batch, promptText, detailMode, maxWidth, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices }) {
  const first = batch[0];
  updateRunProgress({
    workspaceName,
    runId: run.runId,
    progress: {
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
    }
  });

  const metadataLines = batch.map((slice, index) => [
    `${index + 1}.`,
    `source_file=${slice.sourceFile}`,
    `page=${slice.page}`,
    `filter_type=${slice.filterType}`,
    `filter_value=${slice.filterValue}`,
    `slice_label=${slice.sliceLabel}`,
    `slice_index=${slice.sliceIndex}`,
    `slices_for_file=${slice.totalSlicesForFile}`,
    `note=${slice.note || ""}`
  ].join(" ")).join("\n");

  const userContent = [{
    type: "text",
    text: [
      promptText,
      "",
      `Client/platform name: ${run.clientName || "Not provided"}`,
      `This is extraction batch ${batchIndex} of ${batchCount}.`,
      "Return JSON only.",
      "Focus on rows visible in these images only.",
      "Slice metadata:",
      metadataLines
    ].join("\n")
  }];

  for (const slice of batch) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: await imagePathToDataUrl(slice.slicePath, maxWidth, detailMode),
        detail: detailMode
      }
    });
  }

  return callOpenAIJson({
    apiKey,
    messages: [
      {
        role: "system",
        content: "You are a meticulous BI analyst. Extract only visually supported values from the provided chart slices. Estimate cautiously when exact labels are not visible. Return JSON only."
      },
      { role: "user", content: userContent }
    ]
  });
}

async function extractBatchAdaptive({ apiKey, batch, promptText, batchIndex, batchCount, run, workspaceName, processedSlicesBeforeBatch, totalSlices }) {
  try {
    return await extractBatchOnce({
      apiKey,
      batch,
      promptText,
      detailMode: DEFAULT_VISION_DETAIL,
      maxWidth: DEFAULT_VISION_MAX_WIDTH,
      batchIndex,
      batchCount,
      run,
      workspaceName,
      processedSlicesBeforeBatch,
      totalSlices
    });
  } catch (error) {
    if (!isTooLargeError(error)) throw error;

    updateRunProgress({
      workspaceName,
      runId: run.runId,
      progress: {
        phase: "extracting",
        message: `Request too large, reducing batch size for ${batch[0]?.sourceFile || "current file"}`,
        estimatedSecondsRemaining: buildEstimatedSeconds(totalSlices, processedSlicesBeforeBatch, batchCount, "extracting")
      }
    });

    if (batch.length > 1) {
      const midpoint = Math.ceil(batch.length / 2);
      const left = await extractBatchAdaptive({
        apiKey,
        batch: batch.slice(0, midpoint),
        promptText,
        batchIndex,
        batchCount,
        run,
        workspaceName,
        processedSlicesBeforeBatch,
        totalSlices
      });
      const right = await extractBatchAdaptive({
        apiKey,
        batch: batch.slice(midpoint),
        promptText,
        batchIndex,
        batchCount,
        run,
        workspaceName,
        processedSlicesBeforeBatch: processedSlicesBeforeBatch + batch.slice(0, midpoint).length,
        totalSlices
      });
      return {
        numeric_rows: [...ensureArray(left.numeric_rows), ...ensureArray(right.numeric_rows)],
        text_rows: [...ensureArray(left.text_rows), ...ensureArray(right.text_rows)],
        summary: "",
        report: { title: "", executive_summary: [], key_findings: [], recommendations: [], data_quality_notes: [] }
      };
    }

    return extractBatchOnce({
      apiKey,
      batch,
      promptText,
      detailMode: "low",
      maxWidth: 850,
      batchIndex,
      batchCount,
      run,
      workspaceName,
      processedSlicesBeforeBatch,
      totalSlices
    });
  }
}

async function summarizeCombinedRows({ apiKey, run, numericRows, textRows, promptText, workspaceName }) {
  updateRunProgress({
    workspaceName,
    runId: run.runId,
    progress: {
      phase: "summarizing",
      message: `Building final report for ${run.clientName || run.workspaceName}`,
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
    }
  });

  const compactPayload = {
    runId: run.runId,
    workspaceName: run.workspaceName,
    clientName: run.clientName || "",
    screenshotCount: Array.isArray(run.files) ? run.files.length : 0,
    numeric_rows: numericRows,
    text_rows: textRows
  };

  const summaryPrompt = [
    "Create the final combined report from the extracted rows below.",
    "The audience is CMI and category leads for the named client/platform.",
    "Do not invent new metrics. Use only the supplied rows.",
    "If the extraction is thin or approximate, say so in summary and data_quality_notes.",
    "Return JSON only using the same top-level structure.",
    "Keep numeric_rows and text_rows exactly aligned to the supplied rows.",
    "",
    "Original extraction instruction:",
    promptText
  ].join("\n");

  return callOpenAIJson({
    apiKey,
    messages: [
      {
        role: "system",
        content: "You are a BI reporting assistant. Build a concise executive report from already extracted rows. Do not add unsupported facts. Tailor the insights for CMI and category leads. Return JSON only."
      },
      {
        role: "user",
        content: `${summaryPrompt}\n\nExtracted rows JSON:\n${JSON.stringify(compactPayload)}`
      }
    ]
  });
}

async function analyzeRunWithOpenAI({ workspaceName, runId, promptOverride }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing on the backend");

  const run = getRun(workspaceName, runId);
  if (!run) throw new Error("Run not found");
  if (!Array.isArray(run.files) || !run.files.length) throw new Error("No uploaded screenshots found for this run");

  updateRunStatus({ workspaceName, runId, status: "extracting", error: null });
  updateRunProgress({
    workspaceName,
    runId,
    progress: {
      phase: "queued",
      message: `Preparing ${run.files.length} screenshot(s) for slicing`,
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
    }
  });

  const sliceInputs = await buildSliceInputs(run, workspaceName);
  if (!sliceInputs.length) throw new Error("No chart slices could be created from the uploaded screenshots");

  const promptText = promptOverride || DEFAULT_ANALYSIS_PROMPT;
  const batches = chunkArray(sliceInputs, MAX_IMAGES_PER_BATCH);
  const totalSlices = sliceInputs.length;
  let processedSlices = 0;

  const collectedNumericRows = [];
  const collectedTextRows = [];

  for (let i = 0; i < batches.length; i += 1) {
    const partial = await extractBatchAdaptive({
      apiKey,
      batch: batches[i],
      promptText,
      batchIndex: i + 1,
      batchCount: batches.length,
      run,
      workspaceName,
      processedSlicesBeforeBatch: processedSlices,
      totalSlices
    });

    processedSlices += batches[i].length;
    updateRunProgress({
      workspaceName,
      runId,
      progress: {
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
      }
    });

    collectedNumericRows.push(...ensureArray(partial.numeric_rows));
    collectedTextRows.push(...ensureArray(partial.text_rows));
  }

  const dedupedNumericRows = dedupeRows(collectedNumericRows, (row) => [
    ensureString(row.source_file),
    ensureString(row.page),
    ensureString(row.filter_type),
    ensureString(row.filter_value),
    ensureString(row.metric),
    ensureString(row.value),
    ensureString(row.unit),
    ensureString(row.notes)
  ].join("|"));

  const dedupedTextRows = dedupeRows(collectedTextRows, (row) => [
    ensureString(row.source_file),
    ensureString(row.page),
    ensureString(row.filter_type),
    ensureString(row.filter_value),
    ensureString(row.label),
    ensureString(row.text),
    ensureString(row.notes)
  ].join("|"));

  const summarized = await summarizeCombinedRows({
    apiKey,
    run,
    numericRows: dedupedNumericRows,
    textRows: dedupedTextRows,
    promptText,
    workspaceName
  });

  const finalPayload = {
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
