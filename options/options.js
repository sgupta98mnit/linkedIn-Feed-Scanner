// Options page script

console.log('[options] module top — imports starting');

import { getProfile, saveProfile, clearAllData, exportJobsAsCSV } from '../utils/storage.js';
import { checkOllamaOnline, ollamaGenerateFull, buildRoleExtractionPrompt } from '../utils/ollama.js';
import { checkGoogleAIOnline, googleAIGenerateFull } from '../utils/google-ai.js';
import { getAllLogs, getLogStats, clearLogs, logsToCSV, logOllamaCall } from '../utils/db.js';

console.log('[options] module loaded — all imports resolved');

function $(id) { return document.getElementById(id); }

// ── Provider UI helpers ───────────────────────────────────────────────────────

function currentProvider() {
  return document.querySelector('input[name="provider"]:checked')?.value || 'google-ai';
}

function applyProviderUI(provider) {
  const isGoogle = provider === 'google-ai';
  $('google-ai-fields').style.display = isGoogle ? '' : 'none';
  $('ollama-fields').style.display    = isGoogle ? 'none' : '';
}

// ── PDF worker helpers ────────────────────────────────────────────────────────

function makeWorker() {
  return new Worker(
    chrome.runtime.getURL('options/pdf-worker.js'),
    { type: 'module' }
  );
}

function pdfExtractText(buffer) {
  return new Promise((resolve, reject) => {
    const worker = makeWorker();
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('timeout')); }, 30000);
    worker.onmessage = (e) => {
      if (e.data.error) { clearTimeout(timer); worker.terminate(); reject(new Error(e.data.error)); return; }
      if (e.data.text !== undefined) { clearTimeout(timer); worker.terminate(); resolve(e.data.text); }
    };
    worker.onerror = (err) => { clearTimeout(timer); worker.terminate(); reject(new Error(err.message)); };
    worker.postMessage({ mode: 'extract', buffer, pdfWorkerUrl: chrome.runtime.getURL('libs/pdf.worker.min.mjs') }, [buffer]);
  });
}

function pdfRenderPages(buffer, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = makeWorker();
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('render timeout')); }, 180000);
    worker.onmessage = (e) => {
      if (e.data.error) { clearTimeout(timer); worker.terminate(); reject(new Error(e.data.error)); return; }
      if (e.data.progress) { onProgress?.(e.data.progress); return; }
      if (e.data.pages) { clearTimeout(timer); worker.terminate(); resolve(e.data.pages); }
    };
    worker.onerror = (err) => { clearTimeout(timer); worker.terminate(); reject(new Error(err.message)); };
    worker.postMessage({ mode: 'render', buffer, pdfWorkerUrl: chrome.runtime.getURL('libs/pdf.worker.min.mjs') }, [buffer]);
  });
}

// ── AI status bar ─────────────────────────────────────────────────────────────

async function updateAIStatus(provider, { googleApiKey, googleModel, ollamaBaseUrl } = {}) {
  const bar  = $('ollama-status-bar');
  const icon = $('ollama-icon');
  const text = $('ollama-status-text');

  bar.className = 'status-bar checking';
  icon.textContent = '●';
  text.textContent = 'Checking connection…';

  let online = false, error = 'Unknown error';

  console.log('[options] updateAIStatus — provider:', provider);

  try {
    if (provider === 'google-ai') {
      const model = googleModel || $('google-model').value.trim() || 'gemma-4-31b-it';
      const key   = googleApiKey ?? $('google-api-key').value.trim();
      console.log('[options] calling checkGoogleAIOnline — model:', model, 'key length:', key.length);
      ({ online, error } = await checkGoogleAIOnline(key, model));
      console.log('[options] checkGoogleAIOnline returned — online:', online, 'error:', error);
    } else {
      const baseUrl = ollamaBaseUrl || $('ollama-url').value.trim() || 'http://localhost:11434';
      console.log('[options] calling checkOllamaOnline — baseUrl:', baseUrl);
      ({ online, error } = await checkOllamaOnline(baseUrl));
      console.log('[options] checkOllamaOnline returned — online:', online, 'error:', error);
    }
  } catch (e) {
    console.error('[options] updateAIStatus threw:', e);
    online = false;
    error  = e.message || 'Unexpected error checking connection';
  }

  if (online) {
    bar.className = 'status-bar online';
    icon.textContent = '✓';
    const label = provider === 'google-ai'
      ? `Google AI Studio connected (${$('google-model').value.trim() || 'gemma-4-31b-it'})`
      : `Ollama is online at ${$('ollama-url').value.trim() || 'http://localhost:11434'}`;
    text.textContent = label;
  } else {
    bar.className = 'status-bar offline';
    icon.textContent = '✗';
    text.textContent = error || 'Connection failed';
  }

  return online;
}

// ── Load saved profile ────────────────────────────────────────────────────────

async function loadProfile() {
  const profile = await getProfile();

  const provider = profile?.provider || 'google-ai';
  const radio = document.querySelector(`input[name="provider"][value="${provider}"]`);
  if (radio) radio.checked = true;
  applyProviderUI(provider);

  // Google AI fields
  $('google-api-key').value = profile?.googleApiKey || '';
  $('google-model').value   = profile?.googleModel  || 'gemma-4-31b-it';

  // Ollama fields
  $('ollama-url').value   = profile?.ollamaBaseUrl || 'http://localhost:11434';
  $('ollama-model').value = profile?.ollamaModel   || 'gemma4:e4b';

  // Profile fields
  $('bio').value          = profile?.bio          || '';
  $('target-roles').value = profile?.targetRoles  || '';
  $('industries').value   = profile?.industries   || '';

  if (profile?.bio) {
    $('btn-detect-roles').disabled = false;
    $('pdf-label-text').textContent = profile.resumeFilename || 'Resume loaded — click to replace';
    $('pdf-label').classList.toggle('has-file', !!profile.resumeFilename);
  }
}

// ── AI generate helper (used from options page directly) ──────────────────────

async function optionsAIGenerateFull({ prompt, numCtx }) {
  const provider = currentProvider();
  if (provider === 'google-ai') {
    const key   = $('google-api-key').value.trim();
    const model = $('google-model').value.trim() || 'gemma-4-31b-it';
    return googleAIGenerateFull({ apiKey: key, model, prompt });
  }
  const baseUrl = $('ollama-url').value.trim() || 'http://localhost:11434';
  const model   = $('ollama-model').value.trim() || 'gemma4:e4b';
  return ollamaGenerateFull({ baseUrl, model, prompt, numCtx: numCtx || 8192 });
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Module scripts are deferred — DOM is already ready, no DOMContentLoaded needed.
async function init() {
  console.log('[options] init() called');
  try {
  await loadProfile();
  updateAIStatus(currentProvider()).catch(e => console.error('[LFS] status check failed:', e));

  // ── Provider toggle ────────────────────────────────────────────────────────
  document.querySelectorAll('input[name="provider"]').forEach(radio => {
    radio.addEventListener('change', () => applyProviderUI(radio.value));
  });

  // ── PDF file input ─────────────────────────────────────────────────────────
  const pdfInput    = $('pdf-input');
  const pdfStatus   = $('pdf-status');
  const pdfLabel    = $('pdf-label');
  const pdfLabelText = $('pdf-label-text');

  async function handlePDFFile(file) {
    if (!file || file.type !== 'application/pdf') {
      pdfStatus.textContent = '✗ Please select a valid PDF file.';
      pdfStatus.className = 'pdf-status fail';
      pdfStatus.classList.remove('hidden');
      return;
    }

    pdfLabel.classList.remove('has-file');
    pdfLabelText.textContent = `${file.name}`;
    pdfStatus.classList.remove('hidden');

    const setStatus = (msg, cls) => {
      pdfStatus.textContent = msg;
      pdfStatus.className = `pdf-status ${cls}`;
    };

    function finishWithText(text, filename) {
      $('bio').value = text;
      pdfLabel.classList.add('has-file');
      pdfLabelText.textContent = `✓ ${filename} (${text.length.toLocaleString()} chars)`;
      setStatus('✓ Text ready. Review below, then save.', 'ok');
      $('btn-detect-roles').disabled = false;
      pdfInput._currentFilename = filename;
    }

    let buffer;
    try {
      setStatus('Reading file…', 'loading');
      buffer = await file.arrayBuffer();
    } catch (err) {
      setStatus(`✗ Could not read file: ${err.message}`, 'fail');
      return;
    }

    // Stage 1: try embedded text extraction
    try {
      setStatus('Extracting embedded text…', 'loading');
      const text = await pdfExtractText(buffer.slice(0));
      if (text && text.trim().length >= 100) {
        finishWithText(text, file.name);
        return;
      }
    } catch (err) {
      console.warn('[PDF] Text extraction failed:', err.message);
    }

    // Stage 2: scanned PDF — render pages and use AI OCR
    setStatus('No embedded text found. Rendering pages for AI OCR…', 'loading');

    let pages;
    try {
      pages = await pdfRenderPages(buffer.slice(0), ({ page, total }) => {
        setStatus(`Rendering page ${page} of ${total}…`, 'loading');
      });
    } catch (err) {
      setStatus(`✗ Could not render PDF: ${err.message}`, 'fail');
      return;
    }

    setStatus(`Sending ${pages.length} page(s) to AI for OCR… (this may take a minute)`, 'loading');

    try {
      const provider = currentProvider();
      const pageTexts = [];

      for (let i = 0; i < pages.length; i++) {
        setStatus(`OCR page ${i + 1} of ${pages.length}…`, 'loading');
        const prompt = `This is page ${i + 1} of ${pages.length} of a resume. Extract ALL text exactly as it appears. Output only the raw text, no commentary.`;

        try {
          let pageText = '';

          if (provider === 'google-ai') {
            const { googleAIGenerateWithImage } = await import('../utils/google-ai.js');
            const key   = $('google-api-key').value.trim();
            const model = $('google-model').value.trim() || 'gemma-4-31b-it';
            pageText = await googleAIGenerateWithImage({ apiKey: key, model, prompt, imageBase64: pages[i], mimeType: 'image/png', temperature: 0 });
          } else {
            const baseUrl = $('ollama-url').value.trim() || 'http://localhost:11434';
            const model   = $('ollama-model').value.trim() || 'gemma4:e4b';
            const response = await fetch(`${baseUrl}/api/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, prompt, images: [pages[i]], stream: false, options: { temperature: 0 } }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            pageText = data.response?.trim() || '';
          }

          if (pageText) pageTexts.push(pageText);
          const model = provider === 'google-ai'
            ? ($('google-model').value.trim() || 'gemma-4-31b-it')
            : ($('ollama-model').value.trim() || 'gemma4:e4b');
          await logOllamaCall({ type: 'ocr', model, prompt, response: pageText, decision: 'generated' });
        } catch (pageErr) {
          console.warn(`[PDF OCR] Page ${i + 1} failed:`, pageErr.message);
        }
      }

      const text = pageTexts.join('\n\n');
      if (text.trim().length < 50) {
        setStatus('⚠ AI returned very little text. Try a different model or type your bio manually.', 'fail');
        return;
      }
      finishWithText(text, file.name);
    } catch (err) {
      setStatus(`✗ OCR request failed: ${err.message}`, 'fail');
    }
  }

  pdfInput.addEventListener('change', () => {
    if (pdfInput.files[0]) handlePDFFile(pdfInput.files[0]);
  });

  const uploadArea = $('pdf-upload-area');
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handlePDFFile(file);
  });

  // ── Auto-detect roles ──────────────────────────────────────────────────────
  $('btn-detect-roles').addEventListener('click', async () => {
    const bio = $('bio').value.trim();
    if (!bio) return;

    const btn = $('btn-detect-roles');
    btn.disabled = true;
    btn.textContent = 'Detecting…';

    try {
      const prompt = buildRoleExtractionPrompt(bio);
      const text = await optionsAIGenerateFull({ prompt, numCtx: 16384 });
      const model = currentProvider() === 'google-ai'
        ? ($('google-model').value.trim() || 'gemma-4-31b-it')
        : ($('ollama-model').value.trim() || 'gemma4:e4b');
      await logOllamaCall({ type: 'extract_roles', model, prompt, response: text, decision: 'generated' });

      const lines = text.trim().split('\n').filter(l => l.includes(',') || l.length > 5);
      const roles = lines[lines.length - 1]?.trim() || text.trim();
      $('target-roles').value = roles;
    } catch (err) {
      alert(`Could not detect roles: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Auto-detect from resume';
    }
  });

  $('bio').addEventListener('input', () => {
    $('btn-detect-roles').disabled = $('bio').value.trim().length < 50;
  });

  // ── Test connection ────────────────────────────────────────────────────────
  $('btn-test-connection').addEventListener('click', async () => {
    const result = $('test-result');
    $('btn-test-connection').disabled = true;
    $('btn-test-connection').textContent = 'Testing…';

    const online = await updateAIStatus(currentProvider());
    result.textContent = online ? '✓ Connected' : '✗ Unreachable';
    result.className = `test-result ${online ? 'ok' : 'fail'}`;
    result.classList.remove('hidden');

    $('btn-test-connection').disabled = false;
    $('btn-test-connection').textContent = 'Test Connection';
  });

  // ── Save profile ───────────────────────────────────────────────────────────
  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const provider  = currentProvider();
    const industries = $('industries').value.trim();

    const profile = {
      provider,
      googleApiKey:  $('google-api-key').value.trim(),
      googleModel:   $('google-model').value.trim()   || 'gemma-4-31b-it',
      ollamaBaseUrl: $('ollama-url').value.trim()     || 'http://localhost:11434',
      ollamaModel:   $('ollama-model').value.trim()   || 'gemma4:e4b',
      bio:           $('bio').value.trim(),
      targetRoles:   $('target-roles').value.trim(),
      industries:    industries || 'All',
      resumeFilename: pdfInput._currentFilename || null,
    };

    const saveStatus = $('save-status');
    try {
      await saveProfile(profile);
      saveStatus.textContent = '✓ Profile saved';
      saveStatus.className = 'save-status ok';
      saveStatus.classList.remove('hidden');
      setTimeout(() => saveStatus.classList.add('hidden'), 3000);
      updateAIStatus(provider).catch(e => console.error('[LFS] status check failed:', e));
    } catch (err) {
      saveStatus.textContent = `✗ Failed to save: ${err.message}`;
      saveStatus.className = 'save-status fail';
      saveStatus.classList.remove('hidden');
    }
  });

  // ── Export CSV ─────────────────────────────────────────────────────────────
  $('btn-export').addEventListener('click', async () => {
    const csv = await exportJobsAsCSV();
    if (!csv) { alert('No saved jobs to export.'); return; }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linkedin-jobs-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ── Clear data ─────────────────────────────────────────────────────────────
  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('This will permanently delete all saved jobs, scanned post history, and your profile.\n\nAre you sure?')) return;
    await clearAllData();
    alert('All data cleared. Please reconfigure your profile.');
    pdfLabelText.textContent = 'Choose PDF file…';
    pdfLabel.classList.remove('has-file');
    pdfStatus.classList.add('hidden');
    $('btn-detect-roles').disabled = true;
    await loadProfile();
    renderStoredData();
  });

  // ── AI logs ────────────────────────────────────────────────────────────────
  renderLogs();
  $('btn-refresh-logs').addEventListener('click', renderLogs);

  $('btn-export-logs-csv').addEventListener('click', async () => {
    const logs = await getAllLogs();
    if (!logs.length) { alert('No logs to export.'); return; }
    const blob = new Blob([logsToCSV(logs)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ai-logs-${Date.now()}.csv`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  });

  $('btn-export-logs-json').addEventListener('click', async () => {
    const logs = await getAllLogs();
    if (!logs.length) { alert('No logs to export.'); return; }
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ai-logs-${Date.now()}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  });

  $('btn-clear-logs').addEventListener('click', async () => {
    if (!confirm('Delete all AI logs? This cannot be undone.')) return;
    await clearLogs();
    renderLogs();
  });

  // ── Stored data inspector ──────────────────────────────────────────────────
  renderStoredData();
  $('btn-refresh-data').addEventListener('click', renderStoredData);

  document.querySelectorAll('.data-group-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = $(header.dataset.target);
      const toggle = header.querySelector('.data-group-toggle');
      body.classList.toggle('collapsed');
      toggle.textContent = body.classList.contains('collapsed') ? '▶' : '▼';
    });
  });

  console.log('[options] init() setup complete');

  } catch (e) {
    console.error('[options] init() CRASHED:', e);
  }
}

init();

// ── Stored data renderer ──────────────────────────────────────────────────────

async function renderStoredData() {
  const all = await chrome.storage.local.get(null);

  const profile = all.userProfile || null;
  const jobs    = all.savedJobs   || [];
  const scanned = all.scannedPosts || {};

  const totalBytes = new Blob([JSON.stringify(all)]).size;
  $('data-summary').textContent =
    `${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${Object.keys(scanned).length} posts scanned · ${formatBytes(totalBytes)} stored`;

  const profileTable = $('table-profile');
  profileTable.innerHTML = '';

  if (!profile) {
    profileTable.innerHTML = '<tr><td colspan="2" style="color:#999;font-style:italic">No profile saved yet.</td></tr>';
  } else {
    const providerLabel = profile.provider === 'google-ai' ? 'Google AI Studio' : 'Ollama (local)';
    const modelLabel    = profile.provider === 'google-ai'
      ? (profile.googleModel || 'gemma-4-31b-it')
      : (profile.ollamaModel || 'gemma4:e4b');
    const fields = [
      ['Provider',      providerLabel],
      ['Model',         modelLabel],
      ...(profile.provider === 'google-ai'
        ? [['API Key', profile.googleApiKey ? '••••••••' + profile.googleApiKey.slice(-4) : '—']]
        : [['Ollama URL', profile.ollamaBaseUrl]]),
      ['Target Roles',  profile.targetRoles],
      ['Industries',    profile.industries],
      ['Resume file',   profile.resumeFilename || '—'],
      ['Bio length',    profile.bio ? `${profile.bio.length.toLocaleString()} characters` : '—'],
      ['Bio preview',   profile.bio ? profile.bio.slice(0, 300) + (profile.bio.length > 300 ? '…' : '') : '—'],
    ];
    for (const [key, val] of fields) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escHtml(key)}</td><td>${escHtml(String(val ?? '—'))}</td>`;
      profileTable.appendChild(tr);
    }
  }

  $('jobs-count').textContent = jobs.length;
  const jobsContainer = $('jobs-cards');
  jobsContainer.innerHTML = '';

  if (jobs.length === 0) {
    jobsContainer.innerHTML = '<p style="color:#999;font-size:12px;font-style:italic">No saved jobs yet.</p>';
  } else {
    for (const job of jobs) {
      jobsContainer.appendChild(buildJobCard(job));
    }
  }

  const scannedEntries = Object.entries(scanned);
  $('scanned-count').textContent = scannedEntries.length;
  const scannedTable = $('table-scanned');
  scannedTable.innerHTML = '';

  if (scannedEntries.length === 0) {
    scannedTable.innerHTML = '<tr><td colspan="3" style="color:#999;font-style:italic">No posts scanned yet.</td></tr>';
  } else {
    const header = document.createElement('tr');
    header.innerHTML = '<td><strong>Post ID</strong></td><td><strong>Was Job</strong></td><td><strong>Scanned At</strong></td>';
    scannedTable.appendChild(header);
    for (const [id, meta] of scannedEntries.slice(0, 100)) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${escHtml(id)}</td>
        <td>${meta.wasJobPost ? '✓ yes' : 'no'}</td>
        <td>${meta.scannedAt ? new Date(meta.scannedAt).toLocaleString() : '—'}</td>
      `;
      scannedTable.appendChild(tr);
    }
    if (scannedEntries.length > 100) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="3" style="color:#999;font-size:11px">… and ${scannedEntries.length - 100} more</td>`;
      scannedTable.appendChild(tr);
    }
  }
}

function buildJobCard(job) {
  const card = document.createElement('div');
  card.className = 'insp-job-card';

  const scoreColor = job.relevanceScore >= 8 ? '#057642' : '#0a66c2';
  const date = job.timestamp ? new Date(job.timestamp).toLocaleString() : '—';

  card.innerHTML = `
    <div class="insp-job-header">
      <div class="insp-job-title">${escHtml(job.jobTitle || 'Unknown')} — ${escHtml(job.company || '—')}</div>
      <div class="insp-job-meta">
        <span style="color:${scoreColor};font-weight:700">${job.relevanceScore}/10</span>
        <span>${escHtml(job.status || 'Interested')}</span>
        <span>▼</span>
      </div>
    </div>
    <div class="insp-job-body collapsed"></div>
  `;

  const header = card.querySelector('.insp-job-header');
  const body   = card.querySelector('.insp-job-body');
  const toggle = card.querySelector('.insp-job-meta span:last-child');

  const fields = [
    ['Post ID',      job.postId],
    ['Job Title',    job.jobTitle],
    ['Company',      job.company],
    ['Poster',       job.posterName || '—'],
    ['Score',        `${job.relevanceScore}/10`],
    ['Status',       job.status],
    ['Saved at',     date],
    ['Reminder',     job.reminderDate || '—'],
    ['Post URL',     job.postUrl || '—'],
    ['Summary',      job.summary || '—'],
    ['Post snippet', job.postText ? job.postText.slice(0, 200) + '…' : '—'],
  ];

  const table = document.createElement('table');
  table.className = 'data-table';
  for (const [key, val] of fields) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escHtml(key)}</td><td>${escHtml(String(val ?? '—'))}</td>`;
    table.appendChild(tr);
  }
  body.appendChild(table);

  header.addEventListener('click', () => {
    body.classList.toggle('collapsed');
    toggle.textContent = body.classList.contains('collapsed') ? '▼' : '▲';
  });

  return card;
}

// ── AI log renderer ───────────────────────────────────────────────────────────

async function renderLogs() {
  const [logs, stats] = await Promise.all([getAllLogs(), getLogStats()]);

  $('log-stats').innerHTML = [
    { label: 'Total calls', value: stats.total,    cls: '' },
    { label: 'Saved',       value: stats.saved,    cls: 'green' },
    { label: 'Rejected',    value: stats.rejected, cls: '' },
    { label: 'Errors',      value: stats.errors,   cls: stats.errors > 0 ? 'red' : '' },
  ].map(s => `
    <div class="log-stat ${s.cls}">
      <span class="log-stat-value">${s.value}</span>
      <span class="log-stat-label">${s.label}</span>
    </div>
  `).join('');

  const tbody = $('log-tbody');
  const empty = $('log-empty');
  tbody.innerHTML = '';

  if (!logs.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const log of [...logs].reverse()) {
    const tr = document.createElement('tr');
    const time = new Date(log.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const decisionCls = `decision-${log.decision}`;
    const promptPreview = (log.prompt || '').replace(/\n/g, ' ').slice(0, 80);
    const urlCell = log.postUrl
      ? `<a class="log-url-link" href="${escHtml(log.postUrl)}" target="_blank" title="${escHtml(log.postUrl)}">Open ↗</a>`
      : '—';
    tr.innerHTML = `
      <td title="${new Date(log.ts).toISOString()}">${escHtml(time)}</td>
      <td>${escHtml(log.type.replace('_', ' '))}</td>
      <td>${escHtml(log.model)}</td>
      <td><span class="decision-badge ${decisionCls}">${escHtml(log.decision)}</span></td>
      <td style="text-align:center">${log.score != null ? `<strong>${log.score}</strong>/10` : '—'}</td>
      <td class="wrap" title="${escHtml(log.jobTitle || '')}">${escHtml(log.jobTitle || '—')}</td>
      <td class="wrap" title="${escHtml(log.company || '')}">${escHtml(log.company || '—')}</td>
      <td>${urlCell}</td>
      <td><span class="log-prompt-preview" title="${escHtml(log.prompt || '')}">${escHtml(promptPreview)}${log.prompt?.length > 80 ? '…' : ''}</span></td>
      <td style="color:var(--muted)">${log.promptLen} / ${log.responseLen}</td>
      <td><button class="log-detail-btn" data-id="${log.id}">View</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.log-detail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const log = logs.find(l => l.id === Number(btn.dataset.id));
      if (log) showLogModal(log);
    });
  });
}

function showLogModal(log) {
  const existing = document.querySelector('.log-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'log-modal-overlay';
  overlay.innerHTML = `
    <div class="log-modal">
      <div class="log-modal-header">
        <h3>${escHtml(log.type)} — ${new Date(log.ts).toLocaleString()}</h3>
        <button class="log-modal-close">✕</button>
      </div>
      <div>
        <div class="log-modal-label">Meta</div>
        <table class="data-table">
          <tr><td>Model</td><td>${escHtml(log.model)}</td></tr>
          <tr><td>Decision</td><td><span class="decision-badge decision-${log.decision}">${log.decision}</span></td></tr>
          <tr><td>Score</td><td>${log.score != null ? log.score + '/10' : '—'}</td></tr>
          <tr><td>Job</td><td>${escHtml(log.jobTitle || '—')}</td></tr>
          <tr><td>Company</td><td>${escHtml(log.company || '—')}</td></tr>
          <tr><td>Post URL</td><td>${log.postUrl ? `<a href="${escHtml(log.postUrl)}" target="_blank" style="color:var(--blue)">${escHtml(log.postUrl)}</a>` : '—'}</td></tr>
          <tr><td>Post ID</td><td style="font-family:monospace;font-size:11px">${escHtml(log.postId || '—')}</td></tr>
          ${log.errorMsg ? `<tr><td>Error</td><td style="color:var(--red)">${escHtml(log.errorMsg)}</td></tr>` : ''}
        </table>
      </div>
      <div>
        <div class="log-modal-label">Prompt (${log.promptLen} chars)</div>
        <pre>${escHtml(log.prompt)}</pre>
      </div>
      <div>
        <div class="log-modal-label">Response (${log.responseLen} chars)</div>
        <pre>${escHtml(log.response || '(empty)')}</pre>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.log-modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
