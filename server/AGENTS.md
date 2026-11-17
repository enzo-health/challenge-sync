# server — contract for coding agents

This is a [nextrs](https://nextrs-docs.vercel.app/docs/getting-started) app:
Rust (Axum) serving Next.js-style file routes with React `.tsx` pages. The
scaffold generated the wiring below — treat it as framework, not app code.

## The app/ tree is the router

Every directory under `app/` is a URL segment. The build step discovers these
files and wires the router — never register routes by hand:

| File | Role |
|---|---|
| `page.{tsx,rs,html}` | The content for this URL (`.tsx` = client-rendered React) |
| `layout.tsx` or `layout.rs` + `layout.html` | Wraps this segment's children (Askama layouts need `{{ children|safe }}`) |
| `loading.{tsx,rs,html}` | Skeleton streamed while the page computes |
| `middleware.rs` | Guard, runs before anything renders |
| `route.rs` | API handlers — one `pub async fn get/post/...` per method, `#[nextrs::api]` for the typed client |
| `prefetch.rs` | Server data seeding a `page.tsx`'s React Query cache (requires the `.tsx` sibling) |

A `.tsx` slot is exclusive: it cannot coexist with `.rs`/`.html` of the same
name. Full reference: <https://nextrs-docs.vercel.app/docs/conventions>

## Never hand-roll what the scaffold generates

`build.rs`, `src/main.rs`, `api/index.rs`, `vercel.json`,
`scripts/deploy-prebuilt.sh`, `rust-toolchain.toml`, and the `client/`
package are generated wiring. Extend them if you must; do not replace them
with improvised versions. Never edit generated output: `client/src/generated/**`,
`client/openapi.json`, and `public/dist/` are rebuilt on every build. The
seams for app code are `app/**`, `client/src/index.ts`, and
`client/package.json`.

## The client package and the bare-import rule

`client/` is a real npm package; pages import it as `@server/client`.

- **Every bare import used by any `.tsx` file must be installed in
  `client/package.json`** — the bundler resolves from `client/node_modules`
  and errors on unresolved bare imports. Adding a dependency means adding it
  there and running `npm install` in `client/`.
- **Never hand-write API types.** After changing `#[nextrs::api]` routes, run
  `npm run gen` in `client/` to regenerate the typed hooks from OpenAPI.
  Guide: <https://nextrs-docs.vercel.app/docs/typesafe-client>

## Seeding pages (`prefetch.rs`)

`/`, `/me`, `/challenges` and `/reports` have a `prefetch.rs`, so their first
queries arrive in the HTML (and on link intent via `/__nx/prefetch`) instead of
a second round trip. This app's GET handlers take `HeaderMap` to resolve the
session, which makes them ineligible for the generated seed companions, so the
entries are built by hand in `src/seeds.rs`: the handler's body lives in
`src/reads.rs`, and the `route.rs` handler and the seed call the same function
after the same auth decision (`dto::member_required` and friends); a refusal
seeds nothing. A seed is only read if its key is exactly what the page's hook
asks for on first render, `[url]` or `[url, params]` with absent params left
out (never `null`), URL state and defaults included. The time-zone keyed ones
(Overview, Reports) rely on the `tz` cookie the shell writes
(`components/timezone.ts`). Tests: `scripts/test-prefetch-e2e.py` (keys and
data against the API, refusals) and `../scripts/test-prefetch-browser.mjs` (a
hard load fetches nothing it was seeded).

## Dev loop

```bash
cargo dev   # build + run + watch (alias for nextrs-dev; `cargo install cargo-nextrs-dev` once)
```

Don't substitute a hand-rolled watch script — the runner knows which inputs
(Rust, templates, `app/`, `public/`, env files) require a restart.

## Diagnosing a slow route

Every response carries a `Server-Timing` breakdown — read it before adding
any logging:

```bash
curl -sI http://localhost:3000/todos | grep -i server-timing
# server-timing: mw;dur=1.2, seed;dur=430.0, handler;dur=445.1, total;dur=447.0, route;desc="/todos"
```

`mw` = middleware chain, `seed` = `prefetch.rs` data seeding, `handler` =
page render or API fn. When `handler` is the mystery, extract
`nextrs::Timing` and wrap the suspects — the segment appears in the same
header on the next request:

```rust
pub async fn get(timing: nextrs::Timing, Extension(db): Extension<Db>) -> Json<Vec<Todo>> {
    let todos = timing.span("db", db.list()).await;
    Json(todos)
}
```

The same data fires as `tracing` events (`RUST_LOG=nextrs=info` locally;
Vercel function logs in production). Full guide, including OpenTelemetry
export: <https://nextrs-docs.vercel.app/docs/telemetry>

In this app: `session` (cookie/bearer lookup), `auth` (reporting API key or
admin), and `db` / `db-<what>` (queries) are already wrapped in the busy API
handlers and the page middlewares. A signed-out request does no I/O, so `0.0`
there is real, not a broken clock. Every query is also timed at the driver
(`src/db_timing.rs`): `RUST_LOG=app::db=debug` logs each one, and operations
over 250 ms log a warning by default. Those driver events can't reach
`Server-Timing`: Toasty runs queries on its own connection task.

Link preloading is checked from the browser console: `__nx_preload_debug__()`
draws the prediction and logs each preload, `__nx_preload_stats__()` tables the
wait under each strategy. To collect real visitors' numbers, run with
`NEXTRS_PRELOAD_STATS=1` (off by default, never set in deployed config): the
shell POSTs to `/__nx/preload-stats` and each report logs as a `nextrs::preload`
info event, which `init_tracing`'s default filter (`warn,nextrs::preload=info`)
shows locally and in Vercel function logs; any `RUST_LOG` replaces that filter.

### Reading the timings

`scripts/timings.sh` GETs the busy API routes and prints, per route, the
status, curl's own timings and every `Server-Timing` segment (median of `N`
warm requests on one connection, default 3). It only reads headers, so it is
safe against prod; it is a dev/admin tool, and the cookie is optional (without
one the signed-in routes show their 401):

```bash
scripts/timings.sh http://127.0.0.1:3000 'session=...'
N=5 scripts/timings.sh https://social-challenge.enzo.health
```

Segments are server-side milliseconds inside the function: `mw` middleware,
`seed` page data, `handler` the route fn, `total` the whole request, `session`
the cookie/bearer lookup, `auth` the API-key-or-admin check, `db` / `db-<what>`
queries, and `route;desc` the pattern that matched. `outside` = TTFB − `total`
is everything that isn't our code.

The ~70–120 ms a browser sees end to end is mostly network. The request lands
on Vercel's `sfo1` edge and is forwarded to the function in `pdx1` (Oregon;
`x-vercel-id: sfo1::pdx1`); Neon is also in Oregon (us-west-2), ~1 ms from the
function. So a signed-in prod route with one indexed session lookup reads
`handler` ≈ 2–3 ms while TTFB is ~75 ms or more. Signed-out `0.0` is real (no
I/O). For per-query driver logs, run with `RUST_LOG=app::db=debug`.

## Deploys are prebuilt

Git auto-builds are OFF (`vercel.json` sets `git.deploymentEnabled: false`);
pushing deploys nothing. The deploy path is:

```bash
scripts/deploy-prebuilt.sh             # production
scripts/deploy-prebuilt.sh --preview   # preview
```

Guide: <https://nextrs-docs.vercel.app/docs/deploy-prebuilt>

## Porting into this app

Bringing routes over from an existing app? Graft them into this skeleton —
`route.ts` bodies become `route.rs` handlers, auth becomes `middleware.rs`,
React pages drop into `app/**/page.tsx` — rather than assembling parallel
structure around it. The paved road, including the strangler pattern for
incremental conversion and the gotchas list:
<https://nextrs-docs.vercel.app/docs/porting>
