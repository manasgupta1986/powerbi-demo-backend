const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_AI_SLICES = Number(process.env.MAX_AI_SLICES || 3);

app.use(cors());
app.use(express.json({ limit: "8mb" }));

ensureDirSync(DATA_DIR);
ensureDirSync(path.join(DATA_DIR, "runs"));

const runCache = new Map();
let extractionQueue = Promise.resolve();

app.get("/", (_req, res) => {
  res.send(`
    <html><head><title>PowerBI Demo Backend</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
      a { color: #2563eb; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 12px 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; }
      th { background: #f9fafb; }
    </style></head>
    <body>
      <h1>PowerBI Demo Backend</h1>
      <p>Backend is running.</p>
      <p><a href="/health">/health</a></p>
    </body></html>
  `);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "powerbi-demo-backend",
    ai_enabled: Boolean(OPENAI_API_KEY),
    model: OPENAI_MODEL,
    data_dir: DATA_DIR
  });
});

app.post("/capture-state/start", async (req, res) => {
  try {
    const { runId: incomingRunId, clientName, dashboardUrl, pageName, filterName, filterValue } = req.body || {};
    if (!clientName) return res.status(400).json({ ok: false, error: "clientName is required" });
    if (!pageName) return res.status(400).json({ ok: false, error: "pageName is required" });

    const runId = incomingRunId || makeId("run");
    const stateId = makeId("state");
    const run = await getOrCreateRun(runId, {
      clientName,
      dashboardUrl: dashboardUrl || "",
      createdAt: new Date().toISOString()
    });

    run.clientName = clientName || run.clientName;
    run.dashboardUrl = dashboardUrl || run.dashboardUrl || "";
    run.updatedAt = new Date().toISOString();
    run.states[stateId] = {
      stateId,
      runId,
      clientName: run.clientName,
      dashboardUrl: run.dashboardUrl,
      pageName,
      filterName: filterName || "",
      filterValue: filterValue || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slices: [],
      analysis: {
        status: "uploading",
        numeric_rows: [],
        text_rows: [],
        summary: "",
        error: null,
        startedAt: null,
        completedAt: null,
        slice_summaries: []
      }
    };

    await saveRun(run);
    res.json({ ok: true, runId, stateId });
  } catch (error) {
    console.error("capture-state/start error:", error);
    res.status(500).json({ ok: false, error: error.message || "start failed" });
  }
});

app.post("/capture-state/slice", async (req, res) => {
  try {
    const { runId, stateId, sliceIndex, imageBase64, scrollY = 0 } = req.body || {};
    if (!runId || !stateId || sliceIndex === undefined || !imageBase64) {
      return res.status(400).json({ ok: false, error: "runId, stateId, sliceIndex and imageBase64 are required" });
    }

    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run not found" });
    const state = run.states?.[stateId];
    if (!state) return res.status(404).json({ ok: false, error: "state not found" });

    const stateDir = path.join(DATA_DIR, "runs", runId, stateId);
    await ensureDir(stateDir);

    const payload = stripDataUrlPrefix(imageBase64);
    const fileName = `slice-${String(sliceIndex).padStart(3, "0")}.png`;
    const filePath = path.join(stateDir, fileName);
    const imageBuffer = Buffer.from(payload, "base64");
    await fsp.writeFile(filePath, imageBuffer);

    state.slices.push({
      sliceIndex,
      scrollY,
      fileName,
      filePath,
      createdAt: new Date().toISOString()
    });
    state.updatedAt = new Date().toISOString();
    state.analysis.status = "uploading";

    await saveRun(run);
    res.json({ ok: true, runId, stateId, sliceCount: state.slices.length });
  } catch (error) {
    console.error("capture-state/slice error:", error);
    res.status(500).json({ ok: false, error: error.message || "slice failed" });
  }
});

app.post("/capture-state/finish", async (req, res) => {
  try {
    const { runId, stateId } = req.body || {};
    if (!runId || !stateId) return res.status(400).json({ ok: false, error: "runId and stateId are required" });

    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run not found" });
    const state = run.states?.[stateId];
    if (!state) return res.status(404).json({ ok: false, error: "state not found" });

    state.updatedAt = new Date().toISOString();
    state.analysis.status = "queued";
    state.analysis.error = null;
    await saveRun(run);
    queueExtraction(runId, stateId);

    res.json({
      ok: true,
      runId,
      stateId,
      status: "queued",
      statusUrl: `/state-status?runId=${encodeURIComponent(runId)}&stateId=${encodeURIComponent(stateId)}`,
      reportUrl: `/report?runId=${encodeURIComponent(runId)}&stateId=${encodeURIComponent(stateId)}`,
      latestDataUrl: `/latest-data?runId=${encodeURIComponent(runId)}`
    });
  } catch (error) {
    console.error("capture-state/finish error:", error);
    res.status(500).json({ ok: false, error: error.message || "finish failed" });
  }
});

app.get("/state-status", async (req, res) => {
  try {
    const { runId, stateId } = req.query || {};
    if (!runId || !stateId) return res.status(400).json({ ok: false, error: "runId and stateId are required" });

    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run not found" });
    const state = run.states?.[stateId];
    if (!state) return res.status(404).json({ ok: false, error: "state not found" });

    const analysis = state.analysis || {};
    res.json({
      ok: true,
      runId,
      stateId,
      pageName: state.pageName,
      filterName: state.filterName,
      filterValue: state.filterValue,
      status: analysis.status || "not_started",
      numericRowCount: Array.isArray(analysis.numeric_rows) ? analysis.numeric_rows.length : 0,
      textRowCount: Array.isArray(analysis.text_rows) ? analysis.text_rows.length : 0,
      summaryAvailable: Boolean(analysis.summary),
      summary: analysis.summary || "",
      error: analysis.error || null
    });
  } catch (error) {
    console.error("state-status error:", error);
    res.status(500).json({ ok: false, error: error.message || "status failed" });
  }
});

app.get("/latest-data", async (req, res) => {
  try {
    const requestedRunId = req.query?.runId;
    const runId = requestedRunId || (await findLatestRunId());
    if (!runId) return res.json({ ok: true, runs: [], message: "No runs found yet." });

    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run not found" });

    const states = Object.values(run.states || {}).map((state) => ({
      stateId: state.stateId,
      pageName: state.pageName,
      filterName: state.filterName,
      filterValue: state.filterValue,
      sliceCount: state.slices?.length || 0,
      analysisStatus: state.analysis?.status || "not_started",
      numericRowCount: state.analysis?.numeric_rows?.length || 0,
      summary: state.analysis?.summary || "",
      reportUrl: `/report?runId=${encodeURIComponent(run.runId)}&stateId=${encodeURIComponent(state.stateId)}`
    }));

    res.json({
      ok: true,
      runId: run.runId,
      clientName: run.clientName,
      dashboardUrl: run.dashboardUrl,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      stateCount: states.length,
      states
    });
  } catch (error) {
    console.error("latest-data error:", error);
    res.status(500).json({ ok: false, error: error.message || "latest-data failed" });
  }
});

app.get("/report", async (req, res) => {
  try {
    const { runId, stateId } = req.query || {};
    if (!runId) return res.status(400).send("runId is required");

    const run = await getRun(runId);
    if (!run) return res.status(404).send("Run not found");

    if (stateId) {
      const state = run.states?.[stateId];
      if (!state) return res.status(404).send("State not found");
      return res.send(renderStateReport(run, state));
    }

    res.send(renderRunReport(run));
  } catch (error) {
    console.error("report error:", error);
    res.status(500).send(error.message || "report failed");
  }
});

app.post("/ask", async (req, res) => {
  try {
    const { runId, question } = req.body || {};
    if (!runId || !question) return res.status(400).json({ ok: false, error: "runId and question are required" });

    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run not found" });

    const states = Object.values(run.states || {});
    const allNumericRows = states.flatMap((s) => s.analysis?.numeric_rows || []);
    const allSummaries = states.map((s) => s.analysis?.summary).filter(Boolean);
    const anyPending = states.some((s) => ["queued", "running", "uploading"].includes(s.analysis?.status));
    const anyFailed = states.some((s) => s.analysis?.status === "failed");

    if (allNumericRows.length > 0) {
      const answer = await answerQuestionFromDataset({ question, run, numericRows: allNumericRows, summaries: allSummaries });
      return res.json({ ok: true, mode: "numeric_rows", answer });
    }

    if (anyPending) {
      return res.json({ ok: false, reason: "extraction_pending", answer: "Extraction is still in progress for the latest capture. Please wait a bit and try again." });
    }

    if (allSummaries.length > 0) {
      const answer = await answerQuestionFromSummary({ question, run, summaries: allSummaries });
      return res.json({ ok: true, mode: "summary_fallback", warning: "No numeric rows were extracted, so this answer is based on qualitative summary text.", answer });
    }

    if (anyFailed) {
      return res.json({ ok: false, reason: "extraction_failed", answer: "Extraction failed for one or more captures. Please review the report/status page or recapture the state." });
    }

    res.json({ ok: false, reason: "no_data", answer: "No extracted data is available yet for this run." });
  } catch (error) {
    console.error("ask error:", error);
    res.status(500).json({ ok: false, error: error.message || "ask failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PowerBI backend listening on port ${PORT}`);
});

function queueExtraction(runId, stateId) {
  extractionQueue = extractionQueue.then(() => runExtraction(runId, stateId)).catch((error) => {
    console.error("queueExtraction error:", error);
  });
}

async function runExtraction(runId, stateId) {
  const run = await getRun(runId);
  if (!run) return;
  const state = run.states?.[stateId];
  if (!state) return;

  state.analysis.status = "running";
  state.analysis.error = null;
  state.analysis.startedAt = new Date().toISOString();
  await saveRun(run);

  try {
    const slices = (state.slices || []).slice(0, MAX_AI_SLICES);
    const numericRows = [];
    const textRows = [];
    const sliceSummaries = [];

    for (const slice of slices) {
      const imageBuffer = await fsp.readFile(slice.filePath);
      const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;
      const extracted = await analyzeSliceWithAI({
        dataUrl,
        pageName: state.pageName,
        filterName: state.filterName,
        filterValue: state.filterValue,
        sliceIndex: slice.sliceIndex
      });

      numericRows.push(...sanitizeNumericRows(extracted.numeric_rows || [], slice.sliceIndex));
      textRows.push(...sanitizeTextRows(extracted.text_rows || [], slice.sliceIndex));
      if (extracted.summary) sliceSummaries.push({ sliceIndex: slice.sliceIndex, summary: extracted.summary });
    }

    const dedupedNumeric = dedupeNumericRows(numericRows);
    state.analysis.numeric_rows = dedupedNumeric;
    state.analysis.text_rows = textRows;
    state.analysis.slice_summaries = sliceSummaries;
    state.analysis.summary = buildSummaryFromExtraction({ state, numericRows: dedupedNumeric, textRows, sliceSummaries });
    state.analysis.status = "completed";
    state.analysis.error = null;
    state.analysis.completedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    await saveRun(run);
  } catch (error) {
    console.error("runExtraction error:", error);
    state.analysis.status = "failed";
    state.analysis.error = error.message || "Extraction failed";
    state.analysis.completedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    await saveRun(run);
  }
}

async function analyzeSliceWithAI({ dataUrl, pageName, filterName, filterValue, sliceIndex }) {
  if (!OPENAI_API_KEY) {
    return { summary: "AI extraction is disabled because OPENAI_API_KEY is not configured.", numeric_rows: [], text_rows: [] };
  }

  const prompt = [
    "You are extracting structured information from a Power BI dashboard screenshot.",
    `Page: ${pageName}`,
    `Filter: ${filterName || "None"} = ${filterValue || "None"}`,
    `Slice index: ${sliceIndex}`,
    "",
    "Return ONLY valid JSON with this exact shape:",
    '{"summary":"...","numeric_rows":[{"metric_name":"","value":"","unit":"","context":"","slice_index":0}],"text_rows":[{"label":"","text":"","context":"","slice_index":0}]}',
    "",
    "Rules:",
    "- Do not invent values.",
    "- Extract visible KPI cards, percentages, counts, trend values, table values, chart labels with numeric values, and clearly readable numbers.",
    "- Use strings for value exactly as visible.",
    "- If no numeric data is readable, return empty numeric_rows but still provide a concise summary."
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a precise extraction engine. Return only strict JSON." },
        { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl, detail: "low" } }] }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${text}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonObject(content);
  return {
    summary: parsed.summary || "",
    numeric_rows: Array.isArray(parsed.numeric_rows) ? parsed.numeric_rows : [],
    text_rows: Array.isArray(parsed.text_rows) ? parsed.text_rows : []
  };
}

async function answerQuestionFromDataset({ question, run, numericRows, summaries }) {
  if (!OPENAI_API_KEY) return fallbackAnswerFromRows(question, numericRows, summaries);

  const prompt = [
    "Answer the user's question using ONLY the provided extracted dataset.",
    "If the answer is not supported by the dataset, say that it is not available from the extracted data.",
    "Be concise and grounded.",
    "",
    `Question: ${question}`,
    "",
    "Dataset:",
    JSON.stringify({ runId: run.runId, clientName: run.clientName, numeric_rows: numericRows.slice(0, 250), summaries: summaries.slice(0, 20) })
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "You answer only from structured extracted dashboard data." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) return fallbackAnswerFromRows(question, numericRows, summaries);
  const json = await response.json();
  return json?.choices?.[0]?.message?.content?.trim() || fallbackAnswerFromRows(question, numericRows, summaries);
}

async function answerQuestionFromSummary({ question, run, summaries }) {
  if (!OPENAI_API_KEY) {
    return `A qualitative summary exists for run ${run.runId}, but no numeric rows were extracted. Please open the report page for details.`;
  }

  const prompt = [
    "Answer the user's question using ONLY these qualitative extraction summaries from a Power BI capture.",
    "If the answer is not directly supported, say so.",
    "",
    `Question: ${question}`,
    "",
    "Summaries:",
    summaries.join("\n")
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "You answer only from supplied summary text." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    return `A qualitative summary exists for run ${run.runId}, but no numeric rows were extracted. Please open the report page for details.`;
  }

  const json = await response.json();
  return json?.choices?.[0]?.message?.content?.trim() || `A qualitative summary exists for run ${run.runId}, but no numeric rows were extracted.`;
}

function fallbackAnswerFromRows(question, numericRows, summaries) {
  const q = String(question || "").toLowerCase();
  if (q.includes("how many")) return `There are ${numericRows.length} extracted numeric row(s) in the current run.`;
  if (numericRows.length > 0) {
    const first = numericRows[0];
    return `The dataset contains extracted numeric rows. One example is \"${first.metric_name}\" with value \"${first.value}\".`;
  }
  if (summaries.length > 0) return "No numeric rows were available, but qualitative summaries exist for this run.";
  return "No extracted data is currently available.";
}

function renderRunReport(run) {
  const states = Object.values(run.states || {});
  const rows = states.map((state) => {
    const reportUrl = `/report?runId=${encodeURIComponent(run.runId)}&stateId=${encodeURIComponent(state.stateId)}`;
    return `<tr><td>${escapeHtml(state.pageName || "")}</td><td>${escapeHtml(state.filterName || "")}</td><td>${escapeHtml(state.filterValue || "")}</td><td>${escapeHtml(String(state.slices?.length || 0))}</td><td>${escapeHtml(state.analysis?.status || "not_started")}</td><td>${escapeHtml(String(state.analysis?.numeric_rows?.length || 0))}</td><td><a href="${reportUrl}" target="_blank">Open report</a></td></tr>`;
  }).join("");

  return `
    <html><head><title>Run Report</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 12px 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; }
      th { background: #f9fafb; }
    </style></head>
    <body>
      <h1>Run Report</h1>
      <div class="card">
        <div><strong>Run ID:</strong> ${escapeHtml(run.runId)}</div>
        <div><strong>Client:</strong> ${escapeHtml(run.clientName || "")}</div>
        <div><strong>Dashboard URL:</strong> ${escapeHtml(run.dashboardUrl || "")}</div>
        <div><strong>State count:</strong> ${states.length}</div>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Page</th><th>Filter</th><th>Value</th><th>Slices</th><th>Status</th><th>Numeric Rows</th><th>Report</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7">No states captured yet.</td></tr>'}</tbody>
        </table>
      </div>
    </body></html>
  `;
}

function renderStateReport(run, state) {
  const analysis = state.analysis || {};
  const numericRows = analysis.numeric_rows || [];
  const rows = numericRows.length
    ? numericRows.map((row) => `<tr><td>${escapeHtml(row.metric_name || "")}</td><td>${escapeHtml(row.value || "")}</td><td>${escapeHtml(row.unit || "")}</td><td>${escapeHtml(row.context || "")}</td><td>${escapeHtml(String(row.slice_index ?? ""))}</td></tr>`).join("")
    : '<tr><td colspan="5">No numeric rows extracted yet.</td></tr>';

  return `
    <html><head><title>State Report</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 12px 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; }
      th { background: #f9fafb; }
      pre { white-space: pre-wrap; }
    </style></head>
    <body>
      <h1>${escapeHtml(state.pageName || "")}</h1>
      <div class="card">
        <div><strong>Run ID:</strong> ${escapeHtml(run.runId)}</div>
        <div><strong>State ID:</strong> ${escapeHtml(state.stateId)}</div>
        <div><strong>Filter:</strong> ${escapeHtml(state.filterName || "")} = ${escapeHtml(state.filterValue || "")}</div>
        <div><strong>Status:</strong> ${escapeHtml(analysis.status || "not_started")}</div>
        <div><strong>Slices:</strong> ${escapeHtml(String(state.slices?.length || 0))}</div>
        <div><strong>Numeric rows:</strong> ${escapeHtml(String(numericRows.length))}</div>
      </div>
      <div class="card"><h2>Summary</h2><pre>${escapeHtml(analysis.summary || "No summary available yet.")}</pre></div>
      <div class="card"><h2>Numeric Extraction Rows</h2>
        <table>
          <thead><tr><th>Metric</th><th>Value</th><th>Unit</th><th>Context</th><th>Slice</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="card"><a href="/report?runId=${encodeURIComponent(run.runId)}" target="_blank">Open full run report</a></div>
    </body></html>
  `;
}

function ensureDirSync(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); }
async function ensureDir(dirPath) { await fsp.mkdir(dirPath, { recursive: true }); }
function makeId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
function getRunFilePath(runId) { return path.join(DATA_DIR, "runs", runId, "run.json"); }

async function getOrCreateRun(runId, seed = {}) {
  const existing = await getRun(runId);
  if (existing) return existing;
  const run = { runId, clientName: seed.clientName || "", dashboardUrl: seed.dashboardUrl || "", createdAt: seed.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), states: {} };
  await saveRun(run);
  return run;
}

async function getRun(runId) {
  if (runCache.has(runId)) return runCache.get(runId);
  const filePath = getRunFilePath(runId);
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    runCache.set(runId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function saveRun(run) {
  const runDir = path.join(DATA_DIR, "runs", run.runId);
  await ensureDir(runDir);
  run.updatedAt = new Date().toISOString();
  const filePath = getRunFilePath(run.runId);
  await fsp.writeFile(filePath, JSON.stringify(run, null, 2), "utf8");
  runCache.set(run.runId, run);
}

async function findLatestRunId() {
  try {
    const entries = await fsp.readdir(path.join(DATA_DIR, "runs"), { withFileTypes: true });
    let latest = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = getRunFilePath(entry.name);
      try {
        const stat = await fsp.stat(filePath);
        if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { runId: entry.name, mtimeMs: stat.mtimeMs };
      } catch {}
    }
    return latest?.runId || null;
  } catch {
    return null;
  }
}

function stripDataUrlPrefix(input) {
  if (!input) return "";
  const idx = input.indexOf("base64,");
  return idx >= 0 ? input.slice(idx + 7) : input;
}

function parseJsonObject(text) {
  if (!text || typeof text !== "string") return {};
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Could not parse JSON from AI response");
  }
}

function sanitizeNumericRows(rows, sliceIndex) {
  return rows.map((row) => ({
    metric_name: String(row.metric_name || "").trim(),
    value: String(row.value || "").trim(),
    unit: String(row.unit || "").trim(),
    context: String(row.context || "").trim(),
    slice_index: row.slice_index ?? sliceIndex,
    numeric_value: parseNumericValue(String(row.value || ""))
  })).filter((row) => row.metric_name || row.value);
}

function sanitizeTextRows(rows, sliceIndex) {
  return rows.map((row) => ({
    label: String(row.label || "").trim(),
    text: String(row.text || "").trim(),
    context: String(row.context || "").trim(),
    slice_index: row.slice_index ?? sliceIndex
  })).filter((row) => row.label || row.text);
}

function parseNumericValue(value) {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function dedupeNumericRows(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = [row.metric_name, row.value, row.unit, row.context, row.slice_index].join("||");
    if (!seen.has(key)) { seen.add(key); result.push(row); }
  }
  return result;
}

function buildSummaryFromExtraction({ state, numericRows, textRows, sliceSummaries }) {
  if (numericRows.length > 0) {
    const preview = numericRows.slice(0, 6).map((r) => `${r.metric_name || "Metric"}: ${r.value}${r.unit ? ` ${r.unit}` : ""}`).join("; ");
    return `Extraction completed for ${state.pageName}${state.filterName ? ` (${state.filterName}: ${state.filterValue})` : ""}. Found ${numericRows.length} numeric row(s).${preview ? ` Key values include ${preview}.` : ""}`;
  }
  if (sliceSummaries.length > 0) return sliceSummaries.map((s) => s.summary).join(" ");
  if (textRows.length > 0) return `Extraction completed for ${state.pageName} (${state.filterName}: ${state.filterValue}) with text observations available but no numeric rows parsed.`;
  return `Extraction completed for ${state.pageName} (${state.filterName}: ${state.filterValue}) but no readable numeric data was found.`;
}

function escapeHtml(input) {
  return String(input || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
