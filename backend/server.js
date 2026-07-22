import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseStorageDir = process.env.DATA_DIR || __dirname;
const dataDir = path.join(baseStorageDir, 'data');
const reportsDir = path.join(baseStorageDir, 'reports');
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
  const filterNames = [...new Set((run.captures || []).map(x => x.filterName).filter(Boolean))];
  const filterValues = [...new Set((run.captures || []).map(x => `${x.filterName || 'Unknown'}=${x.filterValue || 'Unknown'}`))];
  const snippets = (run.captures || []).slice(0, 6).map(c => {
    const text = (c.extractedText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return `State: ${c.filterName || 'Unknown'} = ${c.filterValue || 'Unknown'} | Tab: ${c.pageName || 'Unknown'}\n${text}`;
  }).join('\n\n');

  return `
Executive summary
- A saved sweep exists for ${run.clientName || 'the client'} and can be reused without rerunning the dashboard.
- ${pageNames.length} tab(s) and ${filterNames.length} filter family/families were captured.
- Total saved states: ${(run.captures || []).length}.

What this run contains
- Tabs covered: ${pageNames.join(', ') || 'None detected'}
- Filters covered: ${filterNames.join(', ') || 'None detected'}
- Example saved cohort states: ${filterValues.slice(0, 8).join('; ')}

How to use this in the demo
- Open the saved report first and present it as the morning refresh.
- Use Q&A on top of the saved run instead of rerunning the sweep live.
- If the narrative still feels shallow, improve the capture layer rather than rerunning the same text-only sweep.

Sample captured snippets
${snippets}
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

  const prompt = `You are creating a saved-run insight brief for a Power BI cohort sweep demo.

Client: ${run.clientName}
Dashboard URL: ${run.dashboardUrl}
Captured at: ${run.createdAt}
Audience: Amazon category lead, insights lead, brand lead
Goal: Produce an in-depth but honest summary using ONLY the saved run data. The sweep is one-filter-at-a-time, so compare options within each filter and identify the most commercially interesting cohorts.

Requirements:
1. Start with 'Executive Summary'
2. Then sections titled exactly:
   - 'Key cohort signals'
   - 'What an Amazon category lead should look at next'
   - 'What an Amazon insights lead should validate next'
   - 'Confidence and caveats'
3. Prioritize differences across filter options such as Zone, Age Band, Gender, NCCS, Tier.
4. Call out which cohort appears most notable and why.
5. If evidence is weak, say it is directional, partial, or inconclusive.
6. Do not invent precise numbers if they are not in the run.
7. The run should be reusable later; do not talk about rerunning live unless necessary.
8. Use concise bullets and short paragraphs.

Saved run data:
${JSON.stringify({ meta: run.meta || {}, captures: compactCaptures }, null, 2)}`;

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
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  if (!latest || Object.keys(latest).length === 0) {
    return res.json({});
  }
  res.json({
    ...latest,
    reportUrl: `${baseUrl}/reports/latest-report.html`
  });
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
  console.log(`Backend running on port ${PORT}`);
  console.log(`Storage base directory: ${baseStorageDir}`);
});
