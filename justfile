set shell := ["bash", "-euo", "pipefail", "-c"]

localhost := "http://localhost:3312"

# Show the available project commands.
default:
    @just --list

# Check that the local development tools are installed.
doctor:
    @command -v cargo >/dev/null || { echo "missing: cargo" >&2; exit 1; }
    @command -v nextrs >/dev/null || { echo "missing: cargo-nextrs (install with: cargo install cargo-nextrs)" >&2; exit 1; }
    @command -v node >/dev/null || { echo "missing: node" >&2; exit 1; }
    @command -v npm >/dev/null || { echo "missing: npm" >&2; exit 1; }
    @command -v python3 >/dev/null || { echo "missing: python3" >&2; exit 1; }
    @command -v zip >/dev/null || { echo "missing: zip" >&2; exit 1; }
    @echo "development tools are ready"

# Run the web/API server with the local account and idempotent Q3 World Cup seed.
dev:
    cd server && DATABASE_URL=turso:linkedin.db cargo dev

# Release only: a debug build would seed the local test account into production. Startup applies
# the additive schema migrations, exactly as a deploy would.
# Run a release build locally against the PRODUCTION database (credentials from server/.env.local).
run-prod:
    cd server && test -f .env.local || { echo "missing server/.env.local (run: vercel env pull .env.local)" >&2; exit 1; }
    cd server && cargo build --release --bin linkedin-challenge-server
    cd server && set -a && . ./.env.local && set +a && DATABASE_URL="$DATABASE_URL_UNPOOLED" PORT=3312 ./target/release/linkedin-challenge-server

# Two browsers signed in as two demo people (<first-name>@demo.test / demopassword, e.g. ada@ and
# ben@) see each other at http://localhost:3312/plaza. The room listens on ws://127.0.0.1:8787/room.
# Uses its own database file (server/plaza-demo.db) and the DEV-ONLY pass keys in plaza/dev-keys.env.
# Run the plaza locally: the web server with demo data plus the live room (wrangler dev, no login).
plaza-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -d plaza/node_modules ] || (cd plaza && npm ci --no-audit --no-fund)
    set -a; . plaza/dev-keys.env; set +a
    trap 'kill 0' EXIT
    (cd plaza && WRANGLER_SEND_METRICS=false npx wrangler dev </dev/null) &
    cd server
    export SEED_DEMO=1 DATABASE_URL=turso:plaza-demo.db
    # `cargo dev` (rebuilds on change) needs cargo-nextrs; without it, a plain run serves the same app.
    if command -v nextrs >/dev/null; then cargo dev; else cargo run --bin linkedin-challenge-server; fi

# Prints the pair in your terminal only. Put the private key in Vercel (never in git, never in chat):
#   cd server && vercel env add PLAZA_PASS_PRIVATE_KEY production
# and the public key in plaza/wrangler.toml (PLAZA_PASS_PUBLIC_KEY), which is committed.
# Generate a PRODUCTION plaza pass key pair.
plaza-keygen:
    cargo run --quiet --manifest-path plaza-protocol/Cargo.toml --bin plaza-keys -- keygen

# Needs a Cloudflare login first (`cd plaza && npx wrangler login`). Refuses to deploy without a
# production public key in plaza/wrangler.toml, or with the dev-only one. Prints the Worker's URL;
# the room is wss://<that host>/room, which goes in Vercel as PLAZA_ROOM_URL.
# Deploy the plaza room (the Cloudflare Worker and its Durable Object).
plaza-deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    key=$(sed -n 's/^PLAZA_PASS_PUBLIC_KEY *= *"\(.*\)"$/\1/p' plaza/wrangler.toml)
    dev=$(sed -n 's/^PLAZA_PASS_PUBLIC_KEY=//p' plaza/dev-keys.env)
    [ -n "$key" ] || { echo "plaza/wrangler.toml has no PLAZA_PASS_PUBLIC_KEY yet: run \`just plaza-keygen\` and put the public key there" >&2; exit 1; }
    [ "$key" != "$dev" ] || { echo "plaza/wrangler.toml has the DEV-ONLY public key (plaza/dev-keys.env); anyone can sign passes for it. Use a production pair: \`just plaza-keygen\`" >&2; exit 1; }
    [ "$(printf %s "$key" | base64 -d 2>/dev/null | wc -c)" = 32 ] || { echo "PLAZA_PASS_PUBLIC_KEY in plaza/wrangler.toml is not base64 of 32 bytes" >&2; exit 1; }
    [ -d plaza/node_modules ] || (cd plaza && npm ci --no-audit --no-fund)
    cd plaza && WRANGLER_SEND_METRICS=false npx wrangler deploy

# Verify the plaza room against a local wrangler dev that the test starts and stops itself.
test-plaza-room:
    node scripts/test-plaza-room.mjs

# Ensure the local account and Q3 World Cup challenge exist without resetting synced data.
seed-local:
    cd server && DATABASE_URL=turso:linkedin.db cargo run --bin seed-local

# Add an invented crowd to the LOCAL database for the weekly lottery page (idempotent, opt-in; the
# binary refuses any DATABASE_URL but turso:linkedin.db). View as lottery-admin@local.test / localpassword.
seed-lottery-demo:
    cd server && DATABASE_URL=turso:linkedin.db cargo run --bin seed-lottery-demo

# Build the stable unpacked Chrome extension directory for the local server.
extension-dev:
    cd extension && ./build.sh {{localhost}} --dir
    @echo "Load or reload extension/dist/unpacked in chrome://extensions"

# Build a Chrome Web Store zip for an explicit HTTPS server origin.
extension-release server_url:
    [[ "{{server_url}}" == https://* ]] || { echo "release URL must use https" >&2; exit 1; }
    cd extension && ./build.sh "{{server_url}}"

# Run the fast checks not already guaranteed by Vercel's release cross-build.
deploy-check:
    node --check extension/api.js
    node --check extension/background.js
    node --check extension/bridge.js
    node --check extension/config.js
    node --check extension/linkedin.js
    node --check extension/popup.js
    node --check extension/refresh.js
    node --check extension/diagnostics.js
    node --check extension/storage.js
    node --check extension/sync.js
    bash -n extension/build.sh
    git diff --check

# Build, verify, and deploy the server to the linked Vercel production project.
deploy: deploy-check
    cd server && ./scripts/deploy-prebuilt.sh

# Build, verify, and deploy an unaliased Vercel preview.
deploy-preview: deploy-check
    cd server && ./scripts/deploy-prebuilt.sh --preview

# All checks, via scripts/check.sh. The fast tier (about 1.5s warm) always runs: build once, then
# typecheck, cargo test, syntax checks, unit tests, the extension's sync code against a local server,
# and every server e2e, all at once, each on its own port and temporary database. The two live
# LinkedIn browser tests (~2.5 min) run only when the extension, their scripts, or the site's
# sign-in handshake changed since they last passed on this machine (hash in .check-live-pass).
# CHECK_LIVE=always forces them, CHECK_LIVE=never skips them (exit 3 if they were due);
# `scripts/check.sh --live-status` says whether they would run.
check:
    scripts/check.sh

# LinkedIn sessions expire after a couple of weeks; then test-extension-e2e fails NOT_LOGGED_IN.
# Opens a visible window on the e2e profile at the login page: sign in, then close the window.
# Refresh the extension e2e's Chrome profile (.chromium-dev-profile) LinkedIn login.
dev-profile-login:
    @command -v chromium >/dev/null || { echo "missing: chromium" >&2; exit 1; }
    @rm -f .chromium-dev-profile/SingletonLock .chromium-dev-profile/SingletonSocket .chromium-dev-profile/SingletonCookie
    chromium --user-data-dir="$PWD/.chromium-dev-profile" --no-first-run --no-default-browser-check https://www.linkedin.com/login || true
    @echo "Signed in? Close the window, then run: just test-extension-e2e"

# Drive the extension's LinkedIn collectors in headless Chromium on the signed-in dev profile
# (.chromium-dev-profile) and assert the follower count, posts, and comments come back right.
# Set EXPECTED_FOLLOWERS=<n> to also assert the count within 15%. Session expired? `just dev-profile-login`.
test-extension-e2e: extension-dev
    node scripts/test-extension-e2e.mjs

# Drive no-password sign-in in headless Chromium on the signed-in dev profile: open the join link
# on a throwaway local server and assert the site signs in and the first sync stores posts.
test-join-flow-e2e: extension-dev
    cd server && cargo build --bin linkedin-challenge-server
    node scripts/test-join-flow-e2e.mjs

# Verify repost comment collisions and multi-device sync tokens on an isolated local database.
test-sync-devices-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-sync-devices-e2e.py

# Verify no-password sign-in (join code, device token to website session) and the admin toggle.
test-extension-join-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-extension-join-e2e.py

# Verify the admin post report, API keys and /api/v1/posts (filters, CSV) on an isolated database.
test-reports-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-reports-e2e.py

# Verify deleting an account: who may, the refusals, that every way in is closed while the
# person's data is kept, and restoring it.
test-delete-member-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-delete-member-e2e.py

# Verify that a post reading is stored only when its numbers change, on an isolated database.
test-snapshot-dedupe-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-snapshot-dedupe-e2e.py

# Verify the company stats overview (posts, people, impressions gained, buckets, your share) and
# that challenges are admin-only, on an isolated database.
test-stats-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-stats-e2e.py

# Verify the "Chrome paused the extension" flag: stale after two days without a sync, or never.
test-sync-banner-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-sync-banner-e2e.py

# Exercise password auth against a real server and isolated temporary database.
test-auth-e2e:
    server/scripts/test-auth-e2e.sh

# On a clean, pushed commit: run all checks and post the required GitHub commit status.
signoff:
    scripts/local-check-signoff.sh

# Verify follower sync, access controls, and scoring on an isolated local database.
test-followers-e2e:
    cd server && cargo build --bin linkedin-challenge-server
    python3 server/scripts/test-followers-e2e.py
