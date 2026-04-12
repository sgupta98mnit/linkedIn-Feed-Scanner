// chrome.storage.local helpers

export const KEYS = {
  PROFILE: 'userProfile',
  SAVED_JOBS: 'savedJobs',
  SCANNED_POSTS: 'scannedPosts',
  REMINDERS: 'reminders',
};

export async function getProfile() {
  const result = await chrome.storage.local.get(KEYS.PROFILE);
  return result[KEYS.PROFILE] || null;
}

export async function saveProfile(profile) {
  await chrome.storage.local.set({ [KEYS.PROFILE]: profile });
}

export async function getSavedJobs() {
  const result = await chrome.storage.local.get(KEYS.SAVED_JOBS);
  return result[KEYS.SAVED_JOBS] || [];
}

export async function saveJob(job) {
  const jobs = await getSavedJobs();
  const existing = jobs.findIndex(j => j.postId === job.postId);
  if (existing >= 0) {
    jobs[existing] = { ...jobs[existing], ...job };
  } else {
    jobs.push(job);
  }
  jobs.sort((a, b) => b.relevanceScore - a.relevanceScore);
  await chrome.storage.local.set({ [KEYS.SAVED_JOBS]: jobs });
  return jobs;
}

export async function updateJobStatus(postId, status) {
  const jobs = await getSavedJobs();
  const idx = jobs.findIndex(j => j.postId === postId);
  if (idx >= 0) {
    jobs[idx].status = status;
    await chrome.storage.local.set({ [KEYS.SAVED_JOBS]: jobs });
  }
  return jobs;
}

export async function deleteJob(postId) {
  const jobs = await getSavedJobs();
  const filtered = jobs.filter(j => j.postId !== postId);
  await chrome.storage.local.set({ [KEYS.SAVED_JOBS]: filtered });
  return filtered;
}

export async function setJobReminder(postId, reminderDate) {
  const jobs = await getSavedJobs();
  const idx = jobs.findIndex(j => j.postId === postId);
  if (idx >= 0) {
    jobs[idx].reminderDate = reminderDate;
    await chrome.storage.local.set({ [KEYS.SAVED_JOBS]: jobs });
  }
  return jobs;
}

export async function getScannedPostIds() {
  const result = await chrome.storage.local.get(KEYS.SCANNED_POSTS);
  return result[KEYS.SCANNED_POSTS] || {};
}

export async function markPostScanned(postId, wasJobPost, wasSaved = false, score = 0) {
  const scanned = await getScannedPostIds();
  scanned[postId] = { scannedAt: Date.now(), wasJobPost, wasSaved, score };
  await chrome.storage.local.set({ [KEYS.SCANNED_POSTS]: scanned });
}

export async function clearAllData() {
  await chrome.storage.local.clear();
}

export async function exportJobsAsCSV() {
  const jobs = await getSavedJobs();
  if (jobs.length === 0) return '';

  const headers = ['Job Title', 'Company', 'Score', 'Status', 'Date', 'Summary', 'URL'];
  const rows = jobs.map(j => [
    csvEscape(j.jobTitle || ''),
    csvEscape(j.company || ''),
    j.relevanceScore ?? '',
    csvEscape(j.status || 'Interested'),
    j.timestamp ? new Date(j.timestamp).toLocaleDateString() : '',
    csvEscape(j.summary || ''),
    csvEscape(j.postUrl || ''),
  ]);

  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  return csv;
}

function csvEscape(val) {
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}
