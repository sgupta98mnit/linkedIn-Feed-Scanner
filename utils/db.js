// IndexedDB logger — records every Ollama interaction for analysis
// Schema: ollama_logs { id, ts, type, model, promptTokenEst, prompt, response, decision, score, postId, jobTitle, company }

const DB_NAME    = 'lfs_analytics';
const DB_VERSION = 1;
const STORE      = 'ollama_logs';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts',       'ts',       { unique: false });
        store.createIndex('type',     'type',     { unique: false });
        store.createIndex('decision', 'decision', { unique: false });
        store.createIndex('postId',   'postId',   { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function logOllamaCall({
  type,         // 'analyze_post' | 'generate_comment' | 'generate_email' | 'generate_connect' | 'extract_roles' | 'ocr'
  model,
  prompt,
  response,
  decision,     // 'saved' | 'rejected' | 'error' | 'generated' | 'cached'
  score,        // relevance score or null
  postId,
  postUrl,
  jobTitle,
  company,
  errorMsg,
}) {
  try {
    const db = await openDB();
    const record = {
      ts:             Date.now(),
      type:           type || 'unknown',
      model:          model || '',
      promptLen:      prompt?.length || 0,
      responseLen:    response?.length || 0,
      prompt:         (prompt || '').slice(0, 4000),   // cap at 4k chars
      response:       (response || '').slice(0, 4000),
      decision:       decision || '',
      score:          score ?? null,
      postId:         postId || '',
      postUrl:        postUrl || '',
      jobTitle:       jobTitle || '',
      company:        company || '',
      errorMsg:       errorMsg || '',
    };
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[LFS DB] Failed to log:', e);
  }
}

export async function getAllLogs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function getLogStats() {
  const logs = await getAllLogs();
  const total    = logs.length;
  const saved    = logs.filter(l => l.decision === 'saved').length;
  const rejected = logs.filter(l => l.decision === 'rejected').length;
  const errors   = logs.filter(l => l.decision === 'error').length;
  const byType   = {};
  const byModel  = {};
  for (const l of logs) {
    byType[l.type]   = (byType[l.type]   || 0) + 1;
    byModel[l.model] = (byModel[l.model] || 0) + 1;
  }
  return { total, saved, rejected, errors, byType, byModel };
}

export async function clearLogs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export function logsToCSV(logs) {
  if (!logs.length) return '';
  const headers = ['id','ts','type','model','decision','score','jobTitle','company','postId','promptLen','responseLen','prompt','response','errorMsg'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = logs.map(l => headers.map(h =>
    h === 'ts' ? esc(new Date(l[h]).toISOString()) : esc(l[h])
  ).join(','));
  return [headers.join(','), ...rows].join('\n');
}
