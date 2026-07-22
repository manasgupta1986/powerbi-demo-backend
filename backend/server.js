const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// IMPORTANT: On Render, set DATA_DIR=/var/data
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "local-data");
const DATA_DIR = path.join(DATA_ROOT, "data");
const REPORTS_DIR = path.join(DATA_ROOT, "reports");
const SCREENSHOTS_DIR = path.join(DATA_ROOT, "screenshots");

[DATA_ROOT, DATA_DIR, REPORTS_DIR, SCREENSHOTS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Expose saved screenshots and files
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
    .slice(0, 80);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function saveDataUrlImage(dataUrl, fileBaseName) {
  if (!dataUrl || !dataUrl.startsWith("data:image")) {
    return null;
  }

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

function buildPromptFromRun(run, originalCapturesForModel = []) {
  const captureSummary = (run.captures || []).map((c, i) => {
    return [
      `Capture ${i + 1}`,
      `Phase: ${c.phase || "unknown"}`,
      `Page: ${c.pageName || "unknown"}`,
      `Filter: ${c.filterName || "baseline"}`,
      `Value: ${c.filterValue || "overall"}`,
      `Verification: ${c.verificationNote || "n/a"}`,
      `Visible text sample: ${(c.visibleText || "").slice(0, 900)}`
    ].join("\n");
  }).join("\n\n--------------------\n\n");

  const promptText = `
You are writing a manager-friendly Power BI insight report for a category / insights lead.

Context:
- Client: ${run.clientName || "Unknown client"}
- Dashboard URL: ${run.dashboardUrl || ""}
- Run time: ${run.createdAt || ""}
- Pages captured: ${(run.pages || []).join(", ")}
- Filters swept: ${(run.filters || []).map(f => f.filterName).join(", ")}

Important instructions:
1. First summarize the BASELINE overall picture across pages.
2. Then compare cohort-level differences for Zone / Age / Gender / NCCS / Tier if present.
3. Identify strongest and weakest cohorts directionally.
4. Highlight possible traffic, engagement, purchase, or funnel leakage signals.
5. Write for a business user, not a developer.
6. Do NOT produce debug language like "capture succeeded".
7. If exact numeric proof is not visible, say "directionally suggests" or "visually appears".
8. Output in this structure:

EXECUTIVE TAKEAWAY
BASELINE OVERALL VIEW
KEY COHORT SIGNALS
PAGE-BY-PAGE OBSERVATIONS
RECOMMENDED ACTIONS
CONFIDENCE / CAVEATS

Here is the extracted capture text:

${captureSummary}
  `.trim();

  // To control payload size, only pass a limited number of screenshots to the model
  const imageInputs = originalCapturesForModel
    .filter(c => c.screenshotDataUrl && c.screenshotDataUrl.startsWith("data:image"))
    .slice(0, 10)
    .map(c => ({
      type: "image_url",
      image_url: {
        url: c.screenshotDataUrl
      }
    }));

  return {
    promptText,
    imageInputs
  };
}

async function generateInsightSummary(run, originalCapturesForModel = []) {
  if (!OPENAI_API_KEY) {
    return fallbackSummary(run);
  }

  const { promptText, imageInputs } = buildPromptFromRun(run, originalCapturesForModel);

  const body = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "You are a sharp retail / category insights analyst. Write concise, business-useful, actionable summaries from dashboard captures."
      },
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          ...imageInputs
        ]
      }
    ],
    temperature: 0.3
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("OpenAI error:", text);
    return fallbackSummary(run);
  }

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content?.trim();

  return text || fallbackSummary(run);
}

function fallbackSummary(run) {
  const pages = [...new Set((run.captures || []).map(c => c.pageName).filter(Boolean))];
  const filters = [...new Set((run.captures || []).map(c => c.filterName).filter(Boolean))];
  const totalCaptures = (run.captures || []).length;

  return `
EXECUTIVE TAKEAWAY
This is a saved dashboard run for ${run.clientName || "the client"} with ${totalCaptures} captures across ${pages.length} page(s). AI analysis is not active, so this is a basic fallback summary.

BASELINE OVERALL VIEW
Pages captured: ${pages.join(", ") || "none"}.

KEY COHORT SIGNALS
Filters captured: ${filters.join(", ") || "none"}.
For deeper business insights, ensure OPENAI_API_KEY is set in Render Environment.

PAGE-BY-PAGE OBSERVATIONS
The system successfully saved dashboard states and screenshots. Review the screenshots in the report for directional comparison.

RECOMMENDED ACTIONS
1. Keep the dashboard manually set to the correct date range before running.
2. Use 2-3 filters first for demo stability.
3. Review baseline before cohort cuts.

CONFIDENCE / CAVEATS
This fallback does not infer deep cohort strategy. It mainly confirms that the sweep and storage worked.
  `.trim();
}

function buildHtmlReport(run) {
  const summaryHtml = escapeHtml(run.summary || "").replace(/\n/g, "<br>");
  const captures = run.captures || [];

  const cardsHtml = captures.map((c) => {
    return `
      <div class="card">
        <div class="meta">
          <strong>${escapeHtml(c.pageName || "Unknown page")}</strong><br>
          Phase: ${escapeHtml(c.phase || "unknown")}<br>
          Filter: ${escapeHtml(c.filterName || "baseline")}<br>
          Value: ${escapeHtml(c.filterValue || "overall")}<br>
          Verification: ${escapeHtml(c.verificationNote || "n/a")}
        </div>
        ${c.screenshotUrl ? `<img src="${c.screenshotUrl}" alt="capture">` : ""}
        <details>
          <summary>Visible text sample</summary>
          <pre>${escapeHtml((c.visibleText || "").slice(0, 3000))}</pre>
        </details>
      </div>
    `;
  }).join("\n");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Power BI Saved Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 24px;
      color: #222;
      background: #f7f8fb;
    }
    h1, h2 {
      margin-bottom: 8px;
    }
    .topbox, .summary, .captures {
      background: white;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 18px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    .summaryText {
      white-space: normal;
      line-height: 1.5;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 16px;
    }
    .card {
      border: 1px solid #ddd;
      border-radius: 10px;
      background: #fff;
      padding: 12px;
    }
    .card img {
      width: 100%;
      border-radius: 8px;
      margin-top: 10px;
      border: 1px solid #ccc;
    }
    .meta {
      font-size: 13px;
      line-height: 1.4;
      color: #444;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      background: #fafafa;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="topbox">
    <h1>Power BI Saved Report</h1>
    <div><strong>Client:</strong> ${escapeHtml(run.clientName || "")}</div>
    <div><strong>Created at:</strong> ${escapeHtml(run.createdAt || "")}</div>
    <div><strong>Dashboard URL:</strong> ${escapeHtml(run.dashboardUrl || "")}</div>
    <div><strong>Pages:</strong> ${escapeHtml((run.pages || []).join(", "))}</div>
    <div><strong>Filters:</strong> ${escapeHtml((run.filters || []).map(f => f.filterName).join(", "))}</div>
  </div>

  <div class="summary">
    <h2>Insight Summary</h2>
    <div class="summaryText">${summaryHtml}</div>
  </div>

  <div class="captures">
    <h2>Saved Captures</h2>
    <div class="grid">
      ${cardsHtml || "<p>No captures saved.</p>"}
    </div>
  </div>
</body>
</html>
  `.trim();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "powerbi-demo-backend",
    dataRoot: DATA_ROOT
  });
});

app.get("/latest-data", (req, res) => {
  const file = path.join(DATA_DIR, "latest-run.json");
  if (!fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "No saved run found yet." });
  }

  const json = readJsonSafe(file, null);
  if (!json) {
    return res.status(500).json({ ok: false, error: "Saved run file exists but could not be read." });
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
      if (savedImage) {
        screenshotUrl = savedImage.publicUrl;
      }

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

    const latestRun = {
      clientName: clientName || "",
      dashboardUrl: dashboardUrl || "",
      createdAt,
      pages: Array.isArray(pages) ? pages : [],
      filters: Array.isArray(filters) ? filters : [],
      captures: savedCaptures
    };

    const summary = await generateInsightSummary(latestRun, captures);
    latestRun.summary = summary;

    // Save latest
    writeJson(path.join(DATA_DIR, "latest-run.json"), latestRun);
    fs.writeFileSync(path.join(REPORTS_DIR, "latest-report.html"), buildHtmlReport(latestRun), "utf8");

    // Save history copy too
    writeJson(path.join(DATA_DIR, `run-${stamp}.json`), latestRun);
    fs.writeFileSync(path.join(REPORTS_DIR, `report-${stamp}.html`), buildHtmlReport(latestRun), "utf8");

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    res.json({
      ok: true,
      message: "Analysis saved successfully.",
      latestDataUrl: `${baseUrl}/latest-data`,
      latestReportUrl: `${baseUrl}/latest-report`,
      summary
    });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Power BI demo backend running on port ${PORT}`);
  console.log(`DATA_ROOT = ${DATA_ROOT}`);
});
