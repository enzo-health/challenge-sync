# Reporting API

Instructions for an AI agent (or a script) that reads the company posting challenge's post data.
Hand this whole file to the agent along with an API key.

## What it is for

Everyone in the challenge syncs their LinkedIn posts and each post's numbers (impressions,
reactions, comments and so on) to Challenge Sync. This API returns everyone's posts from a period,
optionally filtered, plus a list of who posted. Typical weekly questions:

- Which posts in the past week had more than 3,000 out-of-network impressions?
- Which posts in the past week mention Enzo?
- Who posted this week, and how many times?

The same report is on the website under **System → Post reports**, with an Export CSV button.

## Getting a key

1. An admin signs in at https://social-challenge.enzo.health and opens **Post reports** in the
   sidebar (admins only).
2. Under **API keys**, type a name (for example "Jason's agent") and press **Create key**.
3. Copy the key straight away. It starts with `csk_` and is shown only once; only a hash is kept.

The key can read everyone's post data, so treat it like a password. Revoke it on the same page when
it is no longer needed, and it stops working at once. A key also stops working if the admin who
created it is no longer an admin.

## The endpoint

```
GET https://social-challenge.enzo.health/api/v1/posts
Authorization: Bearer csk_...
```

Read-only. Send the key in the `Authorization` header on every request. Sync tokens from the
browser extension (`st_...`) are not API keys and are refused.

### Parameters

All are optional query parameters.

| Parameter | Default | Meaning |
|---|---|---|
| `since` | six days before `until` | First day included, `YYYY-MM-DD`. |
| `until` | today | Last day included, `YYYY-MM-DD`. |
| `minImpressions` | none | Only posts with at least this many impressions. |
| `minOutOfNetworkImpressions` | none | Only posts with at least this many out-of-network impressions. |
| `contains` | none | Only posts whose text contains this, ignoring case. |
| `memberId` | everyone | Only this person's posts (their `memberId` from a previous response). |
| `format` | `json` | `json`, or `csv` for a spreadsheet. |

How they behave:

- **Days are UTC calendar days, and both ends are included.** With no dates, the period is today
  (UTC) and the six days before it: seven days. Asking on the same weekday each week gives weeks
  that neither overlap nor leave a gap. A post counts in the period by when it was published on
  LinkedIn. A period can be at most 366 days.
- **Minimums are "at least"**: `minOutOfNetworkImpressions=3000` keeps a post with exactly 3,000.
  Use 3001 if it must be strictly more.
- **An unknown number never meets a minimum.** LinkedIn's out-of-network figure comes from the
  author's post analytics, which the extension cannot always read. Such a post has
  `impressionsOutOfNetwork: null` and is left out whenever `minOutOfNetworkImpressions` is set.
- **`contains` is a plain substring match ignoring case**: `contains=enzo` finds "Enzo", "ENZO"
  and "enzo.health". It is not a word search ("enzos" matches too). A post whose text was never
  read does not match. Encode spaces as `%20` or `+`, or use curl's `-G --data-urlencode`.
- Several filters together must all hold.
- Numbers are each post's latest reading (posts are re-read every few hours while they are under
  four weeks old). Reposts (someone resharing a post) are included, as the challenge's scoring
  includes them, and marked `isRepost: true`.

### Errors

Every error is JSON: `{"error": "message"}`.

- `401`: missing, wrong or revoked key.
- `400`: a parameter is not valid (a date that is not `YYYY-MM-DD`, `since` after `until`, a
  non-numeric or negative minimum, an unknown `format`). The message says which.

### JSON response

Values below are made up.

```json
{
  "filters": {
    "since": "2026-11-06",
    "until": "2026-11-12",
    "minImpressions": null,
    "minOutOfNetworkImpressions": 3000,
    "memberId": null,
    "contains": "enzo"
  },
  "timezone": "UTC",
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
      "postedAt": "2026-11-10T14:03:00Z",
      "postedAtUnix": 1794405780,
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
      "metricsCapturedAt": "2026-11-12T09:00:12Z"
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
- `text`: the post's full text as synced, or `null` if it could not be read.
- Any number can be `null`, meaning LinkedIn's figure was never read. That is not the same as 0.
- `metricsCapturedAt`: when the numbers were read; `null` if never.
- `authors`: **everyone who posted in the period**, whether or not their posts passed the
  filters. `postsInPeriod` counts all their posts in the period; `matchingPosts` counts the ones
  in `posts`. Sorted by `matchingPosts`, then `postsInPeriod`, highest first. People who did not
  post at all in the period are not listed.

### CSV response

`format=csv` returns the same posts (not the `authors` list) as a download named like
`posts-2026-11-06-to-2026-11-12.csv`, with this header row:

```
posted_date,posted_at_utc,author_name,author_member_id,author_profile_url,post_url,impressions,impressions_in_network,impressions_out_of_network,reactions,comments,reposts,sends,saves,is_repost,text
```

Standard CSV: fields with commas, quotes or line breaks are quoted, so a multi-line post is one
cell holding the full text. Unknown numbers are empty cells. The file starts with a UTF-8 byte
order mark so Excel shows accents and emoji correctly. Text that starts with `=`, `+`, `-` or `@`
is prefixed with `'` so a spreadsheet does not run it as a formula.

## Examples

Set the key once:

```sh
export CHALLENGE_API_KEY='csk_...'
```

Posts in the past week with over 3,000 out-of-network impressions:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "https://social-challenge.enzo.health/api/v1/posts?minOutOfNetworkImpressions=3000"
```

Posts in the past week that mention Enzo with over 3,000 out-of-network impressions:

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "https://social-challenge.enzo.health/api/v1/posts?contains=enzo&minOutOfNetworkImpressions=3000"
```

Who posted this week (read `authors`; `postsInPeriod` is how many times each person posted):

```sh
curl -sS -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "https://social-challenge.enzo.health/api/v1/posts" \
  | jq -r '.authors[] | "\(.displayName): \(.postsInPeriod)"'
```

A specific week, as a spreadsheet:

```sh
curl -sS -OJ -H "Authorization: Bearer $CHALLENGE_API_KEY" \
  "https://social-challenge.enzo.health/api/v1/posts?since=2026-11-02&until=2026-11-08&format=csv"
```

(`-OJ` saves the file under the server's name, here `posts-2026-11-02-to-2026-11-08.csv`.)

## Notes for an agent

- "This week" or "the past week" means the default period: pass no dates. For a calendar week,
  pass `since` (the Monday) and `until` (the Sunday).
- To answer "who posted", use `authors` from a request with no minimums and no `contains`.
- To answer "who posted about Enzo", use `contains=enzo` and read `authors[].matchingPosts`.
- Read the `text` before claiming a post is about something: `contains` only checks the letters.
- Do not retry a `401` with the same key; ask an admin for a new one.
