# Challenge Sync — server

A full-stack Rust app built on [nextrs](https://github.com/drewhirschi/nextrs) — an Axum backend
serving Next.js-style file routes with React client pages — with
[Toasty](https://github.com/tokio-rs/toasty) as the ORM. Production runs on Postgres (Neon); local
development uses a Turso/SQLite file (`turso:linkedin.db`). Toasty is built with both drivers and
picks one from the `DATABASE_URL` scheme.

Ported from Topcoat; see [MIGRATION.md](../MIGRATION.md) for what moved where and the gotchas.

## Run

```sh
cargo install cargo-nextrs                # one-time, provides `cargo dev` (the watcher)
npm ci && npm run client:generate         # one-time, page dependencies and the typed client
cargo dev                                 # http://localhost:3312, one local account
```

Or use `just dev` from the repository root, which selects the local file database and local seed.

Without `cargo-nextrs`, `cargo run --bin linkedin-challenge-server` serves the same app without
rebuilding on change.

Debug builds create one local account on every start, with a local challenge ("Posting Cup") and
no LinkedIn data:

- `drew@local.test` / `localpassword`

Run `just seed-local` to create it without starting the server. The seed is idempotent and never
overwrites data synced from LinkedIn.

Everything requires a session, so start at `/auth/password` for email-and-password accounts.
With `SEED_DEMO=1`, the demo seed creates accounts you can use (password `demopassword` for all of
them):

- `sysadmin@demo.test` — system admin: All users, Post reports, and (for now, admins only)
  challenges and their leaderboards
- `admin@demo.test` — owns the demo challenge, but is not a system admin, so like everyone else
  it sees only the Overview and My posts until challenges are opened to members again
- `ada@demo.test`, `ben@demo.test`, `carmen@demo.test`, `dev@demo.test`, `erin@demo.test` —
  participants

Reachable signed out: `/auth/login` (get started with the extension), `/auth/password` (email and
password), `/auth/join` (redeem an invite code), `/join/<code>` (the company join link) and
`/privacy`.

### Environment

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `turso:linkedin.db` | Database connection: a local Turso/SQLite file in development, Postgres in production. |
| `SEED_DEMO` | _(unset)_ | If set, seeds a demo org + competition + participants on first run. |
| `PORT` | `3312` | Bind port. No fallback: the server exits if the port is taken, because the extension is built against one fixed server URL. |

**Changing a model can wipe the dev database.** `push_schema()` cannot alter an existing table.
A new column needs an additive `ALTER TABLE` in `connect()` (`add_column`, which runs on every
start, locally and in production); a new table or index can be added with `./sync-schema.sh`.
Anything else means deleting `linkedin.db` and re-running — every account and every synced post goes
with it, and any linked extension starts getting 401s because its member row is gone. The extension
recovers on its own if the browser still has a website session; otherwise it asks the user to press
Connect.

Back up with `./backup-db.sh` first, **not** by copying `linkedin.db`. libsql keeps recent writes in
`linkedin.db-wal`, so copying the database file alone can produce a file with no tables in it —
that has already happened once here, and the real data was deleted along with the WAL. The script
folds the WAL in and refuses to leave behind a backup with zero tables.

The schema is created on first run only: Toasty's `push_schema()` issues plain `CREATE TABLE` with
no create-if-missing, so `connect()` probes for an existing table and pushes only when the database
is empty. Beyond the additive `add_column` statements it does not *migrate* — after any other
model change, delete `linkedin.db*` (or point `DATABASE_URL` at a fresh file) to recreate.

### Editor setup

`tsconfig.json` at this directory's root is the app's TypeScript project, so an editor opening
`app/**/page.tsx` finds it (editors resolve against the *nearest* tsconfig above the file). The
generated client is a separate package under `.nextrs/client` with its own tsconfig; pages import
it as `@linkedin-challenge/client` through the root workspace link in `node_modules`.

If the editor reports every generated hook as missing, the client has not been generated yet:
run `npm run client:generate`.

### Changing an API route

`route.rs` handlers annotated with `#[nextrs::api]` are the source of the OpenAPI document, which
generates both clients. Keep those attributes minimal: the macro infers the HTTP method from the
function name, the path from the file, params from the extractors, the request body from
`Json<T>`, and the 200 response from the return type. Only genuine overrides belong in the
attribute — a custom `operation_id` (which sets the hook name), and error responses.

Two things defeat that inference, both silently: returning a type *alias* such as
`ApiResult<Json<T>>` instead of `Result<Json<T>, ApiError>`, and returning a tuple like
`(HeaderMap, Json<T>)`. Either yields an operation with no response schema, so spell the type out
or declare the response by hand.

Generation: the React Query hooks the pages use, and the plain-JS client the Chrome
extension imports. After changing a handler's path, params, body, or response:

```sh
cargo nextrs client generate        # refreshes the contract and both clients, publishes to the extension
```

`.nextrs/client/nextrs.client.json` (materialized from `.nextrs/template/client/`) points the
external client at `extension/generated/nextrs-client/`. Without `cargo-nextrs`,
`npm run client:generate` refreshes the in-app client only, not the extension's.

Nothing under `.nextrs/client/`, `.nextrs/openapi.json`, `public/dist/`, or
`extension/generated/` is hand-written — all of it is regenerated.

## Layout

```
src/                  domain layer — a lib crate, because .nextrs/dump-openapi.rs is a second
                      crate root that shares the generated route registry
  lib.rs              module list
  models.rs           Toasty models (Org, Member, Invite, Competition, ChallengeMembership, Post,
                      PostSnapshot, PostComment, ProfileSnapshot, AdminSession, DeviceToken,
                      JoinLink, ApiKey, LotteryDraw, LotteryResult) + connect() and its additive
                      migrations
  scoring.rs          ScoringConfig + compute_standings (derived at read time, weekly buckets,
                      top-N/week, follower normalization, profile points)
  dto.rs              wire shapes + the reads behind them (leaderboard, member detail, aggregate)
  reads.rs, seeds.rs  GET bodies shared by route.rs handlers and the pages' prefetch.rs seeds
  reports.rs          the admin post report and /api/v1/posts, /api/v1/members
  stats.rs            the company stats overview (landing page, /api/v1/stats)
  lottery.rs          the lottery entrants, Fri-Thu weeks or a custom range (/api/admin/lottery)
  lottery_draw.rs     the official public Friday draw: phases, freeze, list hash, winner formula,
                      redraws (/api/lottery, /api/lottery/results, /api/lottery/freeze,
                      /api/admin/lottery/draws)
  beacon.rs           drand quicknet: round times, fetch with relay fallback, signature check
  avatar.rs           members' avatars (/api/me/avatar)
  plaza.rs            plaza roster and signed passes (/api/plaza/*)
  enroll.rs           automatic enrollment in running challenges
  accounts.rs         deleting posts and closing or restoring accounts
  web.rs              ApiError — one JSON error shape for every route
  auth.rs             Argon2 passwords, session cookie, email lookup, device tokens (extension)
  db_timing.rs        driver-level query timing
  util.rs             unix time, ISO/date parsing, invite codes, bearer tokens, a small SHA-256
  seed.rs             the local account and the optional demo data
  main.rs             Db setup, CORS layer, router assembly, graceful shutdown
  bin/                seed-local, seed-lottery-demo

app/                  the router — every directory is a URL segment
  middleware.rs       root guard: signed out sees only the sign-in surfaces
  layout.tsx          root chrome, stays mounted across soft navigation
  page.tsx            / landing: the company stats overview (sidebar "Overview")  (+ prefetch.rs)
  auth/               login (get started with the extension), password, join (invite code)
  join/[code]/        the company join link
  me/                 my posts (+ prefetch.rs), me/avatar the avatar editor
  challenges/         list, new, mine, [id] leaderboard, scoring, invites, settings (+ prefetch.rs)
  members/[id]/       a participant's results
  admin/              challenges overview, lottery (+ official: the official draws and Redraw);
                      middleware.rs limits it to challenge users
  lottery/            the public official draw, open signed out (bare page, like the presenter)
  system/             all users (system admins only)
  reports/            post reports (+ prefetch.rs)
  plaza/              the live plaza page
  rules/, privacy/, account/
  api/                sync, link, auth/*, me/*, challenges/*, members/*, admin/*, system/*,
                      plaza/*, stats/*, v1/* (reporting API), health

.nextrs/client/       generated typed client (npm package, imported as @linkedin-challenge/client)
public/style.css      the stylesheet
```

## How auth works

**Everyone signs in; nothing is public.** Every account is a `Member` row. Most members sign in
through the extension with no password; accounts created with an email and password (an invite
code at `/auth/join`, or `/api/auth/signup`) sign in at `/auth/password`. `is_system_admin` unlocks
`/system`, `/reports` and, for now, challenges (`auth::can_use_challenges`).

- **Sessions.** The server mints a random token, stores only its SHA-256 on an `AdminSession` row,
  and returns it as an `HttpOnly; SameSite=Lax` cookie. `app/middleware.rs` guards every route
  except the sign-in surfaces, the auth API, the extension protocol, the reporting API and static
  assets — a presence check on the cookie, since each handler verifies the session properly
  anyway. Section middlewares (`app/admin/`, `app/system/`, `app/reports/`, …) add role checks.
- **The extension** gets a per-device sync token (a `DeviceToken` row; several devices can sync
  one account): from the company join link with the person's LinkedIn identity
  (`/api/auth/extension/join`), or from an existing website session
  (`/api/auth/device/session`), after which `/api/link` binds the LinkedIn identity to that
  account. `/api/auth/device/web-session` turns a sync token back into a website session.
  `/api/sync` ingests snapshots, bearer-authenticated. A permissive `CorsLayer`
  lets a `chrome-extension://` origin call these routes — safe precisely because they use bearer
  auth rather than the session cookie. Details: [docs/extension-first-auth.md](../docs/extension-first-auth.md).
