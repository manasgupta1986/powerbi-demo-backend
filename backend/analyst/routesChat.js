const express = require("express");
const router = express.Router();

const {
  getRun,
  getAnalysis,
  getLatestCompletedAnalysis
} = require("./store");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureString(value) {
  return typeof value === "string" ? value : "";
}

function trimMessages(messages) {
  const safe = ensureArray(messages)
    .filter((msg) => msg && typeof msg === "object")
    .map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: ensureString(msg.content)
    }))
    .filter((msg) => msg.content);

  return safe.slice(-12);
}

async function askGroundedChat({
  workspaceName,
  runId,
  analysis,
  messages,
  userQuestion
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing on the backend");
  }

  const groundedContext = {
    workspaceName,
    runId,
    generatedAt: analysis.createdAt || "",
    summary: ensureString(analysis.summary),
    report: analysis.report || {},
    numeric_rows: ensureArray(analysis.numeric_rows),
    text_rows: ensureArray(analysis.text_rows)
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
          content: [
            "You are a closed-book BI analyst assistant.",
            "Use ONLY the supplied extracted dataset and summary report.",
            "Do not use outside knowledge.",
            "If the answer is not grounded in the supplied data, say so clearly.",
            "Answer in a concise but analytical style.",
            "When possible, mention the source screenshot file name, run timestamp, or filter context."
          ].join(" ")
        },
        {
          role: "system",
          content: `Grounded analysis context:\n${JSON.stringify(
            groundedContext,
            null,
            2
          )}`
        },
        ...trimMessages(messages),
        {
          role: "user",
          content: ensureString(userQuestion)
        }
      ]
    })
  });

  const raw = await response.json();

  if (!response.ok) {
    throw new Error(raw?.error?.message || "OpenAI chat request failed");
  }

  return (
    raw?.choices?.[0]?.message?.content ||
    "No grounded answer was returned."
  );
}

router.post("/chat", async (req, res) => {
  try {
    const { workspaceName, runId, messages, userQuestion } = req.body || {};

    if (!workspaceName) {
      return res.status(400).json({
        ok: false,
        error: "workspaceName is required"
      });
    }

    if (!userQuestion) {
      return res.status(400).json({
        ok: false,
        error: "userQuestion is required"
      });
    }

    let run = null;
    let analysis = null;
    let resolvedRunId = runId || null;

    if (runId) {
      run = getRun(workspaceName, runId);

      if (!run) {
        return res.status(404).json({
          ok: false,
          error: "Run not found"
        });
      }

      analysis = getAnalysis(workspaceName, runId);

      if (!analysis) {
        if (run.status === "queued" || run.status === "extracting") {
          return res.status(409).json({
            ok: false,
            reason: "extraction_pending",
            message:
              "Extraction is still in progress for the selected run. Please wait and try again."
          });
        }

        if (run.status === "failed") {
          return res.status(409).json({
            ok: false,
            reason: "extraction_failed",
            message:
              "Extraction failed for the selected run. Please review the run status and try again."
          });
        }

        return res.status(409).json({
          ok: false,
          reason: "analysis_missing",
          message:
            "No extracted analysis is available for the selected run yet."
        });
      }
    } else {
      const latest = getLatestCompletedAnalysis(workspaceName);

      if (!latest || !latest.analysis || !latest.run) {
        return res.status(404).json({
          ok: false,
          reason: "no_completed_analysis",
          message:
            "No completed analysis exists yet for this workspace. Upload screenshots and run analysis first."
        });
      }

      run = latest.run;
      analysis = latest.analysis;
      resolvedRunId = latest.run.runId;
    }

    const numericRows = ensureArray(analysis.numeric_rows);
    const textRows = ensureArray(analysis.text_rows);
    const summary = ensureString(analysis.summary).trim();

    if (!numericRows.length && !textRows.length && !summary) {
      return res.status(409).json({
        ok: false,
        reason: "no_usable_rows",
        message:
          "Analysis completed, but no usable extracted data was found in this run. Please retry with a clearer screenshot or another crop."
      });
    }

    const answer = await askGroundedChat({
      workspaceName,
      runId: resolvedRunId,
      analysis,
      messages,
      userQuestion
    });

    return res.json({
      ok: true,
      workspaceName,
      runId: resolvedRunId,
      answer,
      reference: {
        runId: resolvedRunId,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        generatedAt: analysis.createdAt || run.finishedAt || run.createdAt
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to answer grounded chat"
    });
  }
});

module.exports = router;
