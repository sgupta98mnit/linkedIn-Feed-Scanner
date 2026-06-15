// Popup script — ES module

let allJobs = [];
let currentFilter = 'all';
let currentJobId = null;
let autoScanRunning = false;
let activityScanRunning = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

function $(id) { return document.getElementById(id); }

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function scoreClass(score) {
  if (score >= 8) return 'high';
  if (score >= 6) return 'mid';
  return '';
}

// ── Ollama status ────────────────────────────────────────────────────────────

async function refreshOllamaStatus() {
  const dot = $('ollama-status');
  dot.className = 'status-dot checking';
  dot.title = 'Checking AI provider…';
  try {
    const res = await send('CHECK_OLLAMA');
    if (res?.online) {
      dot.className = 'status-dot online';
      dot.title = 'AI provider is online';
    } else {
      dot.className = 'status-dot offline';
      dot.title = res?.error || 'AI provider is offline';
    }
  } catch {
    dot.className = 'status-dot offline';
    dot.title = 'Cannot reach AI provider';
  }
}

// ── Job list rendering ───────────────────────────────────────────────────────

function renderJobList() {
  const list = $('job-list');
  const empty = $('empty-state');

  const filtered = currentFilter === 'all'
    ? allJobs
    : allJobs.filter(j => j.status === currentFilter);

  if (filtered.length === 0) {
    empty.style.display = 'block';
    // Remove existing cards
    list.querySelectorAll('.job-card').forEach(c => c.remove());
    return;
  }
  empty.style.display = 'none';

  // Diff update: remove old cards, rebuild
  list.querySelectorAll('.job-card').forEach(c => c.remove());

  for (const job of filtered) {
    const card = createJobCard(job);
    list.appendChild(card);
  }
}

function createJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.postId = job.postId;

  const status = job.status || 'Interested';
  const scoreVal = job.relevanceScore || 0;

  card.innerHTML = `
    <div class="job-card-row">
      <div class="job-card-info">
        <div class="job-card-title" title="${escHtml(job.jobTitle)}">${escHtml(job.jobTitle)}</div>
        <div class="job-card-company">${escHtml(job.company)}</div>
      </div>
      <div class="score-badge ${scoreClass(scoreVal)}">${scoreVal}/10</div>
    </div>
    <div class="job-card-meta">
      <span class="status-pill ${status}">${status}</span>
      <span class="job-card-date">${formatDate(job.timestamp)}</span>
    </div>
  `;

  card.addEventListener('click', () => openDetail(job.postId));
  return card;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function openDetail(postId) {
  const job = allJobs.find(j => j.postId === postId);
  if (!job) return;
  currentJobId = postId;

  $('detail-title').textContent = job.jobTitle || 'Unknown Title';
  $('detail-company').textContent = job.company || '';
  $('detail-score').textContent = `${job.relevanceScore}/10`;
  $('detail-score').className = `score-badge ${scoreClass(job.relevanceScore)}`;

  const meta = [];
  if (job.posterName) meta.push(`Posted by ${job.posterName}`);
  if (job.sourceType === 'profile_activity') {
    const sourceName = job.sourceProfileName || job.sourceProfileSlug || 'profile activity';
    const action = job.engagementType === 'commented' ? 'commented on' : 'reacted to';
    meta.push(`${sourceName} ${action} this`);
  }
  if (job.timestamp) meta.push(formatDate(job.timestamp));
  $('detail-meta').textContent = meta.join(' · ');

  $('detail-summary').textContent = job.summary || 'No summary available.';

  // Status buttons
  const status = job.status || 'Interested';
  document.querySelectorAll('.status-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === status);
  });

  // Reminder
  if (job.reminderDate) {
    $('reminder-date').value = job.reminderDate;
  } else {
    $('reminder-date').value = '';
  }

  // Link
  const link = $('detail-link');
  if (job.postUrl) {
    link.href = job.postUrl;
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }

  // Reset compose
  $('compose-output').classList.add('hidden');
  $('compose-spinner').classList.add('hidden');
  $('compose-error').classList.add('hidden');

  $('detail-panel').classList.remove('hidden');
}

function closeDetail() {
  $('detail-panel').classList.add('hidden');
  currentJobId = null;
}

// ── Generate messages ────────────────────────────────────────────────────────

async function generate(type) {
  if (!currentJobId) return;

  const tone = $('tone-select').value;
  const spinner = $('compose-spinner');
  const output = $('compose-output');
  const errorEl = $('compose-error');
  const labelEl = $('compose-label');
  const textarea = $('compose-textarea');

  spinner.classList.remove('hidden');
  output.classList.add('hidden');
  errorEl.classList.add('hidden');

  // Disable buttons
  document.querySelectorAll('.compose-btn').forEach(b => b.disabled = true);

  try {
    let msgType, label;
    if (type === 'comment') {
      msgType = 'GENERATE_COMMENT';
      label = 'LinkedIn Comment';
    } else if (type === 'email') {
      msgType = 'GENERATE_EMAIL';
      label = 'Cold Outreach Email';
    } else {
      msgType = 'GENERATE_CONNECTION_REQUEST';
      label = 'Connection Request';
    }

    const res = await send(msgType, { postId: currentJobId, tone });
    spinner.classList.add('hidden');

    if (res?.error) {
      errorEl.textContent = res.error;
      errorEl.classList.remove('hidden');
      return;
    }

    labelEl.textContent = label;
    textarea.value = res.text || '';
    output.classList.remove('hidden');
  } catch (err) {
    spinner.classList.add('hidden');
    errorEl.textContent = err.message || 'Generation failed';
    errorEl.classList.remove('hidden');
  } finally {
    document.querySelectorAll('.compose-btn').forEach(b => b.disabled = false);
  }
}

// ── Load data ────────────────────────────────────────────────────────────────

async function loadJobs() {
  try {
    const res = await send('GET_SAVED_JOBS');
    allJobs = res?.jobs || [];
    renderJobList();
  } catch (err) {
    console.error('Failed to load jobs:', err);
  }
}

// ── Event listeners ──────────────────────────────────────────────────────────

// ── Auto-scan helpers ────────────────────────────────────────────────────────

async function getLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' });
  if (!tabs.length) {
    const tabs2 = await chrome.tabs.query({ url: 'https://www.linkedin.com/' });
    return tabs2[0] || null;
  }
  return tabs[0];
}

async function getLinkedInProfileTab() {
  const activityTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/in/*/recent-activity/*' });
  if (activityTabs.length) return activityTabs[0];
  const profileTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/in/*' });
  return profileTabs[0] || null;
}

function setAutoScanUI(running, label) {
  autoScanRunning = running;
  const btn  = $('btn-autoscan');
  const dot  = $('autoscan-indicator');
  const lbl  = $('autoscan-label');

  if (running) {
    btn.textContent = '■ Stop';
    btn.className = 'autoscan-btn stop';
    dot.className = 'autoscan-dot running';
  } else {
    btn.textContent = '▶ Start Auto-Scan';
    btn.className = 'autoscan-btn start';
    dot.className = `autoscan-dot ${label === 'done' ? 'done' : 'idle'}`;
  }
  lbl.textContent = running ? 'Scanning feed…' :
    label === 'done'         ? 'Scan complete' :
    label === 'not_on_feed'  ? 'Open LinkedIn feed first' :
                               'Auto-scan idle';
}

function setActivityScanUI(running, label) {
  activityScanRunning = running;
  const btn = $('btn-activityscan');
  const dot = $('activityscan-indicator');
  const lbl = $('activityscan-label');

  if (running) {
    btn.textContent = 'Stop';
    btn.className = 'autoscan-btn stop';
    dot.className = 'autoscan-dot running';
  } else {
    btn.textContent = 'Scan Activity';
    btn.className = 'autoscan-btn start';
    dot.className = `autoscan-dot ${label === 'done' ? 'done' : 'idle'}`;
  }

  lbl.textContent = running ? 'Scanning activity...' :
    label === 'done'           ? 'Activity scan complete' :
    label === 'not_on_profile' ? 'Open a LinkedIn profile first' :
    label === 'navigating'     ? 'Opening activity page...' :
                                 'Activity scan idle';
}

// Listen for status updates from the content script (relayed via service worker)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'AUTOSCAN_STATUS') {
    setAutoScanUI(msg.payload.active, msg.payload.reason);
    if (!msg.payload.active) loadJobs(); // refresh list when scan ends
  }
  if (msg.type === 'ACTIVITYSCAN_STATUS') {
    setActivityScanUI(msg.payload.active, msg.payload.reason);
    if (!msg.payload.active) loadJobs();
  }
});

// popup.js is loaded as type="module" — DOMContentLoaded already fired, call init directly.
async function init() {
  await loadJobs();
  refreshOllamaStatus();

  // Restore auto-scan button state — the popup is recreated each time it opens,
  // so we ask the content script whether a scan is still running.
  try {
    const tab = await getLinkedInTab();
    if (tab) {
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTOSCAN_STATE' }).catch(() => null);
      if (state?.active) setAutoScanUI(true);
    }
  } catch { /* tab not reachable */ }

  try {
    const tab = await getLinkedInProfileTab();
    if (tab) {
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ACTIVITYSCAN_STATE' }).catch(() => null);
      if (state?.active) setActivityScanUI(true);
    }
  } catch { /* tab not reachable */ }

  // Auto-scan button
  $('btn-autoscan').addEventListener('click', async () => {
    const tab = await getLinkedInTab();

    if (!tab) {
      setAutoScanUI(false, 'not_on_feed');
      return;
    }

    if (!autoScanRunning) {
      setAutoScanUI(true);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOSCAN' });
      } catch {
        // Content script not yet injected (tab was open before extension loaded) — inject it now
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/feed-scanner.js'] });
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/feed-scanner.css'] });
          await new Promise(r => setTimeout(r, 300));
          await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOSCAN' });
        } catch (injectErr) {
          setAutoScanUI(false, 'idle');
          $('autoscan-label').textContent = 'Reload the LinkedIn tab and try again';
        }
      }
    } else {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTOSCAN' });
      } catch { /* tab may have navigated away */ }
      setAutoScanUI(false, 'idle');
    }
  });

  $('btn-activityscan').addEventListener('click', async () => {
    const tab = await getLinkedInProfileTab();

    if (!tab) {
      setActivityScanUI(false, 'not_on_profile');
      return;
    }

    if (!activityScanRunning) {
      setActivityScanUI(true);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'START_ACTIVITY_SCAN' });
      } catch {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/feed-scanner.js'] });
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/feed-scanner.css'] });
          await new Promise(r => setTimeout(r, 300));
          await chrome.tabs.sendMessage(tab.id, { type: 'START_ACTIVITY_SCAN' });
        } catch {
          setActivityScanUI(false, 'idle');
          $('activityscan-label').textContent = 'Reload the LinkedIn profile and try again';
        }
      }
    } else {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_ACTIVITY_SCAN' });
      } catch { /* tab may have navigated away */ }
      setActivityScanUI(false, 'idle');
    }
  });

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderJobList();
    });
  });

  // Settings
  $('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Export CSV
  $('btn-export').addEventListener('click', async () => {
    const res = await send('EXPORT_CSV');
    if (!res?.csv) return;
    const blob = new Blob([res.csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linkedin-jobs-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Back button
  $('btn-back').addEventListener('click', () => {
    closeDetail();
    loadJobs();
  });

  // Status buttons
  document.querySelectorAll('.status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!currentJobId) return;
      const status = btn.dataset.status;
      document.querySelectorAll('.status-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const reminderDate = status === 'Applied' ? $('reminder-date').value || null : null;
      await send('UPDATE_JOB_STATUS', { postId: currentJobId, status, reminderDate });
      const job = allJobs.find(j => j.postId === currentJobId);
      if (job) job.status = status;
    });
  });

  // Reminder
  $('btn-set-reminder').addEventListener('click', async () => {
    if (!currentJobId) return;
    const date = $('reminder-date').value;
    if (!date) return;
    await send('SET_REMINDER', { postId: currentJobId, reminderDate: date });
    $('btn-set-reminder').textContent = 'Set ✓';
    setTimeout(() => { $('btn-set-reminder').textContent = 'Set'; }, 2000);
  });

  // Compose buttons
  $('btn-gen-comment').addEventListener('click', () => generate('comment'));
  $('btn-gen-email').addEventListener('click', () => generate('email'));
  $('btn-gen-connect').addEventListener('click', () => generate('connect'));

  // Copy
  $('btn-copy').addEventListener('click', async () => {
    const text = $('compose-textarea').value;
    await navigator.clipboard.writeText(text);
    const confirm = $('copy-confirm');
    confirm.classList.remove('hidden');
    setTimeout(() => confirm.classList.add('hidden'), 2000);
  });

  // Delete
  $('btn-delete').addEventListener('click', async () => {
    if (!currentJobId) return;
    if (!confirm('Delete this job entry?')) return;
    await send('DELETE_JOB', { postId: currentJobId });
    closeDetail();
    await loadJobs();
  });
}

init();
