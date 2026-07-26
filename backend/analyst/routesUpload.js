const express = require("express");
const router = express.Router();

router.post("/upload/start", async (req, res) => {
  try {
    const runId = `run_${Date.now()}`;
    return res.json({
      ok: true,
      runId,
      status: "started"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to start upload"
    });
  }
});

router.post("/upload/file", async (req, res) => {
  try {
    return res.json({
      ok: true,
      status: "file_received"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to save file"
    });
  }
});

router.post("/upload/finish", async (req, res) => {
  try {
    return res.json({
      ok: true,
      status: "finished"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to finish upload"
    });
  }
});

router.get("/upload/latest", async (req, res) => {
  try {
    return res.json({
      ok: true,
      message: "Latest upload route is working"
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to get latest upload"
    });
  }
});

module.exports = router;
