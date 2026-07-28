const express = require("express");
const router = express.Router();

const { getAnalysis, getLatestCompletedAnalysis, getRun } = require("./store");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function buildError(code, message) {
  return { ok: false, error: code, message };
}

function numericCount(analysis) {
  return Array.isArray(analysis?.numeric_rows) ? analysis.numeric_rows.length : 0;
}

function textCount(analysis) {
  return Array.isArray(analysis?.text_rows) ? analysis.text_rows.length : 0;
}

function hasUsableData(analysis) {
  return numericCount(analysis) > 0 || textCount(analysis) > 0 || Boolean((analysis?.summary || "").trim());
}

router.post("/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json(buildError("server_config", "OPENAI_API_KEY is missing on the backend"));

    const { workspaceName = "default-workspace", runId, question } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json(buildError("bad_request", "question is required"));
    }

    let resolvedRun = null;
    let analysis = null;

    if (runId) {
      resolvedRun = getRun(workspaceName, runId);
      if (!resolvedRun) return res.status(404).json(buildError("not_found", "Run not found"));
      analysis = getAnalysis(workspaceName, runId);
      if (!analysis) {
        if (["queued", "extracting", "started", "upload_complete", "collecting"].includes(resolvedRun.status)) {
          return res.status(409).json(buildError("extraction_pending", "Extraction is still running for this run"));
        }
        if (resolvedRun.status === "failed") {
          return res.status(409).json(buildError("extraction_failed", resolvedRun.error || "Extraction failed for this run"));
        }
      }
    } else {
      const latest = getLatestCompletedAnalysis(workspaceName);
      if (!latest) return res.status(404).json(buildError("extraction_pending", "No completed run is available yet"));
      resolvedRun = latest.run;
      analysis = latest.analysis;
    }

    if (!analysis) {
      return res.status(409).json(buildError("extraction_pending", "No analysis is available yet for this run"));
    }
    if (!hasUsableData(analysis)) {
      return res.status(409).json(buildError("no_numeric_rows", "Analysis completed but no usable data was extracted. Retry with server-side slicing or better screenshot clarity."));
    }

    const grounding = {
      runId: resolvedRun.runId,
      clientName: resolvedRun.clientName || "",
      createdAt: resolvedRun.createdAt,
      finishedAt: resolvedRun.finishedAt,
      numeric_rows: analysis.numeric_rows || [],
      text_rows: analysis.text_rows || [],
      summary: analysis.summary || "",
      report: analysis.report || {}
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "You answer only from the supplied extracted dashboard data. Never hallucinate unseen dimensions such as categories when they are absent from the extracted rows. If week labels like '2026-W1 – 19/12/2025' or week_start_date values are present, treat the date after the dash as the week start and reason across recent weeks, especially the last 4 visible weeks when possible. The user wants insight-led answers for CMI and category leads, not plain chart reading. If the data is approximate or insufficient, say so clearly."
          },
          {
            role: "user",
            content: `Grounding JSON:\n${JSON.stringify(grounding, null, 2)}\n\nQuestion: ${String(question).trim()}`
          }
        ]
      })
    });

    const raw = await response.json();
    if (!response.ok) {
      return res.status(500).json(buildError("chat_failed", raw?.error?.message || "Chat request failed"));
    }

    const answer = raw?.choices?.[0]?.message?.content || "No answer returned.";
    return res.json({ ok: true, runId: resolvedRun.runId, createdAt: resolvedRun.createdAt, finishedAt: resolvedRun.finishedAt, answer });
  } catch (error) {
    return res.status(500).json(buildError("chat_failed", error.message || "Chat failed"));
  }
});

module.exports = router;
