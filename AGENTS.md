# Challenge Sync — contract for coding agents

- `server/`: the web app and API (Rust, nextrs). Read `server/AGENTS.md` before touching it.
- `extension/`: the Chrome extension that syncs LinkedIn posts to the server.
- `plaza/`, `plaza-protocol/`: the plaza's live room and its shared protocol crate (below).
- `scripts/check.sh` (`just check`) runs every check; get it green before calling work done.

## The official weekly lottery draw

`/lottery` is the public, provably fair Friday draw: open signed out, one address every week.
Rules and timetable (Denver time: list frozen 09:30, seeded 09:35 by drand's quicknet beacon, wheel
until 12:00) live in `server/src/lottery_draw.rs`; the beacon fetch and its checks in
`server/src/beacon.rs`. The server picks the winner; the page only animates to it. Never add a
fallback to local randomness, and never add an API that edits or deletes a draw record
(`lottery_draws`, `lottery_results`). A Vercel cron (`crons` in `server/vercel.json`) calls the
idempotent `GET /api/lottery/freeze`. Tests fake drand locally (`LOTTERY_BEACON_URLS` and the
debug-only `DEV_BEACON_SKIP_SIGNATURE_CHECK=1`) and pin the clock with `DEV_CLOCK_OFFSET_FILE`.

## The plaza

`/plaza` is a page where every signed-in member's avatar walks around with everyone else's.
It is two apps that never call each other; the browser talks to both.

- **Main app** (`server/`): knows who people are. `GET /api/plaza/roster` (everyone, their avatar,
  whether they posted in the current Friday-to-Thursday lottery week, by the lottery's rule) and `POST /api/plaza/pass` (a 60-second
  Ed25519-signed pass for the caller). Logic in `server/src/plaza.rs`; page in
  `server/app/plaza/` and `server/components/plaza/`, reusing the avatar from
  `server/components/lottery/`.
- **Room** (`plaza/`): a Rust Cloudflare Worker with one Durable Object (workers-rs, compiled to
  wasm). It verifies the pass with the public key, then relays join, leave, move, jump, high five
  and chat. It stores nothing and never logs chat or passes. Deployed separately from the main
  app; see `plaza/README.md` and the plaza section of `docs/deploying.md`.
- **Protocol** (`plaza-protocol/`): the pass format, the WebSocket messages and the room's pure
  rules, compiled natively by the server and to wasm32 by the room. Keep it dependency-light.
  A change to a message is a change to three places: this crate, the room, and
  `server/components/plaza/`.

### Run it locally

```bash
just plaza-dev
```

That starts the room (`wrangler dev`, no Cloudflare account or login) on
`ws://127.0.0.1:8787/room` and the web server on <http://localhost:3312> with demo data in its own
database (`server/plaza-demo.db`). Sign in two browsers (or one normal and one private window) as
two demo people, `<first-name>@demo.test` / `demopassword` (for example `ada@demo.test` and
`ben@demo.test`), and open <http://localhost:3312/plaza> in both.

Configuration:

| Where | Variable | Meaning |
| --- | --- | --- |
| main app | `PLAZA_PASS_PRIVATE_KEY` | base64 32-byte Ed25519 seed that signs passes; without it the pass API answers 503 `plaza_key_missing` |
| main app | `PLAZA_ROOM_URL` | the room's `wss://…/room` URL handed to the page; defaults to the local room in debug builds, none in release |
| room | `PLAZA_PASS_PUBLIC_KEY` | the matching public key |
| room | `PLAZA_ALLOWED_ORIGINS` | comma-separated origins allowed to open a WebSocket |

`plaza/dev-keys.env` and `plaza/.dev.vars` hold a **dev-only** key pair that is public in git.
Never use it in a deployment; make a real pair with
`cargo run --manifest-path plaza-protocol/Cargo.toml --bin plaza-keys -- keygen`.

Never run `wrangler login` or `wrangler deploy` unless the owner asks.

### Tests

All in `scripts/check.sh`: `plaza-protocol` (cargo tests: passes, messages, rules), `plaza`
(`server/scripts/test-plaza-e2e.py`: the two APIs), `plaza-room` (`scripts/test-plaza-room.mjs`:
the room, against local rooms it starts and stops itself) and `plaza-browser`
(`scripts/test-plaza-browser.mjs`: two browsers in the room together).
`scripts/plaza-room-harness.mjs` is the shared "start a local room" helper.
