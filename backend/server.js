const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "120mb" }));

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "local-data");
const DATA_DIR = path.join(DATA_ROOT, "data");
const REPORTS_DIR = path.join(DATA_ROOT, "reports");
const SCREENSHOTS_DIR = path.join(DATA_ROOT, "screenshots");

[DATA_ROOT, DATA_DIR, REPORTS_DIR, SCREENSHOTS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use("/storage", express.static(DATA_ROOT));

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function sanitizeName(value) {
  return String(value || "unknown")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function extractJsonObject(text) {
  if (!text) return null;
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    return null;
  }
}

function saveDataUrlImage(dataUrl, fileBaseName) {
  if (!dataUrl || !dataUrl.startsWith("data:image")) return null;
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return null;

  const buffer = Buffer.from(match[1], "base64");
  const fileName = `${sanitizeName(fileBaseName)}.png`;
  const filePath = path.join(SCREENSHOTS_DIR, fileName);
  fs.writeFileSync(filePath, buffer);

  return {
    fileName,
    filePath,
    publicUrl: `/storage/screenshots/${fileName}`
  };
}

function isoWeekStartDate(weekCode) {
  if (!weekCode) return null;
  const match = String(weekCode).match(/(\d{4})-?W(\d{1,2})/i);
  if (!match) return null;

  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!year || !week) return null;

  const simple = new Date(Date.UTC(year, 0, 4));
  const day = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - day + 1 + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

function enrichWeekDates(chartExtractions = []) {
  for (const capture of chartExtractions) {
    for (const chart of capture.charts || []) {
      for (const series of chart.series || []) {
        for (const point of series.points || []) {
          if (!point.week_start_date && point.x_label) {
            point.week_start_date = isoWeekStartDate(point.x_label);
          }
        }
      }
    }
  }
  return chartExtractions;
}

async function callOpenAI(messages, temperature = 0.2) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages,
      temperature
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${text}`);
  }

  const json = await response.json();
  return json?.choices?.[0]?.message?.content?.trim() || "";
}

async function extractChartsFromCapture(capture) {
  const prompt = `You are a chart-data extraction engine. Use ONLY the screenshot and the provided visible text. Do not use outside knowledge.

Your task:
1. Identify every visible graph/chart on this screenshot.
2. For each chart, identify what the chart is about.
3. Read the x-axis labels and y-axis scale/unit if visible.
4. Estimate numeric values for each visible app/series for each visible x-axis point.
5. Approximate values are allowed, but keep them grounded in the chart.
6. If a value is not inferable, omit that point instead of inventing.
7. If x-axis contains week labels like 2026-W1, keep them exactly as seen in x_label.
8. Output STRICT JSON only.

Return this exact JSON shape:
{
  "capture_context": {
    "page_name": "${capture.pageName || ""}",
    "phase": "${capture.phase || ""}",
    "filter_name": "${capture.filterName || ""}",
    "filter_value": "${capture.filterValue || ""}"
  },
  "charts": [
    {
      "chart_title": "",
      "metric_name": "",
      "chart_type": "line|bar|stacked bar|area|table|funnel|other",
      "chart_visibility": "full|partial",
      "x_axis_label": "",
      "y_axis_label": "",
      "y_axis_unit": "%|count|index|currency|unknown",
      "series": [
        {
          "app_name": "",
          "points": [
            {
              "x_label": "2026-W1",
              "approx_value": 12.3,
              "unit": "%",
              "week_start_date": null
            }
          ]
        }
      ],
      "notes": []
    }
  ],
  "capture_notes": []
}

Visible text extracted from the page:
${(capture.visibleText || "").slice(0, 12000)}`;

  const content = [
    { type: "text", text: prompt }
  ];

  if (capture.screenshotDataUrl) {
    content.push({
      type: "image_url",
      image_url: { url: capture.screenshotDataUrl }
    });
  }

  const resultText = await callOpenAI([
    {
      role: "system",
      content: "You extract structured chart data from screenshots. Always return valid JSON only."
    },
    {
      role: "user",
      content
    }
  ], 0.1);

  const parsed = extractJsonObject(resultText);
  if (!parsed) {
    return {
      capture_context: {
        page_name: capture.pageName || "",
        phase: capture.phase || "",
        filter_name: capture.filterName || "",
        filter_value: capture.filterValue || ""
      },
      charts: [],
      capture_notes: ["Chart extraction failed to parse as JSON."]
    };
  }

  return parsed;
}

function fallbackSummary(run) {
  const pages = [...new Set((run.captures || []).map(c => c.pageName).filter(Boolean))];
  const chartCount = (run.chartExtractions || []).reduce((sum, item) => sum + (item.charts || []).length, 0);

  return `
EXECUTIVE TAKEAWAY
This saved run for ${run.clientName || "the client"} contains ${chartCount} extracted chart(s) across ${pages.length} page(s). AI strategic analysis is not active, so this is a fallback summary.

NUMERIC HIGHLIGHTS
Structured chart extraction was saved, but no AI-generated numeric interpretation is available because OPENAI_API_KEY is missing or failed.

WHAT IMPROVED
Review the extracted chart tables in the report to inspect week-by-week movements.

WHAT WEAKENED
Review the extracted chart tables in the report to inspect dips or declines.

SUGGESTED ACTIONS
1. Confirm OPENAI_API_KEY is present in Render.
2. Keep the dashboard focused on the last 4 weeks.
3. Run with a small filter set first for stable chart extraction.

CAVEATS
This fallback is storage-first, not strategy-first. It saves the chart evidence but does not generate the richer narrative.`.trim();
}

async function buildStrategicSummary(run) {
  if (!OPENAI_API_KEY) return fallbackSummary(run);

  const dataset = {
    client_name: run.clientName,
    dashboard_url: run.dashboardUrl,
    created_at: run.createdAt,
    pages: run.pages,
    filters: run.filters,
    chart_extractions: run.chartExtractions
  };

  const prompt = `You are preparing a strategic weekly dashboard report for ${run.clientName || "the client"}'s insights and category lead.

Rules:
1. Use ONLY the dataset below. Do not use outside facts, assumptions, campaigns, or market knowledge.
2. Be numeric. Instead of saying "grew", say "grew by approx. X%" or "rose by approx. X points" whenever the dataset supports it.
3. Focus on the recent weekly trend visible in the extracted chart points.
4. Do NOT summarise each graph one by one mechanically. Synthesize across charts.
5. Write from the client's point of view. If the client's app/series appears in the data, focus on its improvements, dips, and competitive position.
6. If a number is approximate, say "approx.".
7. If the data is too weak for a conclusion, say so.
8. Keep the analysis purely data-derived.
9. Use this section structure exactly:

EXECUTIVE TAKEAWAY
NUMERIC HIGHLIGHTS
WHAT IMPROVED
WHAT WEAKENED
COMPETITIVE WATCHOUTS
SUGGESTED ACTIONS
CAVEATS

Dataset:
${JSON.stringify(dataset).slice(0, 120000)}`;

  try {
    const resultText = await callOpenAI([
      {
        role: "system",
        content: "You are a rigorous retail and app performance analyst. You only use provided data."
      },
      {
        role: "user",
        content: prompt
      }
    ], 0.2);

    return resultText || fallbackSummary(run);
  } catch (err) {
    console.error("Summary error", err.message);
    return fallbackSummary(run);
  }
}

function buildHtmlReport(run) {
  const summaryHtml = escapeHtml(run.summary || "").replace(/\n/g, "<br>");

  const extractionHtml = (run.chartExtractions || []).map((capture, captureIndex) => {
    const chartsHtml = (capture.charts || []).map((chart, chartIndex) => {
      const seriesHtml = (chart.series || []).map((series) => {
        const rows = (series.points || []).map((point) => `
          <tr>
            <td>${escapeHtml(point.x_label || "")}</td>
            <td>${escapeHtml(point.week_start_date || "")}</td>
            <td>${escapeHtml(point.approx_value)}</td>
            <td>${escapeHtml(point.unit || chart.y_axis_unit || "")}</td>
          </tr>
        `).join("");

        return `
          <div class="seriesBox">
            <h5>${escapeHtml(series.app_name || "Unknown series")}</h5>
            <table>
              <thead>
                <tr>
                  <th>X label</th>
                  <th>Week start</th>
                  <th>Approx value</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                ${rows || `<tr><td colspan="4">No points extracted</td></tr>`}
              </tbody>
            </table>
          </div>
        `;
      }).join("");

      return `
        <div class="chartCard">
          <h4>${captureIndex + 1}.${chartIndex + 1} ${escapeHtml(chart.chart_title || chart.metric_name || "Untitled chart")}</h4>
          <div class="metaGrid">
            <div><strong>Page</strong><br>${escapeHtml(capture.capture_context?.page_name || "")}</div>
            <div><strong>Phase</strong><br>${escapeHtml(capture.capture_context?.phase || "")}</div>
            <div><strong>Filter</strong><br>${escapeHtml(capture.capture_context?.filter_name || "")}</div>
            <div><strong>Value</strong><br>${escapeHtml(capture.capture_context?.filter_value || "")}</div>
            <div><strong>Chart type</strong><br>${escapeHtml(chart.chart_type || "")}</div>
            <div><strong>Y unit</strong><br>${escapeHtml(chart.y_axis_unit || "")}</div>
          </div>
          <div class="notes"><strong>Notes:</strong> ${escapeHtml((chart.notes || []).join(" | "))}</div>
          ${seriesHtml || `<div class="notes">No chart series extracted.</div>`}
        </div>
      `;
    }).join("");

    return `
      <section class="captureSection">
        <h3>Capture ${captureIndex + 1}: ${escapeHtml(capture.capture_context?.page_name || "Unnamed page")}</h3>
        ${chartsHtml || `<div class="notes">No charts extracted from this screenshot.</div>`}
      </section>
    `;
  }).join("");

  const screenshotHtml = (run.captures || []).map((capture) => `
    <div class="shotCard">
      <div class="shotMeta">
        <strong>${escapeHtml(capture.pageName || "")}</strong><br>
        ${escapeHtml(capture.filterName || "baseline")} | ${escapeHtml(capture.filterValue || "overall")}<br>
        ${escapeHtml(capture.verificationNote || "")}
      </div>
      ${capture.screenshotUrl ? `<img src="${capture.screenshotUrl}" alt="capture">` : ""}
    </div>
  `).join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Power BI Strategic Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #f6f8fb; color: #1f2937; }
    .box { background: white; border-radius: 14px; padding: 18px; margin-bottom: 18px; box-shadow: 0 2px 14px rgba(0,0,0,0.08); }
    h1,h2,h3,h4,h5 { margin-top: 0; }
    .summaryText { line-height: 1.55; white-space: normal; }
    .metaGrid { display: grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr)); gap: 10px; font-size: 13px; margin-bottom: 12px; }
    .chartCard, .shotCard { border: 1px solid #d8dee7; border-radius: 12px; padding: 12px; margin-bottom: 14px; background: #fff; }
    .captureSection { margin-bottom: 24px; }
    .seriesBox { margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
    th, td { border: 1px solid #e4e8ef; padding: 8px; text-align: left; }
    th { background: #f7fafc; }
    .notes { font-size: 13px; color: #475569; margin: 8px 0; }
    img { width: 100%; border-radius: 10px; border: 1px solid #d7dde5; margin-top: 8px; }
    .twoCol { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; }
    @media (max-width: 900px) { .twoCol { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="box">
    <h1>Power BI Strategic Report</h1>
    <div><strong>Client:</strong> ${escapeHtml(run.clientName || "")}</div>
    <div><strong>Created at:</strong> ${escapeHtml(run.createdAt || "")}</div>
    <div><strong>Dashboard URL:</strong> ${escapeHtml(run.dashboardUrl || "")}</div>
    <div><strong>Pages:</strong> ${escapeHtml((run.pages || []).join(", "))}</div>
  </div>

  <div class="box">
    <h2>Strategic Summary</h2>
    <div class="summaryText">${summaryHtml}</div>
  </div>

  <div class="box">
    <h2>Extracted Chart Dataset</h2>
    ${extractionHtml || "<p>No chart extraction available.</p>"}
  </div>

  <div class="box">
    <h2>Source Screenshots</h2>
    <div class="twoCol">
      ${screenshotHtml || "<p>No screenshots saved.</p>"}
    </div>
  </div>
</body>
</html>
  `.trim();
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "powerbi-demo-backend", dataRoot: DATA_ROOT });
});

app.get("/latest-data", (req, res) => {
  const file = path.join(DATA_DIR, "latest-run.json");
  if (!fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "No saved run found yet." });
  }
  const json = readJsonSafe(file, null);
  if (!json) {
    return res.status(500).json({ ok: false, error: "Saved run exists but could not be read." });
  }
  res.json({ ok: true, data: json });
});

app.get("/latest-report", (req, res) => {
  const file = path.join(REPORTS_DIR, "latest-report.html");
  if (!fs.existsSync(file)) {
    return res.status(404).send("No saved report found yet.");
  }
  res.sendFile(file);
});

app.post("/analyze", async (req, res) => {
  try {
    const { clientName, dashboardUrl, pages, filters, captures } = req.body || {};
    if (!Array.isArray(captures) || captures.length === 0) {
      return res.status(400).json({ ok: false, error: "No captures received." });
    }

    const createdAt = new Date().toISOString();
    const stamp = isoStamp();

    const savedCaptures = captures.map((capture, index) => {
      const baseName = [
        stamp,
        capture.phase || "phase",
        capture.pageName || "page",
        capture.filterName || "baseline",
        capture.filterValue || "overall",
        index + 1
      ].map(sanitizeName).join("_");

      let screenshotUrl = "";
      const savedImage = saveDataUrlImage(capture.screenshotDataUrl, baseName);
      if (savedImage) screenshotUrl = savedImage.publicUrl;

      return {
        phase: capture.phase || "unknown",
        pageName: capture.pageName || "",
        filterName: capture.filterName || "",
        filterValue: capture.filterValue || "",
        visibleText: capture.visibleText || "",
        verificationNote: capture.verificationNote || "",
        screenshotUrl
      };
    });

    let chartExtractions = [];
    if (OPENAI_API_KEY) {
      for (const capture of captures) {
        try {
          const extraction = await extractChartsFromCapture(capture);
          chartExtractions.push(extraction);
        } catch (err) {
          chartExtractions.push({
            capture_context: {
              page_name: capture.pageName || "",
              phase: capture.phase || "",
              filter_name: capture.filterName || "",
              filter_value: capture.filterValue || ""
            },
            charts: [],
            capture_notes: [`Extraction error: ${err.message}`]
          });
        }
      }
    }

    chartExtractions = enrichWeekDates(chartExtractions);

    const latestRun = {
      clientName: clientName || "",
      dashboardUrl: dashboardUrl || "",
      createdAt,
      pages: Array.isArray(pages) ? pages : [],
      filters: Array.isArray(filters) ? filters : [],
      captures: savedCaptures,
      chartExtractions
    };

    latestRun.summary = await buildStrategicSummary(latestRun);

    writeJson(path.join(DATA_DIR, "latest-run.json"), latestRun);
    fs.writeFileSync(path.join(REPORTS_DIR, "latest-report.html"), buildHtmlReport(latestRun), "utf8");
    writeJson(path.join(DATA_DIR, `run-${stamp}.json`), latestRun);
    fs.writeFileSync(path.join(REPORTS_DIR, `report-${stamp}.html`), buildHtmlReport(latestRun), "utf8");

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json({
      ok: true,
      message: "Analysis saved successfully.",
      latestDataUrl: `${baseUrl}/latest-data`,
      latestReportUrl: `${baseUrl}/latest-report`,
      summary: latestRun.summary
    });
  } catch (err) {
    console.error("Analyze error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/ask", async (req, res) => {
  try {
    const { question, history } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ ok: false, error: "Question is required." });
    }

    const latestRun = readJsonSafe(path.join(DATA_DIR, "latest-run.json"), null);
    if (!latestRun) {
      return res.status(404).json({ ok: false, error: "No saved run found yet." });
    }

    if (!OPENAI_API_KEY) {
      return res.json({
        ok: true,
        answer: "Closed-book chat is configured, but OPENAI_API_KEY is missing on the backend. Add the API key in Render to enable chat answers from the extracted dashboard dataset."
      });
    }

    const historyText = Array.isArray(history)
      ? history.slice(-8).map((m) => `${m.role}: ${m.content}`).join("\n")
      : "";

    const prompt = `You are answering questions only from the extracted dashboard dataset below.

Rules:
1. Use only the provided dataset and summary.
2. Do not use outside knowledge.
3. If the answer is not supported by the dataset, say that the data captured does not show it clearly.
4. If the user explicitly asks to check online, say that online lookup is not enabled in this backend build.
5. Answer in a concise, chat-style format.
6. When possible, use approximate numeric values from the extracted chart data.

Client name: ${latestRun.clientName || ""}
Strategic summary:
${latestRun.summary || ""}

Extracted chart dataset:
${JSON.stringify(latestRun.chartExtractions).slice(0, 120000)}

Recent chat history:
${historyText}

User question:
${question}`;

    const answer = await callOpenAI([
      {
        role: "system",
        content: "You are a disciplined dashboard QA assistant grounded only in supplied data."
      },
      {
        role: "user",
        content: prompt
      }
    ], 0.2);

    res.json({ ok: true, answer });
  } catch (err) {
    console.error("Ask error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Power BI backend running on port ${PORT}`);
  console.log(`DATA_ROOT=${DATA_ROOT}`);
});
