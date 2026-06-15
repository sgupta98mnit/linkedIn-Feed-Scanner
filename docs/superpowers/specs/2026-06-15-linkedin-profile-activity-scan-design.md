# LinkedIn Profile Activity Scan Design

## Goal

Add a scanner mode that finds job posts from a LinkedIn profile's recent activity, focused on posts the profile commented on or reacted to, and saves relevant jobs through the existing AI analysis pipeline.

## Scope

The feature runs from the extension popup while the active LinkedIn tab is on a profile or that profile's recent activity page. It targets visible activity feed items and loaded content only. It does not use LinkedIn private APIs, inspect cookies, submit forms, send messages, or perform actions on LinkedIn beyond reading the current page, navigating within the profile's public recent-activity URLs, and scrolling to load more activity.

## User Flow

1. User opens a LinkedIn profile, such as Anna Miller.
2. User opens the extension popup.
3. User clicks `Scan Activity`.
4. The content script navigates the current tab to `/in/<slug>/recent-activity/all/` if needed.
5. The script scrolls through loaded activity items, extracts posts the profile appears to have commented on or reacted to, and submits each candidate to the background worker.
6. The background worker uses the existing AI job classifier.
7. Relevant jobs are saved to the same saved-jobs list.
8. Job details show source activity metadata when available.

## Architecture

The content script owns LinkedIn DOM reading and activity-page scrolling. The background worker keeps the existing `ANALYZE_POST` contract but accepts optional source metadata and stores it on saved jobs. The popup adds a second scan control and listens for a new `ACTIVITYSCAN_STATUS` message type, mirroring the existing feed auto-scan status flow.

## Activity Detection

The scanner infers engagement type from visible activity card text and labels:

- `commented`: card text includes phrases such as "commented on this" or "commented on".
- `reacted`: card text includes phrases such as "liked this", "celebrates this", "supports this", "loves this", "reacted to this", or similar LinkedIn reaction wording.
- `unknown`: a post permalink is present but the engagement text is not definitive.

Only `commented` and `reacted` items are submitted by default. Unknown items may be counted as skipped so the user can see progress without saving unrelated profile posts.

## Data Shape

Saved jobs may include:

- `sourceType`: `profile_activity`
- `sourceProfileSlug`: profile slug from `/in/<slug>/`
- `sourceProfileName`: visible profile name when available
- `engagementType`: `commented` or `reacted`
- `activityUrl`: LinkedIn activity page URL where the item was found

Existing saved jobs without these fields continue to render normally.

## Error Handling

If the active tab is not a LinkedIn profile or recent activity page, the popup reports `Open a LinkedIn profile first`. If the content script is missing because the tab predates extension loading, the popup injects the existing content script and CSS before retrying. Runtime, AI-provider, and profile-configuration errors reuse the existing warning path and status messaging.

## Testing

Add small pure helper functions for activity extraction so they can be tested without LinkedIn. Tests cover:

- profile slug extraction from profile and activity URLs
- activity URL derivation
- engagement-type inference
- candidate extraction and de-duplication from synthetic activity DOM-like objects
- storage of optional source metadata through `ANALYZE_POST`

