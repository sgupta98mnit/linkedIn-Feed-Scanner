import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecentActivityUrl,
  extractProfileSlugFromUrl,
  inferEngagementType,
  normalizeActivityCandidates,
} from '../utils/activity.js';

test('extracts LinkedIn profile slug from profile and activity URLs', () => {
  assert.equal(extractProfileSlugFromUrl('https://www.linkedin.com/in/annamiller/'), 'annamiller');
  assert.equal(extractProfileSlugFromUrl('https://www.linkedin.com/in/annamiller/recent-activity/all/'), 'annamiller');
});

test('builds recent activity URL for a slug', () => {
  assert.equal(buildRecentActivityUrl('annamiller'), 'https://www.linkedin.com/in/annamiller/recent-activity/comments/');
});

test('infers comment and reaction engagement types', () => {
  assert.equal(inferEngagementType('Anna Miller commented on this post'), 'commented');
  assert.equal(inferEngagementType('Anna Miller likes this'), 'reacted');
  assert.equal(inferEngagementType('Anna Miller posted this'), 'unknown');
});

test('keeps only commented and reacted candidates and de-duplicates by post id', () => {
  const candidates = normalizeActivityCandidates([
    { text: 'Anna commented on this', postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' },
    { text: 'Anna likes this', postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:2/' },
    { text: 'Anna posted this', postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:3/' },
    { text: 'Anna commented on this again', postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' },
  ], {
    sourceProfileSlug: 'annamiller',
    sourceProfileName: 'Anna Miller',
    activityUrl: 'https://www.linkedin.com/in/annamiller/recent-activity/all/',
  });

  assert.deepEqual(candidates.map(c => [c.postId, c.engagementType]), [
    ['urn:li:activity:1', 'commented'],
    ['urn:li:activity:2', 'reacted'],
  ]);
  assert.equal(candidates[0].sourceType, 'profile_activity');
});

test('normalizes commented LinkedIn job cards without feed permalinks', () => {
  const candidates = normalizeActivityCandidates([
    {
      text: 'Anna Miller commented on this Data Platform Engineer Job by Selby Jennings',
      postUrl: 'https://www.linkedin.com/jobs/view/4423505832/?trackingId=abc',
    },
  ], {
    sourceProfileSlug: 'annamiller',
    sourceProfileName: 'Anna Miller',
    activityUrl: 'https://www.linkedin.com/in/annamiller/recent-activity/comments/',
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].postId, 'linkedin-job:4423505832');
  assert.equal(candidates[0].postUrl, 'https://www.linkedin.com/jobs/view/4423505832/?trackingId=abc');
});
