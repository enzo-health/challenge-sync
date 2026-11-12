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

## Read this first: the database is not solved

The app currently uses Toasty's `turso` driver against a local file (`turso:linkedin.db`). Two
things follow, and neither is obvious:

**Toasty's Turso driver is local-only, at every published version.** Confirmed against 0.9.0, not
just the 0.7.0 we pin. `Turso::new(url)` accepts `turso::memory:` or `turso:/path/to/file` and nothing
else — no remote URL, no auth token, no replica sync. Pointing `DATABASE_URL` at a
`libsql://…turso.io` URL fails to parse rather than failing to connect.

The capability exists one layer down: the underlying `turso` crate ships a `sync` feature and a
sync engine, already in our dependency tree. Toasty simply does not surface it. Hosted Turso is
therefore a Toasty driver change, not a Turso limitation — worth knowing if it becomes a priority.

**A file-backed database cannot work on Vercel anyway.** Functions get an ephemeral filesystem and
run as many concurrent instances as traffic demands. Each would open its own copy, writes would land
in whichever instance served the request, and everything would vanish when the instance froze. It
wouldn't error — it would silently lose data, which is worse.

So pick one:

| Option | What changes | Trade-off |
|---|---|---|
| **Postgres on Vercel** (Neon, Supabase, Vercel Postgres) — **chosen** | Enable the `postgresql` feature alongside `turso`; Toasty picks the driver from the `DATABASE_URL` scheme, so local dev keeps its file | The paved road for serverless. No code change beyond the feature flag. |
| **A host with a real disk** (Fly.io + volume, a small VM, Docker) | Keep the Turso file driver; mount a volume | No database migration, but you leave the one-command Vercel deploy behind. |
| **Wait for remote Turso** | Nothing yet | Only sensible if hosted Turso specifically is the goal. Track the driver's support. |

I'd take Postgres if the goal is "deploy on Vercel this week", and Fly.io if the goal is "keep the
current data layer". The rest of this document assumes you have a reachable `DATABASE_URL`.

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

- **No custom domain.** Deployments get a generated `*.vercel.app` hostname, which changes per
  project rename. Set a domain before distributing the extension, because the URL is baked into
  every installed copy and changing it means shipping an update to every user.
- **No backups.** `backup-db.sh` is a local-development tool. A hosted database needs its provider's
  backups turned on.
- **No error reporting.** Failures print to the Vercel function log and nowhere else.
