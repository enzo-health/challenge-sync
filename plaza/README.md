# The plaza room

A live shared space where members' avatars walk around. This directory is the **room**: a
Cloudflare Worker written in Rust (workers-rs) with one Durable Object (`Room`, a single instance
named `plaza`). The Worker checks the `Origin` and hands WebSocket upgrades to the room; the room
knows only who is connected and where they stand. Nothing is stored or persisted: no database, no
storage keys (only an alarm that closes sockets which never said hello). Chat is relayed and never
stored or logged; passes are never logged.

The wire protocol, the pass format and the pure rules (clamping, chat cleaning, rate limits, high
fives, origin matching) live in `../plaza-protocol`, shared with the main server, which signs the
passes.

## Run locally

```sh
cd plaza
npm ci                       # wrangler + ws (pinned)
npx wrangler dev             # builds (plaza/build.sh) and serves http://127.0.0.1:8787
```

Room URL: `ws://127.0.0.1:8787/room`. Health: `http://127.0.0.1:8787/health`.

No Cloudflare account or login is involved: `wrangler dev` runs the Worker in local workerd
(miniflare). Set `WRANGLER_SEND_METRICS=false` to keep wrangler from sending telemetry. The first
build installs the pinned `worker-build` into `plaza/.tools` and worker-build downloads its
`wasm-bindgen` and `esbuild` once (network needed once); after that a build with no changes takes
about a second.

Tests: `node scripts/test-plaza-room.mjs` from the repo root (starts its own rooms on free ports).

## Endpoints

- `GET /health` → `200 {"ok":true,"originAllowed":<bool>}` for the request's `Origin`, with
  `Access-Control-Allow-Origin: *`. Lets the page tell "room unreachable" from "room refused this
  origin".
- `GET /room` (WebSocket upgrade) → the room, if the `Origin` is allowed; otherwise `403` with a
  body saying why (`origin not allowed: …`). A missing `Origin` is refused.

## Protocol in short

JSON text frames tagged on `"t"` (see `plaza-protocol/src/msg.rs`). The first message must be
`{"t":"hello","pass":"…"}`; the pass is `base64url(payload) "." base64url(ed25519 signature)` with
payload `{"m":<member id>,"exp":<unix seconds>}`, issued by the main server for 60 seconds.
Then `move`, `jump`, `chat`. The room sends `welcome`, `join`, `leave`, `move`, `jump`,
`highfive`, `chat`, `error`.

Close codes: 4001 pass rejected (`pass_malformed` / `pass_bad_signature` / `pass_expired`),
4002 replaced by a newer connection of the same member, 4003 first message was not hello,
4004 room misconfigured (its public key is missing or invalid), 4005 no hello within the timeout.

Limits: moves 15/s (burst 5), jumps 3/s, chat one per 1.5 s (burst 3, else `chat_too_fast`),
chat 80 characters after cleaning (else `chat_too_long`), frames over 1024 bytes, binary frames
and anything malformed are ignored. At most 64 sockets may be waiting to say hello (more get 503).

## Configuration

| Variable | Meaning |
| --- | --- |
| `PLAZA_PASS_PUBLIC_KEY` | Standard base64 of the 32-byte Ed25519 public key passes are checked with. |
| `PLAZA_ALLOWED_ORIGINS` | Comma-separated exact origins allowed to open `/room`, e.g. `https://challenge.example.com`. |
| `PLAZA_ALLOW_LOCALHOST_ANY_PORT` | `1` also accepts `http://localhost:<port>` / `http://127.0.0.1:<port>`. **Dev only.** |
| `PLAZA_HELLO_TIMEOUT_MS` | Optional; how long a socket may stay without hello (default 10000). |

Local values are in `.dev.vars` (checked in, nothing secret): the **dev-only** public key from
`dev-keys.env`, origins `http://localhost:3312,http://127.0.0.1:3312`, and the any-port switch on.
`dev-keys.env` holds the matching dev private key for the local server and tests; both are public
in git and must never be used in a deployment.

New key pair: `cargo run --manifest-path plaza-protocol/Cargo.toml --bin plaza-keys -- keygen`
(also `public <private>`, `sign <private> <member> <exp>`, `verify <public> <pass> <now>`).

## What a real deploy would need (not done)

- A Cloudflare account and `wrangler login` (or an API token) — Durable Objects on the free plan
  must be SQLite-backed, which the `new_sqlite_classes` migration in `wrangler.toml` already is.
- A fresh key pair: the private key in the main server's environment, the public key as
  `PLAZA_PASS_PUBLIC_KEY` on the Worker (e.g. `wrangler secret put PLAZA_PASS_PUBLIC_KEY`, though
  it is not secret).
- `PLAZA_ALLOWED_ORIGINS` set to the site's origin(s); `PLAZA_ALLOW_LOCALHOST_ANY_PORT` unset.
  `wrangler.toml` deliberately has no `[vars]`, so a deploy without them refuses every origin
  and every pass with an error naming the missing variable.
- `wrangler deploy`, then point the page at `wss://<worker host>/room`.

## Versions

worker 0.9.0, worker-build 0.9.0 (wasm-bindgen it downloads to match), wrangler 4.164.0
(miniflare 5.20261117.0-beta, workerd 1.20261117.1), rustc 1.96.0 (pinned in
`rust-toolchain.toml`, same as `server/`), `compatibility_date = "2026-11-01"`.

Known local quirk: under `wrangler dev`, when the room closes a socket that never sent a single
frame (the hello timeout), the client receives the error and the close frame but its TCP
connection is not ended afterwards, so the client's own `close` event waits for its timeout.
Sockets that have sent anything close normally.
