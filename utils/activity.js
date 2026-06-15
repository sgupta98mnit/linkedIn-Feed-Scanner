const ACTIVITY_PATH = 'recent-activity/comments/';
const ACTIVITY_URN_RE = /urn:li:(?:activity|share|ugcPost):\d+/i;
const ACTIVITY_ID_RE = /activity[:%-](\d{6,})|activity-(\d{6,})/i;
const JOB_VIEW_RE = /\/jobs\/view\/(\d+)/i;

export function extractProfileSlugFromUrl(url) {
  try {
    const parsed = new URL(url, 'https://www.linkedin.com');
    const match = parsed.pathname.match(/^\/in\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

export function buildRecentActivityUrl(slug) {
  const cleanSlug = String(slug || '').replace(/^\/+|\/+$/g, '');
  return cleanSlug ? `https://www.linkedin.com/in/${encodeURIComponent(cleanSlug)}/${ACTIVITY_PATH}` : '';
}

export function inferEngagementType(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  if (/\bcommented\b|\breplied\b/.test(normalized)) return 'commented';
  if (
    /\blikes?\s+this\b/.test(normalized) ||
    /\breacted\s+to\b/.test(normalized) ||
    /\b(loves|celebrates|supports|finds this insightful|finds this funny)\s+this\b/.test(normalized)
  ) {
    return 'reacted';
  }
  return 'unknown';
}

export function extractPostIdFromUrl(url) {
  const decoded = decodeURIComponent(String(url || ''));
  const urn = decoded.match(ACTIVITY_URN_RE);
  if (urn) return urn[0];
  const job = decoded.match(JOB_VIEW_RE);
  if (job) return `linkedin-job:${job[1]}`;
  const id = decoded.match(ACTIVITY_ID_RE);
  return id ? `urn:li:activity:${id[1] || id[2]}` : '';
}

export function normalizeActivityCandidates(rawCandidates, source = {}) {
  const seen = new Set();
  const normalized = [];

  for (const raw of rawCandidates || []) {
    const engagementType = raw.engagementType || inferEngagementType(raw.text);
    if (engagementType !== 'commented' && engagementType !== 'reacted') continue;

    const postUrl = raw.postUrl || '';
    const postId = raw.postId || extractPostIdFromUrl(postUrl);
    if (!postId || seen.has(postId)) continue;
    seen.add(postId);

    normalized.push({
      postId,
      postUrl,
      postText: String(raw.postText || raw.text || '').trim(),
      posterName: raw.posterName || '',
      engagementType,
      sourceType: 'profile_activity',
      sourceProfileSlug: source.sourceProfileSlug || '',
      sourceProfileName: source.sourceProfileName || '',
      activityUrl: source.activityUrl || '',
    });
  }

  return normalized;
}
