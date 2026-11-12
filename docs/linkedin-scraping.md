# LinkedIn data collection — research notes

> Status: research from public reverse-engineering write-ups. LinkedIn's internal API is
> undocumented and changes often. Every endpoint here is treated as **best-effort** in code,
> wrapped in try/catch, with a DOM-scrape fallback. Verify against the live site before trusting.

## Why run inside the browser

The single most important design decision. The extension runs as an MV3 background service worker
whose `fetch()` calls to `https://www.linkedin.com/...` are **same-origin from the user's logged-in
session**, so:

- The auth cookies (`li_at`, `JSESSIONID`) are attached **automatically** by Chrome. We never read,
  store, or transmit `li_at`. The pitch's "scrape LinkedIn credentials" is neither needed nor done.
- Author-only analytics (impressions, unique views, demographics) are visible **only** to the post
  owner. A central external scraper can't see them; the owner's own browser can. This is the whole
  reason the extension approach beats the status-quo scraper.

The one header we must set manually is the CSRF token (see below); cookies handle the rest.

## Auth headers

Voyager rejects requests without the CSRF token. Derivation:

```
csrf-token = value of the JSESSIONID cookie with surrounding double-quotes stripped
```

`JSESSIONID` is **not** httpOnly, so a content script can read it via `document.cookie`; from the
service worker we read it with `chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' })`.

Standard header set for Voyager requests:

```
csrf-token: <JSESSIONID without quotes>
x-restli-protocol-version: 2.0.0
x-li-lang: en_US
accept: application/vnd.linkedin.normalized+json+2.1
```

(`Host` matters only for non-browser clients; the browser sets it. Same for `user-agent`.)

## Response shape

Voyager returns a normalized envelope: a top-level `data` object plus a flat `included[]` array of
every referenced entity. You resolve references by matching `entityUrn`. Practically: scan
`included[]` for the entity type you want (e.g. an item whose `$type` or `entityUrn` matches).

## Endpoints (best-known, verify live)

REST endpoints under `https://www.linkedin.com/voyager/api/`:

| Purpose | Endpoint | Key response fields |
|---|---|---|
| Current member | `GET /me` | `miniProfile.entityUrn` (member URN), `publicIdentifier` |
| Profile (dash) | `GET /identity/dash/profiles?q=memberIdentity&memberIdentity={publicId}&decorationId=...FullProfileWithEntities-93` | `firstName`, `lastName`, `headline` |
| Follower/network count | `GET /identity/profiles/{publicId}/networkinfo` | `followersCount`, `connectionsCount` |
| Member's posts | `GET /identity/profileUpdatesV2?profileUrn={urn}&q=memberShareFeed&count=20&start=0` | share/ugcPost URNs, commentary text, `socialDetail` counts (reactions/comments/reposts) |

Newer surfaces are GraphQL: `GET /voyager/api/graphql?queryId={id}&variables=(...)`. The `queryId`
(e.g. `voyagerFeedDashProfileUpdates.*`, `voyagerPremiumDashAnalyticsObject.*`) is baked into
LinkedIn's JS bundles and **rotates with releases**, so it can't be hard-coded reliably.

### Author-only post analytics

The rich analytics (impressions, unique viewers, member demographics) come from a creator-analytics
GraphQL surface, keyed by the post's URN and a rotating `queryId`
(`voyagerPremiumDashAnalytics*` / `voyagerFeedDashCreatorAnalytics*`). Because the `queryId`
rotates, the robust path is:

1. **Primary:** hit the GraphQL analytics endpoint with a `queryId` we discover at runtime
   (see below).
2. **Fallback:** open/scrape the post's analytics page DOM
   (`https://www.linkedin.com/analytics/post-summary/urn:li:activity:{id}/` or the
   `/feed/update/.../analytics` view) and read the numbers off the rendered page.

### Runtime queryId discovery

Rather than hard-code IDs that break weekly, discover them from the live page:

- The service worker can fetch a LinkedIn page's HTML/JS and regex out the current
  `voyager*Analytics*` / `voyager*ProfileUpdates*` queryIds, cache them, and refresh on 4xx.
- Or a content script injected on linkedin.com reads them from the loaded app config
  (`window` globals / bundle) and messages them to the worker.

This keeps the fragile part in one place and self-healing.

## Metrics we collect

Per **profile snapshot** (a few times/day): `followerCount`, `profileViews` (from the "who viewed
your profile" / WVMP surface, author-only), timestamp.

Per **post**: URN, permalink, created time, text preview. Per **post snapshot**: `impressions`
(author-only), `reactions`, `comments`, `reposts`. Reactions/comments/reposts are in the public
`socialDetail`; impressions require the analytics surface above.

## Etiquette / risk controls (baked into the extension)

- Low cadence: default every ~6 hours via `chrome.alarms`, with random jitter.
- Own data only; read-only; never posts, likes, or messages on the user's behalf.
- Sequential requests with small delays; back off on 429/401.
- Posts older than four weeks are not re-read once recorded (no analytics or comments requests);
  see "Refresh window" in `docs/sync-protocol.md`.
- On repeated 401, surface "please reopen LinkedIn / re-login" in the popup rather than hammering.
- All fragile endpoint logic isolated in `extension/linkedin.js` so a LinkedIn change is a
  one-file fix.

## Sources
- LinkedIn Dev Notes (joshuatz): https://github.com/joshuatz/linkedin-to-jsonresume/blob/main/docs/LinkedIn-Dev-Notes-README.md
- Voyager profile scraper walkthrough: https://iron-mind.ai/blog/linkedin-profile-scraper-python-voyager-api
- Voyager API guide (Idehen): https://medium.com/@Scofield_Idehen/linkedin-voyager-api-the-ultimate-developers-guide-08b200fef494
- Community Voyager client: https://github.com/nsandman/linkedin-api
