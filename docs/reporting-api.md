# Reporting API

Instructions for an AI agent (or a script) that reads the company posting challenge's data.
Hand this whole file to the agent along with an API key. There is no database access: this HTTP
API is the interface.

## What it is for

Everyone in the challenge syncs their LinkedIn posts and each post's numbers (impressions,
reactions, comments and so on) to Challenge Sync through a browser extension. Two endpoints:

- `GET /api/v1/posts`: everyone's posts from a period, optionally filtered, plus who posted.
- `GET /api/v1/members`: every account and when its extension last synced, plus a summary to
  spot a stall.

Typical weekly questions:

- Which original posts from Friday through Thursday (Mountain time) mention Enzo, and which of
  them passed 3,000 out-of-network impressions?
- Who posted this week, and how many times?
- Who posted but is not syncing (for example a new hire without the extension)? Has syncing
  stalled for everyone?

The posts report is also on the website under **System → Post reports**, with an Export CSV
button.

## Getting a key

1. An admin signs in at https://social-challenge.enzo.health and opens **Post reports** in the
   sidebar (admins only).
2. Under **API keys**, type a name (for example "Jason's agent") and press **Create key**.
3. Copy the key straight away. It starts with `csk_` and is shown only once; only a hash is kept.

The key can read everyone's post data, so treat it like a password. Revoke it on the same page when
it is no longer needed, and it stops working at once. A key also stops working if the admin who
created it is no longer an admin.

## Authentication and errors (both endpoints)

```
Authorization: Bearer csk_...
```

Send the key on every request. Sync tokens from the browser extension (`st_...`) are not API keys
and are refused. Every error is JSON, `{"error": "message"}`:

- `401`: missing, wrong or revoked key.
- `400`: a parameter is not valid. The message says which.

## GET /api/v1/posts

```
GET https://social-challenge.enzo.health/api/v1/posts
```

### Parameters

All are optional query parameters.

| Parameter | Default | Meaning |
|---|---|---|
| `since` | start of the day six days before `until` | Start of the period, included. A day (`2026-11-06`) or an exact time with an offset (`2026-11-06T00:00:00-07:00`). |
| `until` | end of today | End of the period, included. A day (`2026-11-12`, up to 23:59:59 that day) or an exact time with an offset. |
| `timezone` | `+00:00` (UTC) | A fixed UTC offset such as `-07:00`, `+00:00` or `Z`. Days in `since`/`until` are read in it, and `postedAtLocal` and the CSV's local column are shown in it. |
| `minImpressions` | none | Only posts with at least this many impressions. |
| `minOutOfNetworkImpressions` | none | Only posts with at least this many out-of-network impressions. |
| `contains` | none | Only posts whose text contains this, ignoring case. |
| `includeReposts` | `false` | `true` adds reshares (someone resharing another person's post), flagged `isRepost: true`. By default only original posts are listed and counted. |
| `memberId` | everyone | Only this person's posts (their `memberId` from a previous response). |
| `format` | `json` | `json`, or `csv` for a spreadsheet. |

### The period and time zones

- **`timezone` is an offset, not a zone name.** You pick the offset. Mountain time is **`-07:00`
  in winter** (MST, early November to early March) and **`-06:00` in summer** (MDT, early March to
  early November). Names such as `America/Denver` or `MST` are refused with a 400.
- **A day** means midnight to 23:59:59 in `timezone`. **A timestamp** is that exact instant and
  must carry an offset (`Z` or `±HH:MM`); one without an offset is refused. Both ends are included.
  You can mix the two.
- With no `since`/`until`, the period is today and the six days before it in `timezone`.
- A post is in the period by when it was published on LinkedIn. A period can be at most 366 days.
- Encode `+` in a URL as `%2B` (`timezone=%2B01:00`). An unencoded `+` arrives as a space and is
  still read as `+`, but encoding it is safer.
- The response echoes the exact period covered: `filters.since` and `filters.until` as instants
  in `timezone` (for example `2026-11-06T00:00:00-07:00` and `2026-11-12T23:59:59-07:00`), and
  `filters.timezone`. Check these to confirm the week you meant.

Worked example: the draw on Friday 2026-11-13 covers Friday 2026-11-06 00:00 through Thursday
2026-11-12 23:59:59 Mountain time. November is standard time, so the offset is `-07:00`. These two
requests are the same:

```
/api/v1/posts?since=2026-11-06&until=2026-11-12&timezone=-07:00
/api/v1/posts?since=2026-11-06T00:00:00-07:00&until=2026-11-12T23:59:59-07:00&timezone=-07:00
```

(`timezone` in the second only affects how local times are shown.) For a week in summer, use
`-06:00`. If the week spans a clock change (early March or early November), use exact timestamps
with each end's own offset, for example
`since=2026-10-30T00:00:00-06:00&until=2026-11-05T23:59:59-07:00`.

### Filters

- **Minimums are "at least" (`>=`)**: `minOutOfNetworkImpressions=3000` keeps a post with exactly
  3,000; if the rule is strictly "passes 3,000", ask for `3001`.
- **An unknown number never meets a minimum.** LinkedIn's out-of-network figure comes from the
  author's post analytics, which the extension cannot always read. A post for which it was never
  read has `impressionsOutOfNetwork: null` and is left out whenever `minOutOfNetworkImpressions`
  is set.
- **`contains` is a plain substring match ignoring case**: `contains=enzo` finds "Enzo", "ENZO"
  and "enzo.health". It is not a word search ("enzos" matches too). A post whose text was never
  read does not match. Encode spaces as `%20`, or use curl's `-G --data-urlencode`.
- Several filters together must all hold.

### Which numbers

Posts are re-read every few hours while they are under 45 days old. **Each number is the most
recent value read for it.** If the newest reading missed a number (the analytics read is best
effort and sometimes fails) but an earlier reading had it, the earlier value is used rather than
null. So a post that once read 3,200 out-of-network impressions keeps 3,200, and keeps matching
`minOutOfNetworkImpressions=3000`, even if a later read failed. `metricsCapturedAt` is the time of
the newest reading.

### JSON response

Values below are made up.

```json
{
  "filters": {
    "since": "2026-11-06T00:00:00-07:00",
    "until": "2026-11-12T23:59:59-07:00",
    "timezone": "-07:00",
    "minImpressions": null,
    "minOutOfNetworkImpressions": 3000,
    "memberId": null,
    "contains": "enzo",
    "includeReposts": false
  },
  "timezone": "-07:00",
  "sortedBy": "impressionsOutOfNetwork",
  "postCount": 1,
  "posts": [
    {
      "postId": 812,
      "memberId": 14,
      "authorName": "Ada Ortiz",
      "authorProfileUrl": "https://www.linkedin.com/in/ada-ortiz/",
      "authorPublicIdentifier": "ada-ortiz",
      "postUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7392000000000000000/",
      "postedAt": "2026-11-13T04:30:00Z",
      "postedAtLocal": "2026-11-12T21:30:00-07:00",
      "postedAtUnix": 1794544200,
      "text": "Three things I learned shipping prior auth at Enzo this year...",
      "isRepost": false,
      "impressions": 9120,
      "impressionsInNetwork": 4870,
      "impressionsOutOfNetwork": 4250,
      "reactions": 143,
      "comments": 22,
      "reposts": 6,
      "sends": 3,
      "saves": 11,
      "metricsCapturedAt": "2026-11-13T09:00:12Z"
    }
  ],
  "authors": [
    {
      "memberId": 14,
      "displayName": "Ada Ortiz",
      "profileUrl": "https://www.linkedin.com/in/ada-ortiz/",
      "publicIdentifier": "ada-ortiz",
      "postsInPeriod": 3,
      "matchingPosts": 1
    },
    {
      "memberId": 20,
      "displayName": "Ben Cho",
      "profileUrl": null,
      "publicIdentifier": "ben-cho",
      "postsInPeriod": 2,
      "matchingPosts": 0
    }
  ]
}
```

- `posts`: the posts that passed every filter. Sorted by out-of-network impressions, highest
  first, when `minOutOfNetworkImpressions` is set; otherwise by impressions, highest first. Posts
  with an unknown number sort last.
- `postedAt` is UTC; `postedAtLocal` is the same moment in `timezone`.
- `text`: the post's full text as synced, or `null` if it could not be read.
- Any number can be `null`, meaning LinkedIn's figure was never read. That is not the same as 0.
- `authors`: **everyone who posted in the period** (original posts only, unless
  `includeReposts=true`), whether or not their posts passed the filters. `postsInPeriod` counts all
  their posts in the period; `matchingPosts` counts the ones in `posts`. Sorted by
  `matchingPosts`, then `postsInPeriod`, highest first. People who did not post at all are not
  listed: use `/api/v1/members` for everyone.

### CSV response

`format=csv` returns the same posts (not the `authors` list) as a download named after the first
and last day of the period in `timezone`, like `posts-2026-11-06-to-2026-11-12.csv`, with this
header row:

```
posted_date,posted_at_utc,posted_at_local,author_name,author_member_id,author_profile_url,post_url,impressions,impressions_in_network,impressions_out_of_network,reactions,comments,reposts,sends,saves,is_repost,text
```

`posted_date` is the day in `timezone`. Standard CSV: fields with commas, quotes or line breaks are
quoted, so a multi-line post is one cell holding the full text. Unknown numbers are empty cells.
The file starts with a UTF-8 byte order mark so Excel shows accents and emoji correctly. Text that
starts with `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet does not run it as a
formula.

## GET /api/v1/members

```
GET https://social-challenge.enzo.health/api/v1/members
```

One parameter: `format` (`json` by default, or `csv`). Every account, sorted by name, with no
emails.

```json
{
  "members": [
    {
      "memberId": 14,
      "displayName": "Ada Ortiz",
      "profileUrl": "https://www.linkedin.com/in/ada-ortiz/",
      "publicIdentifier": "ada-ortiz",
      "linked": true,
      "lastSyncedAt": "2026-11-13T09:00:12Z",
      "lastSyncedAtUnix": 1794560412,
      "postCount": 41,
      "newestPostAt": "2026-11-13T04:30:00Z",
      "createdAt": "2026-07-14T16:02:51Z"
    }
  ],
  "sync": {
    "newestSyncAt": "2026-11-13T09:00:12Z",
    "membersSyncedLast24h": 38,
    "membersSyncedLast7d": 44,
    "linkedMembersNeverSynced": 2,
    "totalMembers": 47
  }
}
```

- `linked`: the account has a LinkedIn identity, meaning the extension has signed in at least once.
  `false` for accounts made another way that never connected LinkedIn.
- `lastSyncedAt`: the last successful sync from that person's extension, or `null` if it never
  synced. Every sync updates it, even when no post changed. Extensions sync every few hours while
  the browser is open, so a gap of several days usually means the extension is missing, signed out
  of LinkedIn, or the computer has been off.
- `postCount` and `newestPostAt`: original posts on file and the newest one's publication time.
- `sync.newestSyncAt`: the most recent sync by anyone. If it is many hours old on a working day,
  syncing has stalled for everyone, which is a server or extension problem rather than one person.
- `sync.linkedMembersNeverSynced`: accounts that connected LinkedIn but have never synced.

`format=csv` gives one row per member with the header
`member_id,display_name,public_identifier,profile_url,linked,last_synced_at_utc,post_count,newest_post_at_utc,created_at_utc`,
using the same CSV conventions as above.

## Examples

Set the key once:

```sh
export CHALLENGE_API_KEY='csk_...'
BASE=https://social-challenge.enzo.health
```

Last Friday 00:00 through Thursday 23:59:59 Mountain time (winter), original posts that mention
Enzo and reached at least 3,000 out-of-network impressions:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "$BASE/api/v1/posts?since=2026-11-06&until=2026-11-12&timezone=-07:00&contains=enzo&minOutOfNetworkImpressions=3000"
```

Posts in the past week with over 3,000 out-of-network impressions (3,000 itself counts; use 3001
for strictly over):

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "$BASE/api/v1/posts?timezone=-07:00&minOutOfNetworkImpressions=3000"
```

Who posted this week (read `authors`; `postsInPeriod` is how many original posts each person made):

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "$BASE/api/v1/posts?timezone=-07:00" \
  | jq -r '.authors[] | "\(.displayName): \(.postsInPeriod)"'
```

The same week as a spreadsheet:

```sh
curl -sS -OJ -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "$BASE/api/v1/posts?since=2026-11-06&until=2026-11-12&timezone=-07:00&format=csv"
```

(`-OJ` saves the file under the server's name, here `posts-2026-11-06-to-2026-11-12.csv`.)

Who has not synced in the last 2 days (or ever):

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" "$BASE/api/v1/members" \
  | jq -r --argjson cutoff "$(( $(date +%s) - 2*86400 ))" \
      '.members[] | select(.lastSyncedAtUnix == null or .lastSyncedAtUnix < $cutoff)
       | "\(.displayName)\t\(.lastSyncedAt // "never")"'
```

Is syncing stalled? Read `.sync.newestSyncAt`:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" "$BASE/api/v1/members" | jq .sync
```

## Notes for an agent

- The weekly draw (Friday about 8 AM Mountain) covers original posts from the previous Friday
  00:00 through Thursday 23:59:59 Mountain time: pass those two days with `timezone=-07:00` in
  winter or `-06:00` in summer, and check `filters.since`/`filters.until` in the response.
- Only original posts count, which is the default. Do not pass `includeReposts=true` for the draw.
- The 3,000 out-of-network bonus pays whenever a post gets there, so a post from an earlier week
  can qualify later: ask for a longer period (for example the past 45 days) with
  `minOutOfNetworkImpressions=3000` and compare with the posts already paid.
- Read the `text` before claiming a post is about Enzo or home health: `contains` only checks
  letters, and a post can mention a topic without being about it.
- To find people who posted but are not syncing, compare `authors` from `/api/v1/posts` with
  `lastSyncedAt` from `/api/v1/members`.
- Do not retry a `401` with the same key; ask an admin for a new one.
