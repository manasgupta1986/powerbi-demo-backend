const express = require("express");
const router = express.Router();

const { getAnalysis, getLatestCompletedAnalysis, getRun } = require("./store");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function buildNoDataError(status, message) {
  return { ok: false, error: status, message };
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
    if (!apiKey) return res.status(500).json(buildNoDataError("server_config", "OPENAI_API_KEY is missing on the backend"));

    const { workspaceName = "default-workspace", runId, question } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json(buildNoDataError("bad_request", "question is required"));
    }

    let resolvedRun = null;
    let analysis = null;

    if (runId) {
      resolvedRun = getRun(workspaceName, runId);
      if (!resolvedRun) return res.status(404).json(buildNoDataError("not_found", "Run not found"));
      analysis = getAnalysis(workspaceName, runId);
      if (!analysis) {
        if (["queued", "extracting", "started", "upload_complete"].includes(resolvedRun.status)) {
          return res.status(409).json(buildNoDataError("extraction_pending", "Extraction is still running for this run"));
        }
        if (resolvedRun.status === "failed") {
          return res.status(409).json(buildNoDataError("extraction_failed", resolvedRun.error || "Extraction failed for this run"));
        }
      }
    } else {
      const latest = getLatestCompletedAnalysis(workspaceName);
      if (!latest) return res.status(404).json(buildNoDataError("extraction_pending", "No completed run is available yet"));
      resolvedRun = latest.run;
      analysis = latest.analysis;
    }

    if (!analysis) {
      return res.status(409).json(buildNoDataError("extraction_pending", "No analysis is available yet for this run"));
    }
    if (!hasUsableData(analysis)) {
      return res.status(409).json(buildNoDataError("no_numeric_rows", "Analysis completed but no usable data was extracted. Retry with server-side slicing or better screenshot clarity."));
    }

    const grounding = {
      runId: resolvedRun.runId,
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
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You answer only from the supplied extracted dashboard data. If the answer is uncertain, say so clearly and cite the relevant metric names or notes."
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
      return res.status(500).json(buildNoDataError("chat_failed", raw?.error?.message || "Chat request failed"));
    }

    const answer = raw?.choices?.[0]?.message?.content || "No answer returned.";
    return res.json({ ok: true, runId: resolvedRun.runId, createdAt: resolvedRun.createdAt, finishedAt: resolvedRun.finishedAt, answer });
  } catch (error) {
    return res.status(500).json(buildNoDataError("chat_failed", error.message || "Chat failed"));
  }
});

module.exports = router;
