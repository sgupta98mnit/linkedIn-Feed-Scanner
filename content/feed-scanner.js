// Content script — LinkedIn feed scanner (sequential, auto-scroll)

(function () {
  'use strict';

  const BADGE_CLASS    = 'lfs-badge';
  const PROCESSED_ATTR = 'data-lfs-processed';

  const log  = (...a) => console.log('%c[LFS]', 'color:#0a66c2;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[LFS]',  'color:#e65100;font-weight:bold', ...a);
  const err  = (...a) => console.error('%c[LFS]', 'color:#c62828;font-weight:bold', ...a);

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function findPosts() {
    return [...document.querySelectorAll('div[role="listitem"][componentkey]')];
  }

  function extractPostId(el) {
    const key = el.getAttribute('componentkey') || '';
    const m = key.match(/^expanded(.+?)FeedType_/) || key.match(/^(.+?)FeedType_/);
    return m ? m[1] : (key || null);
  }

  function extractPostText(el) {
    const node = el.querySelector('[data-testid="expandable-text-box"]');
    if (node) return node.innerText.trim().slice(0, 3000);
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, svg, style, script').forEach(n => n.remove());
    return clone.innerText.trim().slice(0, 3000);
  }

  function extractAuthorName(el) {
    for (const c of el.querySelectorAll('[aria-label]')) {
      const label = c.getAttribute('aria-label') || '';
      if (/^[A-Z][a-z]+ [A-Z]/.test(label) && !label.startsWith('View ') && !label.startsWith('Follow ')) {
        return label
          .replace(/\s*(Premium\s*)?Profile\s*\d*(st|nd|rd|th)?\s*/gi, '')
          .replace(/\s*Verified\s*/gi, '')
          .replace(/\s*\d+(st|nd|rd|th)\s*/gi, '')
          .trim();
      }
    }
    return '';
  }

  function extractPostUrl(el) {
    // Prefer explicit anchor links in the post element
    const anchor = el.querySelector('a[href*="/feed/update/"]')
                || el.querySelector('a[href*="/posts/"]');
    if (anchor) return anchor.href;

    // Fall back to constructing from the componentkey, which often contains the activity URN.
    // e.g. componentkey="expandedurn:li:activity:1234567890FeedType_..." → postId="urn:li:activity:1234567890"
    const key = el.getAttribute('componentkey') || '';
    const urnMatch = key.match(/(urn:li:activity:\d+)/);
    if (urnMatch) return `https://www.linkedin.com/feed/update/${urnMatch[1]}`;

    return '';  // empty is safer than the feed homepage URL
  }

  function isInOrNearViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight + 800 && r.bottom > -200;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Badge ─────────────────────────────────────────────────────────────────

  function injectBadge(el, score) {
    if (el.querySelector(`.${BADGE_CLASS}`)) return;
    const badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    badge.textContent = `Saved — ${score}/10 match`;
    badge.style.cssText = `
      position:absolute;top:10px;right:10px;background:#0a66c2;color:#fff;
      font-size:11px;font-weight:600;padding:3px 9px;border-radius:12px;
      z-index:9999;pointer-events:none;
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      box-shadow:0 1px 4px rgba(0,0,0,.25);letter-spacing:.2px;
    `;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(badge);
  }

  // ── Offline warning ───────────────────────────────────────────────────────

  let offlineWarned = false;
  function showOfflineWarning(msg) {
    if (offlineWarned) return;
    offlineWarned = true;
    const w = document.createElement('div');
    w.id = 'lfs-offline-warning';
    w.innerHTML = `<span>⚠ LinkedIn Feed Scanner: ${msg}</span>
      <button id="lfs-warn-dismiss" style="margin-left:10px;background:none;border:1px solid #fff;
      color:#fff;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px">Dismiss</button>`;
    w.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
      background:#c62828;color:#fff;padding:10px 16px;border-radius:8px;z-index:999999;
      font-family:system-ui,sans-serif;font-size:13px;display:flex;align-items:center;
      box-shadow:0 2px 12px rgba(0,0,0,.35);max-width:90vw;`;
    document.body.appendChild(w);
    document.getElementById('lfs-warn-dismiss')?.addEventListener('click', () => w.remove());
  }

  // ── Progress overlay (shown during auto-scan) ─────────────────────────────

  let overlayEl = null;

  function showOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'lfs-progress-overlay';
    overlayEl.style.cssText = `
      position:fixed;bottom:24px;right:24px;background:#0a66c2;color:#fff;
      padding:10px 16px;border-radius:10px;z-index:999999;
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;
      box-shadow:0 4px 16px rgba(0,0,0,.3);min-width:200px;
    `;
    overlayEl.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">🔍 Scanning feed…</div>
      <div id="lfs-overlay-text" style="font-size:12px;opacity:.85">Starting…</div>
    `;
    document.body.appendChild(overlayEl);
  }

  function updateOverlay(text) {
    const el = document.getElementById('lfs-overlay-text');
    if (el) el.textContent = text;
  }

  function hideOverlay() {
    overlayEl?.remove();
    overlayEl = null;
  }

  function notifyProgress(stats) {
    const text = `Processed: ${stats.processed} | Saved: ${stats.saved} | Skipped: ${stats.skipped}`;
    updateOverlay(text);
    chrome.runtime.sendMessage({
      type: 'AUTOSCAN_STATUS',
      payload: { active: true, ...stats },
    }).catch(() => {});
  }

  // ── Single post scanner ───────────────────────────────────────────────────

  async function scanPost(el, stats) {
    if (el.getAttribute(PROCESSED_ATTR) && el.getAttribute(PROCESSED_ATTR) !== 'queued') return;

    const postId = extractPostId(el);
    if (!postId) {
      el.setAttribute(PROCESSED_ATTR, 'no-id');
      return;
    }

    el.setAttribute(PROCESSED_ATTR, 'pending');

    const postText = extractPostText(el);
    if (!postText || postText.length < 30) {
      warn(`Post ${postId.slice(0, 12)}… — skipped (no text)`);
      el.setAttribute(PROCESSED_ATTR, 'skipped-empty');
      stats.skipped++;
      return;
    }

    const postUrl    = extractPostUrl(el);
    const posterName = extractAuthorName(el);

    // Highlight the post being scanned
    el.style.outline = '2px solid #0a66c2';
    el.style.outlineOffset = '2px';

    log(`Scanning post ${postId.slice(0, 12)}… | "${postText.slice(0, 60)}…"`);

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_POST',
        payload: { postId, postText, postUrl, posterName },
      });
    } catch (e) {
      err(`Post ${postId.slice(0, 12)}… — runtime error:`, e.message);
      el.style.outline = '2px solid #e53935';
      el.setAttribute(PROCESSED_ATTR, 'error');
      stats.errors++;
      return;
    } finally {
      // Remove scan highlight after a short pause so the user can see it
      setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 600);
    }

    if (!response) {
      el.setAttribute(PROCESSED_ATTR, 'error');
      stats.errors++;
      return;
    }

    if (response.error) {
      const msg = response.error;
      err(`Post ${postId.slice(0, 12)}… — error: ${msg}`);
      if (msg.includes('offline') || msg.includes('CORS')) {
        showOfflineWarning(msg);
      } else if (msg.includes('Profile not')) {
        showOfflineWarning('Profile not configured. Open extension options.');
      }
      el.setAttribute(PROCESSED_ATTR, 'error');
      stats.errors++;
      return;
    }

    if (response.skipped) {
      log(`Post ${postId.slice(0, 12)}… — cached`);
      el.setAttribute(PROCESSED_ATTR, 'cached');
      if (response.cached?.wasSaved) injectBadge(el, response.cached.score);
      stats.cached++;
      return;
    }

    stats.processed++;

    if (response.saved) {
      log(`Post ${postId.slice(0, 12)}… — ✅ SAVED (${response.score}/10) "${response.job?.jobTitle}" @ "${response.job?.company}"`);
      el.setAttribute(PROCESSED_ATTR, 'saved');
      injectBadge(el, response.score);
      stats.saved++;
    } else {
      log(`Post ${postId.slice(0, 12)}… — not relevant (score ${response.score}/10, isJob=${response.isJobPost})`);
      el.setAttribute(PROCESSED_ATTR, 'scanned');
      stats.rejected++;
    }
  }

  // ── Auto-scan loop ────────────────────────────────────────────────────────

  let autoScanActive = false;
  let _keepAlivePort = null;

  function openKeepAlivePort() {
    try {
      _keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
      _keepAlivePort.onDisconnect.addListener(() => { _keepAlivePort = null; });
    } catch {}
  }

  function closeKeepAlivePort() {
    try { _keepAlivePort?.disconnect(); } catch {}
    _keepAlivePort = null;
  }

  async function runAutoScan() {
    const stats = { processed: 0, saved: 0, rejected: 0, skipped: 0, errors: 0, cached: 0 };

    openKeepAlivePort(); // keep service worker alive during long Ollama calls
    showOverlay();
    log('Auto-scan started');

    while (autoScanActive) {
      // Find the next unprocessed post anywhere in the DOM
      const next = findPosts().find(p => {
        const state = p.getAttribute(PROCESSED_ATTR);
        return !state || state === 'queued';
      });

      if (!next) {
        // No unprocessed posts — scroll to load more
        const pageHeight   = document.documentElement.scrollHeight;
        const scrollBottom = window.scrollY + window.innerHeight;
        const atBottom     = pageHeight - scrollBottom < 300;

        if (atBottom) {
          await sleep(2000);
          if (document.documentElement.scrollHeight <= pageHeight) {
            log('Auto-scan: reached bottom of feed.');
            break;
          }
        }

        log('No new posts in view — scrolling to load more…');
        window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'smooth' });
        await sleep(2500);
        continue;
      }

      // Mark immediately so it isn't picked up again on the next loop tick
      next.setAttribute(PROCESSED_ATTR, 'queued');

      // Scroll post into view so the user sees what's being scanned
      next.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);

      await scanPost(next, stats);
      notifyProgress(stats);
      await sleep(200);
    }

    const reason = autoScanActive ? 'done' : 'user_stopped';
    autoScanActive = false;
    closeKeepAlivePort();
    hideOverlay();

    log(`Auto-scan finished. Processed: ${stats.processed} | Saved: ${stats.saved} | Errors: ${stats.errors}`);

    chrome.runtime.sendMessage({
      type: 'AUTOSCAN_STATUS',
      payload: { active: false, reason, ...stats },
    }).catch(() => {});
  }

  function stopAutoScan() {
    autoScanActive = false;
    closeKeepAlivePort();
    hideOverlay();
    chrome.runtime.sendMessage({
      type: 'AUTOSCAN_STATUS',
      payload: { active: false, reason: 'user_stopped' },
    }).catch(() => {});
  }

  // ── Message listener (from popup) ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_AUTOSCAN_STATE') {
      sendResponse({ active: autoScanActive });
      return;
    }
    if (msg.type === 'START_AUTOSCAN') {
      if (autoScanActive) return;
      if (!window.location.pathname.startsWith('/feed')) {
        chrome.runtime.sendMessage({
          type: 'AUTOSCAN_STATUS',
          payload: { active: false, reason: 'not_on_feed' },
        }).catch(() => {});
        return;
      }
      autoScanActive = true;
      runAutoScan();
    }
    if (msg.type === 'STOP_AUTOSCAN') {
      stopAutoScan();
    }
  });

  // ── SPA navigation ────────────────────────────────────────────────────────

  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    if (window.location.pathname.startsWith('/feed')) {
      log('SPA navigation to feed, ready to scan.');
    }
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  log('Content script loaded on', window.location.pathname);

})();
