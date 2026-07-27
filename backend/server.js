require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/static", express.static(path.join(__dirname, "data")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "powerbi-demo-backend", analyst: true });
});

app.use("/analyst", require("./analyst/routesUpload"));
app.use("/analyst", require("./analyst/routesAnalyze"));
app.use("/analyst", require("./analyst/routesReport"));
app.use("/analyst", require("./analyst/routesChat"));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: error.message || "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
