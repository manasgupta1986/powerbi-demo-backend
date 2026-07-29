const express = require("express");
const router = express.Router();

const { getAnalysis, getLatestCompletedAnalysis, getRun } = require("./store");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function buildError(code, message) {
  return { ok: false, error: code, message };
}

function hasUsableData(analysis) {
  const numeric = Array.isArray(analysis?.numeric_rows) ? analysis.numeric_rows.length : 0;
  const text = Array.isArray(analysis?.text_rows) ? analysis.text_rows.length : 0;
  const hints = Array.isArray(analysis?.time_hints) ? analysis.time_hints.length : 0;
  const topInsights = Array.isArray(analysis?.report?.top_insights) ? analysis.report.top_insights.length : 0;
  return numeric > 0 || text > 0 || hints > 0 || topInsights > 0 || Boolean((analysis?.summary || "").trim());
}

router.post("/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json(buildError("server_config", "OPENAI_API_KEY is missing on the backend"));

    const { workspaceName = "default-workspace", runId, question } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json(buildError("bad_request", "question is required"));

    let resolvedRun = null;
    let analysis = null;
    if (runId) {
      resolvedRun = getRun(workspaceName, runId);
      if (!resolvedRun) return res.status(404).json(buildError("not_found", "Run not found"));
      analysis = getAnalysis(workspaceName, runId);
      if (!analysis) {
        if (["queued", "extracting", "started", "upload_complete", "collecting"].includes(resolvedRun.status)) return res.status(409).json(buildError("extraction_pending", "Extraction is still running for this run"));
        if (resolvedRun.status === "failed") return res.status(409).json(buildError("extraction_failed", resolvedRun.error || "Extraction failed for this run"));
      }
    } else {
      const latest = getLatestCompletedAnalysis(workspaceName);
      if (!latest) return res.status(404).json(buildError("extraction_pending", "No completed run is available yet"));
      resolvedRun = latest.run;
      analysis = latest.analysis;
    }

    if (!analysis) return res.status(409).json(buildError("extraction_pending", "No analysis is available yet for this run"));
    if (!hasUsableData(analysis)) return res.status(409).json(buildError("no_numeric_rows", "Analysis completed but no usable data was extracted."));

    const grounding = {
      runId: resolvedRun.runId,
      clientName: resolvedRun.clientName || "",
      createdAt: resolvedRun.createdAt,
      finishedAt: resolvedRun.finishedAt,
      time_hints: analysis.time_hints || [],
      numeric_rows: analysis.numeric_rows || [],
      text_rows: analysis.text_rows || [],
      summary: analysis.summary || "",
      report: analysis.report || {}
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "You answer only from the supplied extracted dashboard data. Use top_insights as the primary grounding when relevant. Use baseline vs filtered-cut comparisons when discussing what is hurting the business. Use time_hints as authoritative evidence for visible week labels. Never hallucinate missing dimensions such as categories. If exact values are unavailable but the direction of risk is visible, say so clearly."
          },
          { role: "user", content: `Grounding JSON:\n${JSON.stringify(grounding, null, 2)}\n\nQuestion: ${String(question).trim()}` }
        ]
      })
    });

    const raw = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(500).json(buildError("chat_failed", raw?.error?.message || "Chat request failed"));
    const answer = raw?.choices?.[0]?.message?.content || "No answer returned.";
    return res.json({ ok: true, runId: resolvedRun.runId, createdAt: resolvedRun.createdAt, finishedAt: resolvedRun.finishedAt, answer });
  } catch (error) {
    return res.status(500).json(buildError("chat_failed", error.message || "Chat failed"));
  }
});

module.exports = router;
