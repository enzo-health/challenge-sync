# Sync protocol — extension ⇄ server

The contract both the extension and the server implement. JSON over HTTPS. All timestamps ISO-8601
UTC. Follower-only/author-only metrics may be `null` when unavailable.

## 1. Link (redeem invite, get sync token)

The extension first reads the member's own LinkedIn identity, then redeems the invite. This binds
the install to a real `User` at link time.

```
POST /api/link
Content-Type: application/json

{
  "inviteCode": "AB12-CD34",
  "member": {
    "memberUrn": "urn:li:fsd_profile:ACoAAB...",   // stable per LinkedIn account
    "publicIdentifier": "drew-example",
    "firstName": "Drew",
    "lastName": "Example",
    "profileUrl": "https://www.linkedin.com/in/drew-example/"
  }
}
```

Response `200`:

```
{
  "syncToken": "st_9f2c...",     // bearer token, store in extension, used for all /api/sync
  "orgName": "Acme Inc",
  "displayName": "Drew Example"
}
```

Errors: `404` unknown/expired/used invite code; `409` this member already linked in the org
(returns the existing token so re-linking is idempotent).

## 2. Sync (upload a snapshot batch)

```
POST /api/sync
Authorization: Bearer st_9f2c...
Content-Type: application/json

{
  "capturedAt": "2026-08-08T12:00:00Z",
  "profile": {
    "followerCount": 1234,
    "profileViews": 56              // author-only; null if not collected this run
  },
  "postFeedComplete": true,          // legacy: page under-full AND every post on it is in `posts`
  "completePostFeedUrns": ["urn:li:activity:7231000000000000000"], // page under-full: every URN on it
  "excludedPostUrns": [],            // reshared originals nested in the feed; not this member's
  "posts": [
    {
      "urn": "urn:li:activity:7231000000000000000",
      "permalink": "https://www.linkedin.com/feed/update/urn:li:activity:7231000000000000000/",
      "createdAt": "2026-08-01T09:00:00Z",
      "textPreview": "We just shipped ...",   // <= 10,000 Unicode characters
      "imageUrls": ["https://media.licdn.com/..."], // attached images; empty when none
      "metrics": {
        "impressions": 3400,        // author-only; null if unavailable
        "reactions": 45,
        "comments": 12,
        "reposts": 3
      },
      "comments": [                 // who commented; [] means "didn't read them", not "none"
        {
          "urn": "urn:li:comment:(urn:li:activity:7231000000000000000,7231000000000000001)",
          "commenterUrn": "urn:li:fsd_profile:ACoAAB...",
          "commenterName": "Sam Example",
          "createdAt": "2026-08-02T10:00:00Z",
          "isReply": false          // true inside a thread (a reply to a comment)
        }
      ]
    }
  ]
}
```

### Refresh window

The extension reads the member's latest 30 posts in one feed request, then spends one or two more
requests per post on author analytics and comments. Posts older than `REFRESH_WINDOW_DAYS` (45,
`extension/config.js`; the lottery needs reach kept current for at least 30 days), measured from
`createdAt` at sync time, are not re-read once the server has them:

- They are left out of `posts`, so the server writes no new snapshot and the last full reading
  taken before the cutoff stays the one scoring reads. Nothing about them changes on the server.
- "Once the server has them" is per install: the extension remembers which URNs from the feed page
  the server accepted (`recordedPosts` in `chrome.storage.local`, keyed by LinkedIn member). An old
  post it has not delivered yet, such as a new member's history, is read in full once. A second
  device or a reinstall re-reads old posts once, which costs requests but loses nothing.
- A post with no readable `createdAt` is always refreshed.

Leaving posts out must not look like deleting them. Deletion reconciliation (removing stored posts
LinkedIn no longer returns, for deleted-and-reposted posts) only runs on an under-full feed page:

- `completePostFeedUrns`, sent only for an under-full page, lists every post on it, refreshed or
  not. The server keeps any stored post named there or in `posts` and removes the rest.
- `postFeedComplete` keeps its original meaning, "absence from `posts` means deleted", so the
  extension sends it as true only when it left nothing out. A server that predates
  `completePostFeedUrns` ignores that field; with `postFeedComplete` false it deletes nothing and
  only skips reconciliation until it is updated.
- An extension that predates the window sends every post and only `postFeedComplete`, which the
  server handles as before.

Comments are read from the server-rendered post page (`/feed/update/urn:li:activity:{id}/`) —
every Voyager comments endpoint answers 400/404 now. Each rendered comment carries its URN, the
commenter's profile link, and a label naming them, so `commenterUrn` is a
`urn:li:publicIdentifier:…` and `createdAt` is null. The page renders only the first several
comments, so the list is a sample, never a count. The server stores each comment once by URN and
marks `isSelf` when the commenter matches the post's author by URN id or public identifier.
Scoring uses LinkedIn's `metrics.comments` total minus the author's own comments seen.

The follower count comes from `GET /voyager/api/feed/dash/followingStates?ids=List(urn:li:fsd_followingState:urn:li:fsd_profile:{id})`,
keyed by the member's own profile id. The post feed's `FollowingInfo` entities belong to *other*
actors on the page and must never be used for it. `just test-extension-e2e` proves both against
a live session.

Response `200`:

```
{ "ok": true, "postsIngested": 1, "nextSyncAfterSeconds": 21600 }
```

Errors: `401` bad/expired token.

## Server-side handling

- The server records `capturedAt` from the client but also stamps its own `receivedAt` and uses the
  server clock for windowing decisions (clients can lie / be skewed).
- Each sync writes one `ProfileSnapshot` and one `PostSnapshot` per post in `posts` (append-only,
  time series). Posts left out for the refresh window get nothing new.
- `Post` rows are upserted by `(user, urn)`; snapshots are always inserted.
- Scores are computed from snapshots at read time — the ingest never computes score.


## Validation targets

Real values from one account (2026-08-09), for checking the scrapers produce sane numbers rather
than plausible-looking ones:

| Metric | Actual | Where the user sees it |
|---|---|---|
| Followers | 945 | Profile → followers, under activity |
| Profile views | 672 | Analytics |
| Post impressions (all posts) | 19,833 | Analytics |
| Search appearances | 53 | Analytics |

Followers are collected from `feed/dash/followingStates` keyed by the `fsd_followingState` URN
(the bare `fsd_profile` form answers 400, which is why this was once thought dead). Profile views
are **not currently collected**: `networkinfo`, `profileView`, and `wvmpCards` answer 410.
