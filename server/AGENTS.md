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
