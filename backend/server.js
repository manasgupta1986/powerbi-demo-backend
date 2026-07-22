import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const reportsDir = path.join(__dirname, 'reports');
const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/reports', express.static(reportsDir));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(dataDir);
ensureDir(reportsDir);

function loadLocalConfig() {
  const configPath = path.join(__dirname, 'config.local.json');
  let fileConfig = { openaiApiKey: '', appsScriptUrl: '' };

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      fileConfig = { openaiApiKey: '', appsScriptUrl: '' };
    }
  }

  return {
    openaiApiKey: process.env.OPENAI_API_KEY || fileConfig.openaiApiKey || '',
    appsScriptUrl: process.env.APPS_SCRIPT_URL || fileConfig.appsScriptUrl || ''
  };
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fallbackSummary(run) {
  const pageNames = [...new Set((run.captures || []).map(x => x.pageName).filter(Boolean))];
  const snippets = (run.captures || []).slice(0, 5).map(c => {
    const text = (c.extractedText || '').replace(/\s+/g, ' ').trim().slice(0, 350);
    return `Page: ${c.pageName || 'Unknown'}\n${text}`;
  }).join('\n\n');

  return `
Executive summary\n- Demo fallback mode is active because no AI key is configured.\n- ${pageNames.length} page(s) were captured from the dashboard.\n- Focus of this run: last 4 weeks, client-facing commercial readout.\n\nWhat was captured\n- Pages: ${pageNames.join(', ') || 'None detected'}\n- Captures collected: ${(run.captures || []).length}\n\nCommercial note\n- For Monday's demo, use this report to show the workflow end-to-end.\n- Add an AI key in backend/config.local.json to generate richer insights and action-oriented recommendations.\n\nCaptured snippets\n${snippets}
`.trim();
}

async function callOpenAI(prompt) {
  const config = loadLocalConfig();
  if (!config.openaiApiKey) return null;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: prompt
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error: ${text}`);
  }

  const data = await response.json();
  return data.output_text || '';
}

async function generateInsightSummary(run) {
  const compactCaptures = (run.captures || []).map((c, i) => ({
    index: i + 1,
    pageName: c.pageName,
    extractedText: (c.extractedText || '').slice(0, 6000)
  }));

  const prompt = `You are helping create a persuasive Monday demo for a dashboard-insight assistant.\n\nClient: ${run.clientName}\nDashboard URL: ${run.dashboardUrl}\nCaptured at: ${run.createdAt}\nIntended audience: Insights managers, category managers, brand managers\nTask: Produce a concise but insightful commercial report using ONLY the captured dashboard text.\n\nRequirements:\n1. Start with 'Executive Summary'\n2. Then sections: 'What changed in the last 4 weeks', 'Implications by manager type', 'Recommended actions', 'Questions to investigate next'\n3. Be explicit when evidence is weak or partial\n4. Use bullet points and short paragraphs\n5. Do not invent numerical data if missing\n6. Make the output sound client-ready and actionable\n\nCaptured dashboard text:\n${JSON.stringify(compactCaptures, null, 2)}`;

  try {
    const ai = await callOpenAI(prompt);
    if (ai && ai.trim()) return ai.trim();
  } catch (err) {
    console.error(err.message);
  }

  return fallbackSummary(run);
}

function buildHtmlReport(run, summary) {
  const captureBlocks = (run.captures || []).map(c => `
    <div class="card">
      <h3>${escapeHtml(c.pageName || 'Unknown Page')}</h3>
      <pre>${escapeHtml((c.extractedText || '').slice(0, 8000))}</pre>
    </div>
  `).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(run.clientName)} Dashboard Demo Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f7f8fc; color: #1f2937; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px; }
    .hero { background: linear-gradient(135deg, #111827, #2563eb); color: white; padding: 24px; border-radius: 18px; }
    .hero h1 { margin: 0 0 8px 0; font-size: 30px; }
    .hero p { margin: 6px 0; opacity: 0.95; }
    .card { background: white; border-radius: 16px; padding: 18px; margin-top: 18px; box-shadow: 0 6px 18px rgba(0,0,0,0.07); }
    .summary { white-space: pre-wrap; line-height: 1.5; font-size: 15px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f3f4f6; padding: 14px; border-radius: 12px; }
    .muted { color: #6b7280; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>${escapeHtml(run.clientName)} Dashboard Demo Report</h1>
      <p>Dashboard: ${escapeHtml(run.dashboardUrl)}</p>
      <p>Run time: ${escapeHtml(run.createdAt)}</p>
      <p class="muted">This is the Monday-demo report generated from the extension capture.</p>
    </div>

    <div class="card">
      <h2>Insight summary</h2>
      <div class="summary">${escapeHtml(summary)}</div>
    </div>

    <div class="card">
      <h2>Raw captured views</h2>
      <p class="muted">Useful for demo transparency: show that the system stores each page capture before answering questions.</p>
    </div>

    ${captureBlocks}
  </div>
</body>
</html>`;
}

async function logToAppsScript(payload) {
  const config = loadLocalConfig();
  if (!config.appsScriptUrl) return;
  try {
    await fetch(config.appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Apps Script log failed:', err.message);
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Backend is running' });
});

app.post('/run-analysis', async (req, res) => {
  const body = req.body || {};
  const run = {
    clientName: body.clientName || 'Client Demo',
    dashboardUrl: body.dashboardUrl || '',
    createdAt: new Date().toISOString(),
    captures: Array.isArray(body.captures) ? body.captures : [],
    meta: body.meta || {}
  };

  const summary = await generateInsightSummary(run);
  const runBundle = { ...run, summary };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJson(path.join(dataDir, `run-${stamp}.json`), runBundle);
  writeJson(path.join(dataDir, 'latest-run.json'), runBundle);

  const html = buildHtmlReport(runBundle, summary);
  fs.writeFileSync(path.join(reportsDir, 'latest-report.html'), html, 'utf8');

  await logToAppsScript({
    type: 'analysis_run',
    timestamp: run.createdAt,
    clientName: run.clientName,
    dashboardUrl: run.dashboardUrl,
    captureCount: run.captures.length
  });

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.json({
    ok: true,
    summary,
    reportUrl: `${baseUrl}/reports/latest-report.html`
  });
});

app.get('/latest-report', (req, res) => {
  res.redirect('/reports/latest-report.html');
});

app.get('/latest-data', (req, res) => {
  const latest = readJson(path.join(dataDir, 'latest-run.json'), {});
  res.json(latest || {});
});

app.post('/ask', async (req, res) => {
  const { question = '' } = req.body || {};
  const latest = readJson(path.join(dataDir, 'latest-run.json'), null);
  if (!latest) {
    return res.status(400).json({ ok: false, answer: 'No analysis run found yet. Run the dashboard capture first.' });
  }

  let answer = '';
  try {
    answer = await callOpenAI(`You are answering a client question about a saved dashboard run.\n\nQuestion: ${question}\n\nUse ONLY this stored data and be explicit if the evidence is partial. Give a concise but commercial answer.\n\nStored run JSON:\n${JSON.stringify(latest, null, 2).slice(0, 18000)}`);
  } catch (err) {
    console.error(err.message);
  }

  if (!answer || !answer.trim()) {
    answer = `Fallback answer: I found a saved run for ${latest.clientName} with ${(latest.captures || []).length} captured views. Your question was: "${question}". Add an AI key in backend/config.local.json for richer answers.`;
  }

  await logToAppsScript({
    type: 'client_query',
    timestamp: new Date().toISOString(),
    clientName: latest.clientName,
    question,
    answer: answer.slice(0, 5000)
  });

  res.json({ ok: true, answer });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
