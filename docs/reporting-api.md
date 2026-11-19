# Reporting API

Instructions for an AI agent (or a script) that reads the company posting challenge's data.
Hand this whole file to the agent along with an API key. There is no database access: this HTTP
API is the interface, and it is read-only: nothing can be created, changed or deleted with it.

The site serves this file, without a key, at `/api/v1/docs`. Every path below is relative to the
address of the site this document came from; the examples call it `$BASE` (for example, if you
fetched `https://challenge.example.com/api/v1/docs`, `BASE` is `https://challenge.example.com`).

## What it is for

Everyone in the challenge syncs their LinkedIn posts and each post's numbers (impressions,
reactions, comments and so on) to Challenge Sync through a browser extension. Three endpoints:

- `GET /api/v1/posts`: everyone's posts from a period, optionally filtered, plus who posted.
- `GET /api/v1/members`: every account and when its extension last synced, plus a summary to
  spot a stall.
- `GET /api/v1/stats`: the company overview for the past 7, 30 or 90 days: posts, people who
  posted, impressions gained, a daily or weekly series, and the top posters and posts. The same
  numbers as the website's landing page.

Typical questions from a member's own assistant:

- Which of my posts did best over the past few months, and what do they have in common? Draft a
  new post in the same voice.
- What do this month's top posts across the company (by reactions, comments or engagement rate)
  have in common: topic, opening line, length, format, time of posting?
- How did my week go compared with last week?

Typical weekly questions from the organisers:

- Which original posts from Friday through Thursday (Mountain time) mention Enzo, and which of
  them passed 3,000 out-of-network impressions?
- Who posted this week, and how many times?
- Who posted but is not syncing (for example a new hire without the extension)? Has syncing
  stalled for everyone?

For admins, the posts report is also on the website under **System → Post reports**, with an
Export CSV button.

## Getting a key

Every member can make their own key:

1. Sign in to the site and open **API keys** in the sidebar.
2. Type a name (for example "Claude on my laptop") and press **Create key**.
3. Copy the key straight away. It starts with `csk_` and is shown only once; only a hash is kept.

The same page lists your keys, when each was last used, and revokes them. You can hold up to 5
at once.

A key can read everyone's post data, so treat it like a password. Revoke it when it is no longer
needed and it stops working at once. It also stops working if its owner's account is deleted.
Admins can see and revoke every key under **System → Post reports**, and can make keys there too;
a key an admin makes there stops working if they stop being an admin.

## Authentication and errors (every endpoint)

```
Authorization: Bearer csk_...
```

Send the key on every request. Sync tokens from the browser extension (`st_...`) are not API keys
and are refused, and a key is refused everywhere except the three `GET /api/v1/...` endpoints
below. Every error is JSON, `{"error": "message"}`:

- `401`: missing, wrong or revoked key.
- `400`: a parameter is not valid. The message says which.
- `404`: only from `/api/v1/stats` with a `memberId` that does not exist.
- `429`: the key has made too many requests this minute (below). The body also has
  `"code": "rate_limited"`.

### Rate limit

Each key may make **120 requests per minute**, counted per clock minute (UTC) across all three
endpoints. Request 121 in a minute is refused with `429` and a `Retry-After` header giving the
seconds until the next minute starts; the error message says the same. Wait that long and carry
on. One request returns a whole period (up to 366 days) at once, so a well-behaved agent rarely
needs more than a few requests per question: prefer one wide request over many narrow ones.

## GET /api/v1/posts

```
GET $BASE/api/v1/posts
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
| `sort` | see below | Order of `posts`: `impressions`, `impressionsOutOfNetwork`, `reactions`, `comments`, `reposts`, `sends`, `saves`, `engagementRate` (each highest first), `newest` or `oldest`. |
| `limit` | every post | Return only the first this many posts (1 to 500) after sorting. |
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

### Sorting and the top posts

- Without `sort`, posts are sorted by out-of-network impressions when `minOutOfNetworkImpressions`
  is set, otherwise by impressions. `sortedBy` in the response names the order used.
- Every number sorts highest first, and **posts whose number is unknown sort last**. Ties go to
  the newer post.
- `limit` keeps the first posts after sorting, so `sort=reactions&limit=10` is the ten
  most-reacted posts of the period. `postCount` is how many were returned and
  `matchingPostCount` how many passed the filters; the `authors` summary always counts every
  matching post, not only the returned ones.
- `engagementRate` is `(reactions + comments) / impressions` (the site's "engagement" is reactions
  plus comments), rounded to 4 decimals: `0.0153` is 1.53%. It is `null` when any of the three is
  unknown or impressions is 0, and such posts sort last. A post seen by very few people can have a
  high rate by chance, so pair `sort=engagementRate` with a minimum such as `minImpressions=500`.
- To compare posts by people with very different audiences, use `authorFollowers` (below)
  alongside impressions.

Examples: the past 30 days' ten most-reacted posts is
`?since=<30 days ago>&sort=reactions&limit=10`; one person's best posts of the past six months is
`?since=<180 days ago>&memberId=14&sort=impressions&limit=20`.

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
    "includeReposts": false,
    "sort": null,
    "limit": null
  },
  "timezone": "-07:00",
  "sortedBy": "impressionsOutOfNetwork",
  "postCount": 1,
  "matchingPostCount": 1,
  "posts": [
    {
      "postId": 812,
      "memberId": 14,
      "authorName": "Ada Ortiz",
      "authorProfileUrl": "https://www.linkedin.com/in/ada-ortiz/",
      "authorPublicIdentifier": "ada-ortiz",
      "authorDeleted": false,
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
      "engagementRate": 0.0181,
      "authorFollowers": 2310,
      "authorFollowersReadAt": "2026-11-12T18:00:40Z",
      "metricsCapturedAt": "2026-11-13T09:00:12Z"
    }
  ],
  "authors": [
    {
      "memberId": 14,
      "displayName": "Ada Ortiz",
      "profileUrl": "https://www.linkedin.com/in/ada-ortiz/",
      "publicIdentifier": "ada-ortiz",
      "deleted": false,
      "postsInPeriod": 3,
      "matchingPosts": 1
    },
    {
      "memberId": 20,
      "displayName": "Ben Cho",
      "profileUrl": null,
      "publicIdentifier": "ben-cho",
      "deleted": false,
      "postsInPeriod": 2,
      "matchingPosts": 0
    }
  ]
}
```

- `posts`: the posts that passed every filter, in the order `sortedBy` names (see "Sorting and
  the top posts"), cut to `limit` if one was given.
- `filters.sort` and `filters.limit` echo what was asked for, `null` when not given.
- `postedAt` is UTC; `postedAtLocal` is the same moment in `timezone`.
- `text`: the post's full text as synced, or `null` if it could not be read.
- Any number can be `null`, meaning LinkedIn's figure was never read. That is not the same as 0.
- `engagementRate`: see "Sorting and the top posts".
- `authorFollowers`: the author's LinkedIn follower count from the reading of their profile taken
  nearest to when the post was published, before or after; `authorFollowersReadAt` is when that
  reading was taken, so you can judge how close it is to `postedAt`. Both `null` if the author's
  followers were never read. Profiles are read whenever the author's extension syncs, so for a
  post published before the author started syncing the nearest reading can be some time later.
- `authors`: **everyone who posted in the period** (original posts only, unless
  `includeReposts=true`), whether or not their posts passed the filters. `postsInPeriod` counts all
  their posts in the period; `matchingPosts` counts the ones in `posts`. Sorted by
  `matchingPosts`, then `postsInPeriod`, highest first. People who did not post at all are not
  listed: use `/api/v1/members` for everyone.
- `authorDeleted` (on a post) and `deleted` (on an author): `true` when an admin has since deleted
  that person's account, usually because they left the company. Their posts **stay in the report**
  for the period they were published in, so a past week's numbers and winners do not change after
  someone leaves; filter on this flag if a draw should only include current staff. Deleted
  accounts are left out of `/api/v1/members`.

### CSV response

`format=csv` returns the same posts, in the same order and cut to the same `limit` (not the
`authors` list, and not `engagementRate` or the follower fields), as a download named after the first
and last day of the period in `timezone`, like `posts-2026-11-06-to-2026-11-12.csv`, with this
header row:

```
posted_date,posted_at_utc,posted_at_local,author_name,author_member_id,author_profile_url,post_url,impressions,impressions_in_network,impressions_out_of_network,reactions,comments,reposts,sends,saves,is_repost,text,author_deleted
```

`posted_date` is the day in `timezone`. `author_deleted` is `true` or `false`, as `authorDeleted`
above; it is the last column so that columns read by position before it was added still line up.
Standard CSV: fields with commas, quotes or line breaks are
quoted, so a multi-line post is one cell holding the full text. Unknown numbers are empty cells.
The file starts with a UTF-8 byte order mark so Excel shows accents and emoji correctly. Text that
starts with `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet does not run it as a
formula.

## GET /api/v1/members

```
GET $BASE/api/v1/members
```

One parameter: `format` (`json` by default, or `csv`). Every account, sorted by name, with no
emails. Accounts an admin has deleted are left out, here and in every `sync` figure: they can no
longer sync, so counting them would look like a stall.

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

## GET /api/v1/stats

```
GET $BASE/api/v1/stats?days=7&timezone=-07:00
```

The company overview the website shows on its landing page, for the past `days` days (today
included), each number next to the same number for the `days` days just before.

### Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `days` | `7` | `7`, `30` or `90`. Anything else is a `400`. |
| `timezone` | `+00:00` | Fixed UTC offset the days are read in, as for `/api/v1/posts`: `-07:00` for Mountain standard time, `-06:00` in summer. |
| `memberId` | none | Also return this member's own share of every number as `you` (ids come from `/api/v1/members`). Without it `you` is `null`. |

### What the numbers mean

- **posts**: original posts published in the period (reshares are never counted).
- **people**: how many different people published those posts; `activeMembers` is every
  account that has not been deleted.
- **impressions**: impressions **gained** during the period by every original post, whenever it
  was published, not the totals of the posts published in the period. For each post: the last
  number read before the period ended, minus the last number read before it began (0 if the post
  was first read during the period), never below 0. Posts published more than 45 days before the
  period began are left out: the extension stops re-reading a post 45 days after it went up.
- **outOfNetworkImpressions** and **engagement** (reactions plus comments) are gained the same way.
- `previous` is the same number for the period just before; `change` is
  `(value - previous) / previous` (0.12 means +12%), or `null` when `previous` is 0.
- `series` has one entry per day for 7 and 30 days and per week for 90 days (the last week is
  6 days). Each column adds up to the headline number. A gain is counted on the day the reading
  that showed it was taken, so a quiet day in the extension means a bigger next day.
- Deleted accounts still count in every number (a past week does not change when someone
  leaves), but in `topPosters` and `topPosts` they are named `"Former member"` with
  `memberId: null`.
- `sync.stale` is `true` when nobody has synced for more than two days: the numbers have
  stopped moving, not dropped to zero.

### JSON response

Values below are made up.

```json
{
  "period": {
    "days": 7, "bucket": "day",
    "since": "2026-11-06T00:00:00-07:00", "until": "2026-11-12T23:59:59-07:00",
    "timezone": "-07:00", "startUnix": 1793948400, "endUnix": 1794553200,
    "previousStartUnix": 1793343600
  },
  "company": {
    "posts": { "value": 23, "previous": 18, "change": 0.2778 },
    "people": { "value": 14, "previous": 12, "change": 0.1667 },
    "activeMembers": 61,
    "impressions": { "value": 48210, "previous": 39900, "change": 0.2083 },
    "outOfNetworkImpressions": { "value": 17400, "previous": 0, "change": null },
    "engagement": { "value": 1312, "previous": 1450, "change": -0.0952 }
  },
  "you": {
    "memberId": 14, "displayName": "Ada Ortiz", "posted": true, "hasSynced": true,
    "posts": { "value": 3, "previous": 1, "change": 2.0 },
    "impressions": { "value": 9120, "previous": 4000, "change": 1.28 },
    "outOfNetworkImpressions": { "value": 4250, "previous": 0, "change": null },
    "engagement": { "value": 165, "previous": 80, "change": 1.0625 },
    "shareOfPosts": 0.1304, "shareOfImpressions": 0.1892,
    "shareOfOutOfNetworkImpressions": 0.2443, "shareOfEngagement": 0.1258,
    "rank": 2, "posterCount": 14
  },
  "series": [
    {
      "start": "2026-11-06T00:00:00-07:00", "startUnix": 1793948400, "days": 1,
      "company": { "posts": 4, "impressions": 6100, "outOfNetworkImpressions": 2010, "engagement": 190 },
      "you": { "posts": 1, "impressions": 800, "outOfNetworkImpressions": 300, "engagement": 21 }
    }
  ],
  "topPosters": [
    { "rank": 1, "memberId": 20, "displayName": "Ben Cho", "formerMember": false, "isYou": false,
      "posts": 4, "impressionsGained": 5300 },
    { "rank": 2, "memberId": 14, "displayName": "Ada Ortiz", "formerMember": false, "isYou": true,
      "posts": 3, "impressionsGained": 9120 },
    { "rank": 3, "memberId": null, "displayName": "Former member", "formerMember": true, "isYou": false,
      "posts": 3, "impressionsGained": 7000 }
  ],
  "topPosts": [
    { "postId": 812, "memberId": 14, "authorName": "Ada Ortiz", "formerMember": false, "isYou": true,
      "postUrl": "https://www.linkedin.com/feed/update/urn:li:activity:7392000000000000000/",
      "firstLine": "Three things I learned shipping prior auth at Enzo this year...",
      "postedAt": "2026-11-10T16:00:00Z", "postedAtUnix": 1794326400,
      "impressionsGained": 6400, "impressions": 9120 }
  ],
  "sync": { "lastSyncAt": "2026-11-12T15:02:11Z", "lastSyncAtUnix": 1794500531, "stale": false }
}
```

- `series[].you` and `isYou` refer to the `memberId` asked for; without one they are `null` and
  `false`.
- `topPosters`: up to 10 people, most posts first, then most impressions gained (on all their
  posts, not only the new ones). `you.rank` is the same order over everyone who posted.
- `topPosts`: up to 10 posts that gained the most impressions in the period, whenever published.
  `impressions` is the post's latest known total.

## Examples

Set the key once:

```sh
export CHALLENGE_API_KEY='csk_...'
BASE=https://challenge.example.com   # the site this document came from
```

The ten posts with the most reactions over the past 30 days, with their text:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "$BASE/api/v1/posts?since=$(date -u -d '29 days ago' +%F)&sort=reactions&limit=10" \
  | jq -r '.posts[] | "\(.reactions) reactions, \(.authorName): \(.text)"'
```

The highest engagement rates among posts seen at least 500 times this month:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "$BASE/api/v1/posts?since=$(date -u +%Y-%m-01)&sort=engagementRate&minImpressions=500&limit=10"
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

This week in numbers, compared with last week, in Mountain time:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" "$BASE/api/v1/stats?timezone=-07:00" \
  | jq '.company | {posts, people, impressions}'
```

One person's share over the past 30 days:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" "$BASE/api/v1/stats?days=30&memberId=14" | jq .you
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
- Do not retry a `401` with the same key: it was revoked or its owner's account was closed. Ask the
  person who gave it to you to make a new one on their **API keys** page.
- On a `429`, wait the `Retry-After` seconds and carry on; do not retry in a tight loop.

## Helping someone write

Members connect their own assistant mostly to learn from what works and to write better posts.

- **Their own voice first.** To write like the member, read their own best posts
  (`memberId=<theirs>&sort=impressions`, a few months back) and copy their tone, structure and
  length, not someone else's.
- **Learn from others, do not imitate them.** Colleagues' top posts are for patterns (topics, hooks,
  length, format, timing), never for copying their text or writing as if you were them.
- **Compare fairly.** Raw impressions favour people with big audiences; look at `engagementRate`
  (with a minimum number of impressions) and `authorFollowers` before concluding that something
  works.
- **Say what the data can and cannot show.** A handful of posts is not a trend, and numbers keep
  growing for weeks after a post goes up, so a post from yesterday is not comparable with one from
  last month.
