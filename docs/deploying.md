# Deploying the server

The scaffold ships a working Vercel path — `vercel.json`, `api/index.rs`, and
`scripts/deploy-prebuilt.sh`. What it does **not** ship is a database that survives a serverless
invocation, and that is the decision to make before anything else.

## Current deployment

| | |
|---|---|
| URL | https://social-challenge.enzo.health |
| Vercel project | `challenge-sync` in the `enzo-health` team, functions in `pdx1` |
| Database | Neon Postgres, project `weathered-union-94046949` (us-west-2), branch `production`; `DATABASE_URL` is the pooled connection string |
| Protection | SSO off — the app is public, and authenticates its own users |
| Seeding | `SEED_DEMO` unset, so no demo org exists in production |

## Database

Production runs on Postgres (Neon). Local development uses a Turso/SQLite file
(`turso:linkedin.db`). Toasty is built with both its `turso` and `postgresql` drivers
(`server/Cargo.toml`) and picks one from the `DATABASE_URL` scheme, so no code differs between the
two.

A file-backed database cannot work on Vercel: functions get an ephemeral filesystem and run as many
concurrent instances as traffic demands, so each would open its own copy and writes would silently
vanish. Toasty's `turso` driver is also local-only (no remote URL or auth token), so hosted Turso is
not an option without a driver change.

## One-time setup

```sh
npm i -g vercel && vercel login && vercel link
cargo install cargo-zigbuild     # cross-compiles for Lambda's glibc
pip install ziglang              # the zig toolchain it drives
```

Set the runtime environment in the Vercel project:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your database connection string |
| `SEED_DEMO` | leave **unset** in production — it would create a "Demo Corp" org with public passwords |

`PORT` is ignored on Vercel; the runtime supplies the listener.

## Deploying

Git auto-builds are deliberately **off** (`"git": { "deploymentEnabled": false }` in `vercel.json`),
so pushing to GitHub deploys nothing. The deploy path is:

```sh
cd server
scripts/deploy-prebuilt.sh             # production
scripts/deploy-prebuilt.sh --preview   # preview URL
```

This compiles on your machine and uploads artifacts, which takes seconds. A cloud build would
recompile the whole Rust dependency tree on a small builder — six to ten minutes, plus queue time.
The script refuses to deploy if no `.func` directory appears in `.vercel/output`, which is the
classic silent failure when `cargo-zigbuild` is missing: everything reports green and no binary is
produced.

## Schema on a fresh database

`connect()` creates the schema only when the database is empty, and never alters an existing table
(see `server/README.md`). On a brand-new production database the first boot creates everything. After
a model change, `sync-schema.sh` adds missing tables in place; anything else needs a hand-written
migration.

## The trap that cost the first deploy

The Rust compiles, then the build fails with `Cannot read properties of undefined (reading 'target')`.
`vercel-rust` reads `config.build.target` out of `.cargo/config.toml` with an optional chain that
guards the *file* being absent but not the *table* being missing. A `.cargo/config.toml` that only
declares an alias — which is exactly what `create-nextrs-app` generates — crashes it.

The fix is an empty `[build]` table, which is already in ours. nextrs's own site and the react-todos
example both carry one with a comment explaining this; only the scaffold omits it.

## Verifying a deploy

```sh
curl -sS https://social-challenge.enzo.health/api/health   # {"ok":true} — no database involved
curl -sS -o /dev/null -w '%{http_code}\n' https://social-challenge.enzo.health/auth/login  # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://social-challenge.enzo.health/            # 303
```

`/api/health` deliberately touches no database, so it separates "the function is alive" from "the
database is reachable" — if health is 200 and `/auth/login` 500s, the problem is the database.

Then create the first org through `/auth/signup`; there is no seeding in production.

## After deploying: rebuild the extension

The extension is compiled against **one** server URL. A deployment is not usable until you rebuild
and redistribute it:

```sh
cd extension && ./build.sh https://<your-deployment>
```

See [distributing-the-extension.md](distributing-the-extension.md).

## What is not set up yet

- **No backups.** `backup-db.sh` is a local-development tool. A hosted database needs its provider's
  backups turned on.
- **No error reporting.** Failures print to the Vercel function log and nowhere else.

## The plaza room

| | |
|---|---|
| Room | `wss://plaza-room.dan-d09.workers.dev/room` (health: https://plaza-room.dan-d09.workers.dev/health) |
| Cloudflare | Worker `plaza-room` in `Dan@enzo.health's Account` (`account_id` pinned in `plaza/wrangler.toml`), first deployed 2026-11-17 |
| Vercel | `PLAZA_PASS_PRIVATE_KEY` (sensitive) and `PLAZA_ROOM_URL` set for production |

The steps below are how that was set up, and how to redo it.

`/plaza` needs a second deployment: the room in `plaza/`, a Cloudflare Worker with one Durable
Object. The main app and the room never call each other; they share only a key pair. The main
app signs a 60-second pass with the private key, the room checks it with the public key.

Until both halves are configured the page still works: everyone wanders, and a note says live
mode is not configured (no `PLAZA_ROOM_URL`) or that the server can't issue passes (no key).
So the main app can ship before the room exists.

First deploy, in this order:

1. **Keys.** `just plaza-keygen` prints a pair in your terminal. Keep the private key out of git
   and out of chat. Put the public key in `plaza/wrangler.toml` (`PLAZA_PASS_PUBLIC_KEY`) and
   commit it.
2. **Room.** `cd plaza && npx wrangler login` once, then `just plaza-deploy`. It refuses to run
   without a production public key (or with the dev-only one). It prints the Worker's URL, e.g.
   `https://plaza-room.<account>.workers.dev`. Check it:
   ```bash
   curl -sS -H 'Origin: https://social-challenge.enzo.health' https://<worker host>/health
   # {"ok":true,"originAllowed":true}
   ```
3. **Main app's environment** (from `server/`, in the checkout linked to Vercel):
   ```bash
   vercel env add PLAZA_PASS_PRIVATE_KEY production   # paste the private key
   vercel env add PLAZA_ROOM_URL production           # wss://<worker host>/room
   ```
4. **Main app.** `just deploy` as usual. The server now builds the sibling crate
   `../plaza-protocol`; the prebuilt deploy compiles on this machine, so that works. A Vercel
   cloud build would not find it (it uploads only `server/`).
5. **Check.** Open https://social-challenge.enzo.health/plaza in two browsers as two people; the
   bar should read "Live · 2 online".

Later changes: `just plaza-deploy` for the room, `just deploy` for the main app. A change to a
message in `plaza-protocol/` needs both, room first if it only adds things.

Rotating the key: make a new pair, deploy the room with the new public key, then replace
`PLAZA_PASS_PRIVATE_KEY` in Vercel and redeploy the main app. In between, pages show "the room
refused this page's pass: its signature does not match the room's key" and keep retrying.

Allowed origins are exact (`PLAZA_ALLOWED_ORIGINS` in `plaza/wrangler.toml`): Vercel preview
URLs are not on the list, so previews show the plaza without live mode.
