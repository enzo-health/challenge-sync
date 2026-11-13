# Challenge Sync — Chrome extension

Runs in a participant's own browser and privately syncs their LinkedIn stats to the challenge
server. It reads **only the signed-in user's own** data (follower count, their posts, and the
author-only analytics like impressions) and uploads it to your company's server. It never reads or
transmits the LinkedIn password, and never posts, likes, or messages on the user's behalf.

## Install (unpacked, for development)

1. Start the server from the repository root with `just dev`.
2. Build the local extension with `just extension-dev`.
3. Open `chrome://extensions` and toggle **Developer mode** (top right).
4. Click **Load unpacked** and select `extension/dist/unpacked/`. Keep using this path so Chrome
   preserves the extension identity and its local storage.
5. Pin the extension and sign in to both the challenge at `http://localhost:3312` and LinkedIn.
6. After changing extension code, rerun `just extension-dev` and click **Reload** on its card.

## How it works

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `alarms`, `cookies` + host access to `linkedin.com`. |
| `background.js` | Service worker. Schedules scrapes via `chrome.alarms`, runs the scrape→upload cycle, answers popup messages. |
| `linkedin.js` | The one fragile module: all LinkedIn/Voyager API calls + parsing. A LinkedIn change is a one-file fix. |
| `sync.js` | Talks to our server through the generated client; maps status codes to human messages. |
| `api.js` | Re-exports the generated client and points its root-relative URLs at the configured server. |
| `errors.js` | Failure categories: what failed (server unreachable, host block, server problem, a coded server refusal, LinkedIn, internal), each with a message and a short code. |
| `generated/nextrs-client/` | **Generated — do not edit.** Typed fetch client produced from the Rust routes through the server's `.nextrs` client configuration. |
| `storage.js` | `chrome.storage.local` wrapper for config + status. No LinkedIn credentials stored. |
| `config.js` | Tunables: default server URL, sync cadence, jitter, request delay. |
| `popup.*` | The linking + status UI. |

Auth model: the extension reads the challenge website's existing `session` cookie and exchanges it
at `/api/auth/device/session` for a sync token. It never asks for or stores the account password.
Every later request carries the sync token as a bearer header. Connecting rotates the token, so
linking a browser un-links any previous one.

For LinkedIn itself no credentials are involved at all: the worker runs in the user's browser, so
LinkedIn cookies attach automatically to same-origin requests. The only header we set is
`csrf-token` (derived from the `JSESSIONID` cookie).
See `../docs/linkedin-scraping.md` for the endpoint research and `../docs/sync-protocol.md` for the
server contract.

## The server client is generated

`generated/nextrs-client/client.js` comes from the server's Rust route definitions via OpenAPI, so
request and response shapes cannot drift: rename a field in `route.rs`, regenerate, and the call
site here fails to type-check instead of breaking silently at runtime. Regenerate from the server
directory with `cargo nextrs client generate`.

It is generated with an empty base URL because each build points at one server: localhost in dev
or the production origin in a release. `api.js` therefore resolves the client's
root-relative `/api/...` paths against the configured server. Absolute URLs pass through untouched,
so the LinkedIn Voyager calls in `linkedin.js` are unaffected.

## Cadence & etiquette

The worker checks every 15 minutes whether a sync is due and runs one once 12 hours (plus a
per-install jitter) have passed since the last — so a laptop that is only open now and then
syncs as soon as it is back online. Scrapes run sequentially, with a short delay between
requests. A floor in code enforces that independently of the alarm, because Chrome can fire alarms
early after a wake-from-sleep or a worker restart.

The alarm is armed on install, on browser start, and on every worker start where it is missing
(Chrome gives no guarantee that `onInstalled` runs when its owner re-enables an extension it
switched off for a permission change). A visit to the site, or opening the popup, also starts a
due automatic sync at once, one at a time and never more than every 15 minutes after a failure;
see docs/extension-first-auth.md. Failures are sorted by `errors.js` into categories (can't reach
the server, host block, server problem, a coded refusal, LinkedIn, internal), each with its own
message and code.

**Manual "Sync now" bypasses the floor.** The limit exists to keep *unattended background* traffic
polite; a person pressing a button is deliberate and self-limiting, so refusing them serves nobody.
The popup shows when the next automatic sync is due either way.

On repeated `401` it stops and asks the user to re-open LinkedIn rather than hammering.

## What the sync actually reads

One request to `profileUpdatesV2` returns the posts *and* their engagement. In LinkedIn's
normalized envelope `SocialActivityCounts` is its own entity in `included` — it is not nested
inside `SocialDetail`, which holds only a reference plus `totalShares`. Reactions, comments,
reposts and **impressions** (`numLikes` / `numComments` / `numShares` / `numImpressions`) all come
from there, matched to a post by the activity id embedded in its entity URN.

Post timestamps are decoded from the activity URN itself: LinkedIn ids are snowflake-like, so
`id >> 22` is the millisecond epoch. No response field, no extra request.

Follower count is currently unavailable — the `networkinfo` endpoint answers `410 Gone`. The
**Copy diagnostics** button probes replacement endpoints and reports which respond.

## Known-fragile bits

LinkedIn's internal API is undocumented and changes. Endpoints in `linkedin.js` are best-effort:
each collector degrades to `null` rather than throwing, so a broken endpoint reduces data quality
without breaking sync. The author-only analytics GraphQL `queryId` rotates and is discovered at
runtime; if discovery fails, impressions come back `null` until fixed.
