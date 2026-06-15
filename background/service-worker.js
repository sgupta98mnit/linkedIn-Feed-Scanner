// Background service worker — handles all AI API calls and alarms
// Supports two providers: 'ollama' (local) and 'google-ai' (Google AI Studio)

import {
  ollamaGenerateFull,
  ollamaGenerateStream,
  checkOllamaOnline,
  buildJobDetectionPrompt,
  buildCommentPrompt,
  buildEmailPrompt,
  buildConnectionRequestPrompt,
  buildRoleExtractionPrompt,
} from '../utils/ollama.js';

import {
  googleAIGenerateFull,
  googleAIGenerateStream,
  googleAIGenerateWithImage,
  checkGoogleAIOnline,
} from '../utils/google-ai.js';

import { logOllamaCall } from '../utils/db.js';

import {
  getProfile,
  getSavedJobs,
  saveJob,
  updateJobStatus,
  deleteJob,
  setJobReminder,
  markPostScanned,
  getScannedPostIds,
  exportJobsAsCSV,
} from '../utils/storage.js';

// ── Provider helpers ─────────────────────────────────────────────────────────

function isGoogleAI(profile) {
  return (profile?.provider || 'ollama') === 'google-ai';
}

async function requireAI(profile) {
  if (isGoogleAI(profile)) {
    const model = profile.googleModel || 'gemma-4-31b-it';
    return checkGoogleAIOnline(profile.googleApiKey || '', model);
  }
  const baseUrl = profile?.ollamaBaseUrl || 'http://localhost:11434';
  return checkOllamaOnline(baseUrl);
}

async function aiGenerateFull({ profile, prompt, systemPrompt, numCtx, timeoutMs = 120000 }) {
  if (isGoogleAI(profile)) {
    return googleAIGenerateFull({
      apiKey: profile.googleApiKey,
      model: profile.googleModel || 'gemma-4-31b-it',
      prompt,
      systemPrompt,
      timeoutMs,
    });
  }
  return ollamaGenerateFull({
    baseUrl: profile.ollamaBaseUrl || 'http://localhost:11434',
    model: profile.ollamaModel || 'gemma4:e4b',
    prompt,
    systemPrompt,
    numCtx: numCtx || 8192,
    timeoutMs,
  });
}

async function aiGenerateStream({ profile, prompt, systemPrompt, onChunk, onDone, numCtx, timeoutMs = 300000 }) {
  if (isGoogleAI(profile)) {
    return googleAIGenerateStream({
      apiKey: profile.googleApiKey,
      model: profile.googleModel || 'gemma-4-31b-it',
      prompt,
      systemPrompt,
      onChunk,
      onDone,
      timeoutMs,
    });
  }
  return ollamaGenerateStream({
    baseUrl: profile.ollamaBaseUrl || 'http://localhost:11434',
    model: profile.ollamaModel || 'gemma4:e4b',
    prompt,
    systemPrompt,
    onChunk,
    onDone,
    numCtx: numCtx || 8192,
    timeoutMs,
  });
}

function activeModel(profile) {
  if (isGoogleAI(profile)) return profile.googleModel || 'gemma-4-31b-it';
  return profile.ollamaModel || 'gemma4:e4b';
}

// ── Keep-alive port (prevents Chrome from killing the worker mid-call) ────────

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'keepAlive') return;
  port.onDisconnect.addListener(() => {});
});

// ── Alarm handling for follow-up reminders ────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('reminder_')) return;
  const postId = alarm.name.replace('reminder_', '');
  const jobs = await getSavedJobs();
  const job = jobs.find(j => j.postId === postId);
  if (!job) return;

  chrome.notifications.create(`notif_${postId}`, {
    type: 'basic',
    iconUrl: '../icons/icon48.png',
    title: 'Follow-up Reminder',
    message: `Time to follow up on ${job.jobTitle} at ${job.company}`,
  });

  await updateBadge();
});

// ── Badge count ───────────────────────────────────────────────────────────────

async function updateBadge() {
  const jobs = await getSavedJobs();
  const now = Date.now();
  const due = jobs.filter(j => j.status === 'Applied' && j.reminderDate && new Date(j.reminderDate).getTime() <= now);
  if (due.length > 0) {
    chrome.action.setBadgeText({ text: String(due.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('../options/options.html') });
  }
  updateBadge();
});

// ── JSON extraction helper ────────────────────────────────────────────────────
// Gemma often "thinks out loud" and emits multiple JSON blocks inside markdown
// fences before settling on a final answer. This function:
//   1. Finds all ```json ... ``` fenced blocks and tries to parse the LAST one.
//   2. Falls back to finding the last bare {...} object in the text.
// Using the last block handles models that self-correct mid-response.

function extractJSON(text) {
  // Collect all fenced JSON blocks (```json ... ``` or ``` ... ```)
  const fenceRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let lastFenced = null;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    lastFenced = m[1];
  }
  if (lastFenced) {
    try { return JSON.parse(lastFenced); } catch {}
  }

  // Fallback: find all bare {...} objects and try each from last to first
  const bareRe = /\{[\s\S]*?\}/g;
  const candidates = [];
  while ((m = bareRe.exec(text)) !== null) {
    candidates.push(m[0]);
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch {}
  }

  // Last resort: throw so the caller can log it
  throw new SyntaxError('No valid JSON object found in response');
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.error('[LinkedFeedScanner SW] Error:', err);
    sendResponse({ error: err.message || 'Unknown error' });
  });
  return true;
});

async function handleMessage(message) {
  const { type, payload } = message;

  switch (type) {

    case 'PING': {
      return { ok: true, t: Date.now() };
    }

    case 'CHECK_OLLAMA': {
      // Legacy name kept for content script compatibility
      const profile = await getProfile();
      const { online, error } = await requireAI(profile);
      return { online, error };
    }

    case 'ANALYZE_POST': {
      const { postId, postText } = payload;

      const scanned = await getScannedPostIds();
      if (scanned[postId]) {
        return { skipped: true, cached: scanned[postId] };
      }

      const profile = await getProfile();
      if (!profile) {
        return { error: 'Profile not set up. Please open extension options.' };
      }

      const { online, error: aiErr } = await requireAI(profile);
      if (!online) {
        return { error: `AI provider is offline. ${aiErr || ''}`.trim() };
      }

      const { bio = '', targetRoles = '', industries = 'All' } = profile;
      const model = activeModel(profile);
      const prompt = buildJobDetectionPrompt(postText, targetRoles, bio, industries);

      let rawResponse;
      try {
        rawResponse = await aiGenerateStream({
          profile, prompt,
          onChunk: () => {},
          onDone: () => {},
        });
      } catch (err) {
        await logOllamaCall({ type: 'analyze_post', model, prompt, response: '', decision: 'error', postId, errorMsg: err.message });
        return { error: `AI error: ${err.message}` };
      }

      let parsed;
      try {
        parsed = extractJSON(rawResponse);
      } catch {
        await logOllamaCall({ type: 'analyze_post', model, prompt, response: rawResponse, decision: 'error', postId, errorMsg: 'JSON parse failed' });
        return { error: 'Failed to parse AI response as JSON', raw: rawResponse };
      }

      const saved = parsed.is_job_post && parsed.relevance_score >= 6;

      await logOllamaCall({
        type:     'analyze_post',
        model,
        prompt,
        response: rawResponse,
        decision: saved ? 'saved' : (parsed.is_job_post ? 'rejected' : 'not_job'),
        score:    parsed.relevance_score,
        postId,
        postUrl:  payload.postUrl || '',
        jobTitle: parsed.job_title,
        company:  parsed.company,
      });

      if (saved) {
        const job = {
          postId,
          postUrl:      payload.postUrl || '',
          jobTitle:     parsed.job_title || 'Unknown Title',
          company:      parsed.company || 'Unknown Company',
          posterName:   parsed.poster_name || payload.posterName || '',
          summary:      parsed.summary || '',
          relevanceScore: parsed.relevance_score,
          status:       'Interested',
          timestamp:    Date.now(),
          postText:     postText.slice(0, 500),
        };
        if (payload.sourceType) {
          job.sourceType = payload.sourceType;
          job.sourceProfileSlug = payload.sourceProfileSlug || '';
          job.sourceProfileName = payload.sourceProfileName || '';
          job.engagementType = payload.engagementType || '';
          job.activityUrl = payload.activityUrl || '';
        }
        // Save first — if saveJob throws (storage quota, etc.) we must NOT mark
        // the post as scanned, or it becomes permanently blocklisted but never
        // actually saved.
        await saveJob(job);
        await markPostScanned(postId, true, true, parsed.relevance_score);
        await updateBadge();
        return { saved: true, job, score: parsed.relevance_score };
      }

      // Only mark as scanned for the non-saved branch — no storage write can fail here.
      await markPostScanned(postId, parsed.is_job_post, false, parsed.relevance_score);

      return { saved: false, isJobPost: parsed.is_job_post, score: parsed.relevance_score };
    }

    case 'GENERATE_COMMENT': {
      const { postId, tone = 'Professional' } = payload;
      const profile = await getProfile();
      if (!profile) return { error: 'Profile not configured' };

      const jobs = await getSavedJobs();
      const job = jobs.find(j => j.postId === postId);
      if (!job) return { error: 'Job not found' };

      const { online, error: aiErr } = await requireAI(profile);
      if (!online) return { error: `AI provider is offline. ${aiErr || ''}`.trim() };

      const model = activeModel(profile);
      const prompt = buildCommentPrompt(job.summary, profile.bio || '', tone);
      try {
        const text = await aiGenerateFull({ profile, prompt });
        await logOllamaCall({ type: 'generate_comment', model, prompt, response: text, decision: 'generated', postId, jobTitle: job.jobTitle, company: job.company });
        return { text: text.trim() };
      } catch (err) {
        await logOllamaCall({ type: 'generate_comment', model, prompt, response: '', decision: 'error', postId, errorMsg: err.message });
        return { error: err.message };
      }
    }

    case 'GENERATE_EMAIL': {
      const { postId, tone = 'Professional' } = payload;
      const profile = await getProfile();
      if (!profile) return { error: 'Profile not configured' };

      const jobs = await getSavedJobs();
      const job = jobs.find(j => j.postId === postId);
      if (!job) return { error: 'Job not found' };

      const { online, error: aiErr } = await requireAI(profile);
      if (!online) return { error: `AI provider is offline. ${aiErr || ''}`.trim() };

      const model = activeModel(profile);
      const prompt = buildEmailPrompt(job.company, job.jobTitle, profile.bio || '', tone);
      try {
        const text = await aiGenerateFull({ profile, prompt });
        await logOllamaCall({ type: 'generate_email', model, prompt, response: text, decision: 'generated', postId, jobTitle: job.jobTitle, company: job.company });
        return { text: text.trim() };
      } catch (err) {
        await logOllamaCall({ type: 'generate_email', model, prompt, response: '', decision: 'error', postId, errorMsg: err.message });
        return { error: err.message };
      }
    }

    case 'GENERATE_CONNECTION_REQUEST': {
      const { postId, tone = 'Professional' } = payload;
      const profile = await getProfile();
      if (!profile) return { error: 'Profile not configured' };

      const jobs = await getSavedJobs();
      const job = jobs.find(j => j.postId === postId);
      if (!job) return { error: 'Job not found' };

      const { online, error: aiErr } = await requireAI(profile);
      if (!online) return { error: `AI provider is offline. ${aiErr || ''}`.trim() };

      const model = activeModel(profile);
      const prompt = buildConnectionRequestPrompt(job.posterName || 'the poster', job.jobTitle, job.company, profile.bio || '');
      try {
        const text = await aiGenerateFull({ profile, prompt });
        await logOllamaCall({ type: 'generate_connect', model, prompt, response: text, decision: 'generated', postId, jobTitle: job.jobTitle, company: job.company });
        return { text: text.trim() };
      } catch (err) {
        await logOllamaCall({ type: 'generate_connect', model, prompt, response: '', decision: 'error', postId, errorMsg: err.message });
        return { error: err.message };
      }
    }

    case 'GET_SAVED_JOBS': {
      const jobs = await getSavedJobs();
      return { jobs };
    }

    case 'UPDATE_JOB_STATUS': {
      const { postId, status } = payload;
      const jobs = await updateJobStatus(postId, status);
      if (status === 'Applied' && payload.reminderDate) {
        await setJobReminder(postId, payload.reminderDate);
        const alarmTime = new Date(payload.reminderDate).getTime();
        if (alarmTime > Date.now()) {
          chrome.alarms.create(`reminder_${postId}`, { when: alarmTime });
        }
      }
      await updateBadge();
      return { jobs };
    }

    case 'SET_REMINDER': {
      const { postId, reminderDate } = payload;
      await setJobReminder(postId, reminderDate);
      const alarmTime = new Date(reminderDate).getTime();
      if (alarmTime > Date.now()) {
        chrome.alarms.create(`reminder_${postId}`, { when: alarmTime });
      }
      return { ok: true };
    }

    case 'DELETE_JOB': {
      const jobs = await deleteJob(payload.postId);
      chrome.alarms.clear(`reminder_${payload.postId}`);
      await updateBadge();
      return { jobs };
    }

    case 'EXPORT_CSV': {
      const csv = await exportJobsAsCSV();
      return { csv };
    }

    case 'EXTRACT_PDF_OCR': {
      const { pages } = payload;
      if (!pages?.length) return { error: 'No pages provided' };

      const profile = await getProfile();
      const model = activeModel(profile);

      const { online, error: aiErr } = await requireAI(profile);
      if (!online) return { error: `AI provider is offline. ${aiErr || ''}`.trim() };

      const pageTexts = [];

      for (let i = 0; i < pages.length; i++) {
        const prompt = `This is page ${i + 1} of ${pages.length} of a resume or professional bio. Extract ALL text exactly as it appears — preserve names, job titles, companies, skills, dates, and bullet points. Output only the raw text, no commentary.`;

        try {
          let pageText = '';

          if (isGoogleAI(profile)) {
            pageText = await googleAIGenerateWithImage({
              apiKey: profile.googleApiKey,
              model,
              prompt,
              imageBase64: pages[i],
              mimeType: 'image/png',
              temperature: 0,
            });
          } else {
            const response = await fetch(`${profile.ollamaBaseUrl || 'http://localhost:11434'}/api/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, prompt, images: [pages[i]], stream: false, options: { temperature: 0 } }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            pageText = data.response?.trim() || '';
          }

          if (pageText) pageTexts.push(pageText);
          await logOllamaCall({ type: 'ocr', model, prompt, response: pageText, decision: 'generated' });
        } catch (err) {
          await logOllamaCall({ type: 'ocr', model, prompt: `page ${i + 1}`, response: '', decision: 'error', errorMsg: err.message });
          console.error(`[OCR] Page ${i + 1} failed:`, err);
        }
      }

      return { text: pageTexts.join('\n\n') };
    }

    case 'EXTRACT_ROLES': {
      const { bio } = payload;
      if (!bio) return { error: 'No resume text provided' };

      const profile = await getProfile();
      const model = activeModel(profile);

      const { online, error: aiErr } = await requireAI(profile);
      if (!online) return { error: `AI provider is offline. ${aiErr || ''}`.trim() };

      const prompt = buildRoleExtractionPrompt(bio);
      try {
        const text = await aiGenerateFull({ profile, prompt, numCtx: 16384 });
        await logOllamaCall({ type: 'extract_roles', model, prompt, response: text, decision: 'generated' });
        const lines = text.trim().split('\n').filter(l => l.includes(',') || l.length > 5);
        const roles = lines[lines.length - 1]?.trim() || text.trim();
        return { roles };
      } catch (err) {
        await logOllamaCall({ type: 'extract_roles', model, prompt, response: '', decision: 'error', errorMsg: err.message });
        return { error: err.message };
      }
    }

    case 'GET_LOGS': {
      const { getAllLogs, getLogStats } = await import('../utils/db.js');
      const [logs, stats] = await Promise.all([getAllLogs(), getLogStats()]);
      return { logs, stats };
    }

    case 'CLEAR_LOGS': {
      const { clearLogs } = await import('../utils/db.js');
      await clearLogs();
      return { ok: true };
    }

    case 'AUTOSCAN_STATUS': {
      chrome.runtime.sendMessage({ type: 'AUTOSCAN_STATUS', payload }).catch(() => {});
      return { ok: true };
    }

    default:
      return { error: `Unknown message type: ${type}` };
  }
}
