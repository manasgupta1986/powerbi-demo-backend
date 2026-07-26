const els = {
  clientName: document.getElementById("clientName"),
  backendUrl: document.getElementById("backendUrl"),
  dashboardUrl: document.getElementById("dashboardUrl"),
  startRunBtn: document.getElementById("startRunBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  finishRunBtn: document.getElementById("finishRunBtn"),
  resetBtn: document.getElementById("resetBtn"),
  runIdText: document.getElementById("runIdText"),
  progressText: document.getElementById("progressText"),
  currentStepText: document.getElementById("currentStepText"),
  nextStepText: document.getElementById("nextStepText"),
  runStatusText: document.getElementById("runStatusText"),
  captureBtn: document.getElementById("captureBtn"),
  skipBtn: document.getElementById("skipBtn"),
  progressCard: document.getElementById("progressCard"),
  screenshotStatus: document.getElementById("screenshotStatus"),
  uploadStatus: document.getElementById("uploadStatus"),
  extractionStatus: document.getElementById("extractionStatus"),
  screenshotBar: document.getElementById("screenshotBar"),
  uploadBar: document.getElementById("uploadBar"),
  extractionBar: document.getElementById("extractionBar"),
  progressMessage: document.getElementById("progressMessage"),
  postCaptureCard: document.getElementById("postCaptureCard"),
  uploadStatusLine: document.getElementById("uploadStatusLine"),
  extractionStatusLine: document.getElementById("extractionStatusLine"),
  summaryAvailabilityLine: document.getElementById("summaryAvailabilityLine"),
  postNextStepLine: document.getElementById("postNextStepLine"),
  viewReportBtn: document.getElementById("viewReportBtn"),
  viewLatestBtn: document.getElementById("viewLatestBtn"),
  resultMessage: document.getElementById("resultMessage"),
  chatQuestion: document.getElementById("chatQuestion"),
  askBtn: document.getElementById("askBtn"),
  chatMeta: document.getElementById("chatMeta"),
  chatAnswer: document.getElementById("chatAnswer")
};

let latestUiState = null;
let pollingToken = null;

init();

async function init() {
  bindEvents();
  await refreshUi();
}

function bindEvents() {
  els.startRunBtn.addEventListener("click", onStartRun);
  els.refreshBtn.addEventListener("click", refreshUi);
  els.finishRunBtn.addEventListener("click", onFinishRun);
  els.resetBtn.addEventListener("click", onReset);
  els.captureBtn.addEventListener("click", onCapture);
  els.skipBtn.addEventListener("click", onSkip);
  els.askBtn.addEventListener("click", onAsk);
}

async function refreshUi() {
  const ui = await sendMessage({ type: "GET_UI_STATE" });
  latestUiState = ui;
  hydrateConfig(ui?.session || {});
  renderUi(ui);
}

async function onStartRun() {
  clearChat();
  clearProgress();
  clearPostCapture();

  const ui = await sendMessage({
    type: "START_GUIDED_RUN",
    clientName: els.clientName.value.trim(),
    backendUrl: els.backendUrl.value.trim(),
    dashboardUrl: els.dashboardUrl.value.trim()
  });

  latestUiState = ui;
  renderUi(ui);
}

async function onFinishRun() {
  const ui = await sendMessage({ type: "FINISH_RUN" });
  latestUiState = ui;
  renderUi(ui);
}

async function onReset() {
  stopPolling();
  const ui = await sendMessage({ type: "RESET_LOCAL_SESSION" });
  latestUiState = ui;
  renderUi(ui);
  clearProgress();
  clearPostCapture();
  clearChat();
}

async function onSkip() {
  const ui = await sendMessage({ type: "SKIP_CURRENT_STEP" });
  latestUiState = ui;
  renderUi(ui);
}

async function onCapture() {
  try {
    clearChat();
    startProgressState();

    const ui = await sendMessage({ type: "CAPTURE_CURRENT_STEP" });
    latestUiState = ui;
    renderUi(ui);

    const lastCapture = ui?.lastCapture;
    if (lastCapture?.statusUrl && ui?.session?.backendUrl) {
      await pollStateStatus(ui.session.backendUrl, lastCapture.statusUrl, lastCapture);
    }
  } catch (error) {
    setProgressMessage(`Capture failed: ${error.message || "Unknown error"}`);
    els.screenshotStatus.textContent = "Error";
    els.uploadStatus.textContent = "Error";
    els.extractionStatus.textContent = "Error";
  }
}

async function onAsk() {
  try {
    const session = latestUiState?.session || {};
    const question = els.chatQuestion.value.trim();

    if (!session.runId) {
      els.chatMeta.textContent = "No active run yet.";
      els.chatAnswer.textContent = "";
      return;
    }
    if (!session.backendUrl) {
      els.chatMeta.textContent = "Backend URL is missing.";
      els.chatAnswer.textContent = "";
      return;
    }
    if (!question) {
      els.chatMeta.textContent = "Enter a question first.";
      els.chatAnswer.textContent = "";
      return;
    }

    els.chatMeta.textContent = "Getting answer...";
    els.chatAnswer.textContent = "";

    const res = await fetch(joinUrl(session.backendUrl, "/ask"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: session.runId, question })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Ask request failed");

    const meta = [];
    if (data.mode) meta.push(`mode: ${data.mode}`);
    if (data.reason) meta.push(`reason: ${data.reason}`);
    if (data.warning) meta.push(`warning: ${data.warning}`);
    els.chatMeta.textContent = meta.length ? meta.join(" | ") : "Answer ready";
    els.chatAnswer.textContent = data.answer || "No answer returned.";
  } catch (error) {
    els.chatMeta.textContent = `Ask failed: ${error.message || "Unknown error"}`;
    els.chatAnswer.textContent = "";
  }
}

function hydrateConfig(session) {
  els.clientName.value = session.clientName || "";
  els.backendUrl.value = session.backendUrl || "";
  els.dashboardUrl.value = session.dashboardUrl || "";
}

function renderUi(ui) {
  const session = ui?.session || {};
  const currentStep = ui?.currentStep || null;
  const nextStep = ui?.nextStep || null;

  els.runIdText.textContent = session.runId || "--";
  els.progressText.textContent = `${ui?.completedSteps || 0} / ${ui?.totalSteps || 0}`;
  els.currentStepText.textContent = currentStep ? formatStep(currentStep) : "--";
  els.nextStepText.textContent = nextStep ? formatStep(nextStep) : "Run complete";
  els.runStatusText.textContent = session.status || "idle";

  if (ui?.lastCapture) showPostCapture(session, ui.lastCapture, nextStep);
  else clearPostCapture();

  const locked = session.status === "completed";
  els.captureBtn.disabled = locked;
  els.skipBtn.disabled = locked;
}

function showPostCapture(session, lastCapture, nextStep) {
  els.postCaptureCard.classList.remove("hidden");
  els.uploadStatusLine.textContent = "Completed";
  els.extractionStatusLine.textContent = capitalize(lastCapture.status || "queued");
  els.summaryAvailabilityLine.textContent = lastCapture.summaryAvailable ? "Available" : "Pending";
  els.postNextStepLine.textContent = nextStep ? formatStep(nextStep) : "Run complete";
  els.resultMessage.textContent = lastCapture.message || "Capture uploaded successfully.";

  if (lastCapture.reportUrl && session.backendUrl) {
    els.viewReportBtn.href = joinUrl(session.backendUrl, lastCapture.reportUrl);
    els.viewReportBtn.classList.remove("hidden");
  } else {
    els.viewReportBtn.classList.add("hidden");
  }

  if (lastCapture.latestDataUrl && session.backendUrl) {
    els.viewLatestBtn.href = joinUrl(session.backendUrl, lastCapture.latestDataUrl);
    els.viewLatestBtn.classList.remove("hidden");
  } else {
    els.viewLatestBtn.classList.add("hidden");
  }
}

function startProgressState() {
  stopPolling();
  els.progressCard.classList.remove("hidden");
  els.screenshotStatus.textContent = "In progress";
  els.uploadStatus.textContent = "Waiting";
  els.extractionStatus.textContent = "Waiting";
  setBar(els.screenshotBar, 35);
  setBar(els.uploadBar, 0);
  setBar(els.extractionBar, 0);
  setProgressMessage("Capturing screenshot...");
}

function clearProgress() {
  els.progressCard.classList.add("hidden");
  setBar(els.screenshotBar, 0);
  setBar(els.uploadBar, 0);
  setBar(els.extractionBar, 0);
}

function clearPostCapture() {
  els.postCaptureCard.classList.add("hidden");
  els.viewReportBtn.classList.add("hidden");
  els.viewLatestBtn.classList.add("hidden");
}

async function pollStateStatus(backendUrl, statusUrl, lastCapture) {
  stopPolling();
  const token = `${backendUrl}|${statusUrl}|${Date.now()}`;
  pollingToken = token;

  els.screenshotStatus.textContent = "Completed";
  setBar(els.screenshotBar, 100);
  els.uploadStatus.textContent = "Completed";
  setBar(els.uploadBar, 100);
  els.extractionStatus.textContent = "Queued";
  setBar(els.extractionBar, 10);
  setProgressMessage("Upload complete. Waiting for extraction...");

  for (let i = 0; i < 120; i++) {
    if (pollingToken !== token) return;
    try {
      const res = await fetch(joinUrl(backendUrl, statusUrl));
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Polling failed");

      const status = data.status || "unknown";
      els.extractionStatus.textContent = capitalize(status);

      if (status === "queued") {
        setBar(els.extractionBar, 20);
        setProgressMessage("Extraction queued...");
      } else if (status === "running") {
        setBar(els.extractionBar, 65);
        setProgressMessage("AI extraction running...");
      } else if (status === "completed") {
        setBar(els.extractionBar, 100);
        setProgressMessage(`Extraction complete. Numeric rows: ${data.numericRowCount || 0}`);
        latestUiState.lastCapture = {
          ...lastCapture,
          status,
          summaryAvailable: Boolean(data.summaryAvailable),
          numericRowCount: data.numericRowCount || 0,
          summary: data.summary || "",
          message: data.numericRowCount > 0
            ? `Extraction complete. Numeric rows found: ${data.numericRowCount}.`
            : "Extraction complete. No numeric rows found; summary fallback may still be available."
        };
        renderUi(latestUiState);
        stopPolling();
        return;
      } else if (status === "failed") {
        setBar(els.extractionBar, 100);
        setProgressMessage(`Extraction failed: ${data.error || "Unknown error"}`);
        latestUiState.lastCapture = {
          ...lastCapture,
          status,
          summaryAvailable: false,
          message: `Extraction failed: ${data.error || "Unknown error"}`
        };
        renderUi(latestUiState);
        stopPolling();
        return;
      }
    } catch (error) {
      setProgressMessage(`Status polling error: ${error.message || "Unknown error"}`);
    }
    await sleep(2000);
  }

  setProgressMessage("Extraction is taking longer than expected. You can still open the report or latest data links.");
}

function clearChat() {
  els.chatMeta.textContent = "No answer yet.";
  els.chatAnswer.textContent = "";
}

function setProgressMessage(text) { els.progressMessage.textContent = text; }
function setBar(el, percent) { el.style.width = `${Math.max(0, Math.min(100, percent))}%`; }
function stopPolling() { pollingToken = null; }
function formatStep(step) { return `${step.pageName} > ${step.filterName} > ${step.filterValue}`; }
function capitalize(v) { const s = String(v || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function joinUrl(base, p) { if (!p) return base; if (/^https?:\/\//i.test(p)) return p; return `${String(base).replace(/\/+$/, "")}/${String(p).replace(/^\/+/, "")}`; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (response?.ok === false && response?.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}
