# Challenge Sync

Challenge Sync runs company LinkedIn posting challenges. Each participant installs a Chrome
extension ([Chrome Web Store listing](https://chromewebstore.google.com/detail/challenge-sync-%E2%80%94-linkedin/lipnimkomknkipidfloeigpojfilgjfh))
that reads their own LinkedIn data from inside their signed-in browser: follower count, posts, and
the author-only post analytics (impressions, reactions, comments, reposts and so on). It syncs that
data to a central server, which scores everyone by each challenge's rules and shows the company
overview, each person's results and the leaderboards.

A central scraper can't see author-only analytics; an extension running in each person's own
LinkedIn session can.

[MANIFEST.md](MANIFEST.md) describes the product: who uses it and what it should answer.

## How it works

```
Participant's browser                         Server (server/: nextrs, on Vercel)
                                                React pages (page.tsx), Rust API (route.rs)
  Chrome extension (extension/)
    reads own LinkedIn data in the    POST      /api/auth/extension/join  join code + LinkedIn
    browser's LinkedIn session      ───────►                              identity -> account and
    syncs about twice a day                                               device sync token
                                                /api/sync                 snapshots, bearer token
  Website (same browser)
    /join/<code>, overview, my posts, ◄─────►   Toasty ORM: Postgres (Neon) in production,
    leaderboards, admin pages                               a local Turso/SQLite file in dev
                                                scoring derived at read time (src/scoring.rs)

    /plaza  ── WebSocket ──►  Plaza room (plaza/: Cloudflare Worker + Durable Object)
                              admits a page holding a 60-second pass signed by the server
```

- **Sign-in goes through the extension.** A person opens the company join link (`/join/<code>`),
  installs the extension and is logged in to LinkedIn. The extension presents the join code with
  their LinkedIn identity, gets an account and a device sync token, and signs the website in, with
  no password. Accounts created with an email and password sign in at `/auth/password`.
  Details: [docs/extension-first-auth.md](docs/extension-first-auth.md).
- **Syncing.** The extension checks every 15 minutes and syncs when about 12 hours have passed
  since its last automatic sync. Wire format: [docs/sync-protocol.md](docs/sync-protocol.md).
- **Scoring** is computed from the stored snapshots at read time, never stored: points per post
  (capped per week), active weeks and streaks, and engagement priced per reaction, comment, repost
  and so on, optionally normalised by follower count.

## What the app does

Members see the company overview (`/`), their own synced posts and results (`/me`) and challenge
leaderboards; admins set up challenges and their scoring rules, manage users and export post
reports. A few fun extras are built in to support the challenge, such as a weekly lottery wheel
and the plaza, where members' avatars walk around together. Any member can make their own
read-only API key (`/me/api-keys`) so their AI assistant can read the posts and stats through the
reporting API ([docs/reporting-api.md](docs/reporting-api.md), also served at `/api/v1/docs`).

The plaza's real-time room runs as a separate app on Cloudflare: a Worker written in Rust
(workers-rs, compiled to wasm) with one Durable Object, `Room`, bound as `ROOM`. Its only other
configuration is plain variables (allowed origins and the pass public key). It has no storage
bindings, keeps nothing between connections and never logs chat. The web server and the room
never call each other: the server signs a 60-second pass, and the room checks it with the public
key. See [plaza/README.md](plaza/README.md).

## Repository layout

```
server/            the web app and API: Rust (Axum, nextrs, Toasty) with React pages
  app/             file routes: page.tsx pages, route.rs API handlers, middleware.rs guards
  components/      React components shared by pages
  src/             domain code: models, scoring, auth, lottery, reports, plaza passes, seeds
  scripts/         server e2e tests, the deploy script, timings.sh
extension/         the Chrome extension (Manifest V3, plain JavaScript)
plaza/             the plaza room: a Rust Cloudflare Worker with one Durable Object
plaza-protocol/    pass format, WebSocket messages and room rules, shared by server and room
scripts/           check.sh (all checks), signoff, browser and extension e2e tests
docs/              sync protocol, auth, deploying, extension distribution, reporting API
MANIFEST.md        product manifest
MIGRATION.md       notes from porting the server from Topcoat to nextrs (historical)
POST_PLANNER_MANIFEST.md   product spec for a post planner (not built)
justfile           project commands (`just` lists them)
```

The server is a [nextrs](https://github.com/drewhirschi/nextrs) app: directories under
`server/app` are URL segments, and the build wires the router and generates a typed client
(React Query hooks for the pages, a plain-JavaScript client for the extension) from the `route.rs`
handlers. Read [server/AGENTS.md](server/AGENTS.md) before changing the server.

## Running locally

Tools: Rust (`cargo`), Node.js with `npm`, `python3`, `zip` and [`just`](https://github.com/casey/just).
`just dev` runs `cargo dev`, which needs `cargo-nextrs` (`cargo install cargo-nextrs`) and rebuilds
and restarts the server on change. `just doctor` checks for all of these.

On a fresh clone, install the page dependencies and generate the typed client once:

```sh
cd server && npm ci && npm run client:generate && cd ..
```

Then:

```sh
just dev              # server on http://localhost:3312, database server/linkedin.db
just extension-dev    # build extension/dist/unpacked for that local server
```

Without `cargo-nextrs`, the same server runs without the rebuild-on-change loop:

```sh
cd server && DATABASE_URL=turso:linkedin.db cargo run --bin linkedin-challenge-server
```

Debug builds create one local account on every start (idempotently), with a local challenge and
no LinkedIn data. Sign in with it at `/auth/password`:

```text
drew@local.test / localpassword
```

`just seed-local` creates it without starting the server.

Load `extension/dist/unpacked/` from `chrome://extensions` (Developer mode, Load unpacked). After
an extension change, rerun `just extension-dev` and click **Reload** on the extension card.

Other local setups:

- `just plaza-dev`: the web server with demo data (`server/plaza-demo.db`) plus the plaza room on
  `ws://127.0.0.1:8787/room` (`wrangler dev`, no Cloudflare login). Sign in two browsers as two
  demo people, `<first-name>@demo.test` / `demopassword` (for example `ada@demo.test` and
  `ben@demo.test`), and open `/plaza` in both. It works without `cargo-nextrs` too.
- `just seed-lottery-demo`: adds an invented crowd to the local database for the lottery page;
  view it as `lottery-admin@local.test` / `localpassword`.

## Checks

```sh
just check     # runs scripts/check.sh
```

The fast tier always runs: the build, typecheck, `cargo test`, syntax checks, unit tests, the
extension's sync code against a local server, headless browser tests, the plaza tests and every
server e2e, each server on its own port and temporary database.

The live tier drives the real extension against a real signed-in LinkedIn account in a local
Chromium profile (`scripts/test-extension-e2e.mjs` and `scripts/test-join-flow-e2e.mjs`, about 2.5
minutes). It runs only when the extension or the sign-in handshake has changed since it last
passed on that machine. `just dev-profile-login` signs that profile in to LinkedIn;
`CHECK_LIVE=always` or `CHECK_LIVE=never` forces or skips the tier.

Pull requests merge on a `local-checks` commit status, which `just signoff` posts after running
`just check` on the pushed commit. See [docs/local-check-signoff.md](docs/local-check-signoff.md).

## Deploying

- **Server:** `just deploy` (or `just deploy-preview`) builds on your machine and uploads a
  prebuilt deployment to Vercel; pushing to GitHub deploys nothing. See
  [docs/deploying.md](docs/deploying.md).
- **Plaza room:** `just plaza-deploy`. See
  [the plaza section of docs/deploying.md](docs/deploying.md#the-plaza-room) and
  [plaza/README.md](plaza/README.md).
- **Extension:** `just extension-release https://<server origin>` builds a Web Store zip for one
  HTTPS server origin; the **Build extension release** GitHub workflow does the same. See
  [docs/distributing-the-extension.md](docs/distributing-the-extension.md).

## Privacy

The extension does not collect LinkedIn credentials and doesn't need to: it runs in the user's
browser, where LinkedIn's session cookies already live, so it reads the user's own identity and
analytics without touching their password. LinkedIn's cookies never leave the browser. The
extension sends our server only the user's own LinkedIn data, authenticated with its own
per-device sync token. Each participant uploads only their own data, by consent (installing the
extension and joining). Collection is read-only, own-data-only and infrequent (about twice a day).
The plaza room stores nothing and never logs chat.

## Further docs

- [docs/sync-protocol.md](docs/sync-protocol.md): extension-to-server sync
- [docs/extension-first-auth.md](docs/extension-first-auth.md): sign-in through the extension
- [docs/linkedin-scraping.md](docs/linkedin-scraping.md): how the extension reads LinkedIn
- [docs/reporting-api.md](docs/reporting-api.md): the read-only reporting API
- [docs/deploying.md](docs/deploying.md): server and plaza deploys
- [docs/distributing-the-extension.md](docs/distributing-the-extension.md): shipping the extension
- [docs/local-check-signoff.md](docs/local-check-signoff.md): the local merge gate
- [server/README.md](server/README.md), [server/AGENTS.md](server/AGENTS.md): working on the server
- [extension/README.md](extension/README.md), [plaza/README.md](plaza/README.md)
