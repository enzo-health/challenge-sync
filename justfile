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

# Ensure the local account and Q3 World Cup challenge exist without resetting synced data.
seed-local:
    cd server && DATABASE_URL=turso:linkedin.db cargo run --bin seed-local

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

# Build once, then run every check at the same time where they can't collide (scripts/check.sh):
# typecheck, cargo test, syntax checks, the refresh-window unit test, and each server e2e on its
# own free port and temporary database, all alongside the two browser tests, which run one after
# the other on the signed-in dev profile against the existing extension/dist/unpacked build. The
# join-flow browser test (two full live LinkedIn syncs, ~2.5 minutes) sets the total. Prints one
# line per step with its time; on failure, the failing step's output.
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
