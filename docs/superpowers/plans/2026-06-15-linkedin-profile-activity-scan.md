# LinkedIn Profile Activity Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a popup-triggered scanner that saves relevant job posts from a LinkedIn profile's commented/reacted activity.

**Architecture:** Add pure activity helper functions in `utils/activity.js`, load them from the content script via dynamic import, and reuse the existing `ANALYZE_POST` background pipeline with optional source metadata. The popup mirrors the current auto-scan control with a second scan bar and status listener.

**Tech Stack:** Chrome MV3 extension, vanilla JavaScript ES modules, `chrome.runtime` messaging, Node built-in test runner for pure helpers.

---

### Task 1: Activity Helper Module

**Files:**
- Create: `utils/activity.js`
- Test: `tests/activity.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
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
  ], { sourceProfileSlug: 'annamiller', sourceProfileName: 'Anna Miller', activityUrl: 'https://www.linkedin.com/in/annamiller/recent-activity/all/' });

  assert.deepEqual(candidates.map(c => [c.postId, c.engagementType]), [
    ['urn:li:activity:1', 'commented'],
    ['urn:li:activity:2', 'reacted'],
  ]);
  assert.equal(candidates[0].sourceType, 'profile_activity');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/activity.test.mjs`
Expected: FAIL because `utils/activity.js` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `utils/activity.js` with exported functions for slug extraction, activity URL building, engagement inference, post ID extraction, and candidate normalization.

- [ ] **Step 4: Run tests and verify pass**

Run: `node --test tests/activity.test.mjs`
Expected: PASS.

### Task 2: Content Script Activity Scanner

**Files:**
- Modify: `content/feed-scanner.js`
- Modify: `manifest.json`

- [ ] **Step 1: Add message flow tests by extending helper tests where possible**

Run: `node --test tests/activity.test.mjs`
Expected: PASS before content changes; helper behavior is locked.

- [ ] **Step 2: Load helper module and add scan loop**

In `content/feed-scanner.js`, dynamically import `utils/activity.js`, add `START_ACTIVITY_SCAN`, `STOP_ACTIVITY_SCAN`, and `GET_ACTIVITYSCAN_STATE`, scroll `/recent-activity/all/`, extract visible activity cards into helper candidates, and call `ANALYZE_POST` with source metadata.

- [ ] **Step 3: Expose helper module to content script**

In `manifest.json`, add `utils/activity.js` to `web_accessible_resources.resources`.

- [ ] **Step 4: Verify helper tests still pass**

Run: `node --test tests/activity.test.mjs`
Expected: PASS.

### Task 3: Background Metadata Persistence

**Files:**
- Modify: `background/service-worker.js`

- [ ] **Step 1: Add source metadata to saved job payload**

When `ANALYZE_POST` saves a job, copy `sourceType`, `sourceProfileSlug`, `sourceProfileName`, `engagementType`, and `activityUrl` from payload when present.

- [ ] **Step 2: Verify helper tests still pass**

Run: `node --test tests/activity.test.mjs`
Expected: PASS.

### Task 4: Popup Control And Rendering

**Files:**
- Modify: `popup/popup.html`
- Modify: `popup/popup.js`
- Modify: `popup/popup.css`

- [ ] **Step 1: Add Activity scan UI**

Add a second scan bar with status text and a `Scan Activity` button.

- [ ] **Step 2: Wire popup messages**

Find a LinkedIn profile/activity tab, inject the content script if needed, start/stop activity scanning, and listen for `ACTIVITYSCAN_STATUS`.

- [ ] **Step 3: Show source metadata in detail view**

Append activity source details to `detail-meta` when a job has `sourceType === 'profile_activity'`.

- [ ] **Step 4: Verify syntax and helper tests**

Run: `node --test tests/activity.test.mjs`
Expected: PASS.

### Task 5: Manual Browser Verification

**Files:**
- No file changes expected.

- [ ] **Step 1: Reload extension manually if needed**

Load the unpacked extension from this workspace in Chrome.

- [ ] **Step 2: Open Anna Miller profile**

Use `https://www.linkedin.com/in/annamiller/`.

- [ ] **Step 3: Open popup and start activity scan**

Expected: activity scan status changes to scanning and LinkedIn navigates to `/recent-activity/comments/` if needed.

- [ ] **Step 4: Confirm saved jobs**

Expected: relevant jobs appear in the popup, and detail metadata includes Anna's activity source.
