#!/usr/bin/env bash
# The local check pipeline (`just check`): build once, then run every independent check at the
# same time, each with its output captured to its own log.
#
# Prints one line per step (pass/FAIL and how long it took), the tail of each failing step's log,
# and the total, and exits non-zero if any step failed.
#
# What may overlap, and why:
#   - The server e2e scripts (server/scripts/test-*.py, test-auth-e2e.sh) each start their own
#     debug server on PORT=0 (a free port the OS picks) with a fresh temporary database, so they
#     share nothing and all run at once.
#   - The two browser tests share the LinkedIn-signed-in profile (.chromium-dev-profile), which one
#     Chromium can hold at a time, and test-join-flow-e2e needs port 3312 (the dev extension build
#     is baked for it). They run one after the other, alongside everything else.
#   - Everything that runs the server binary waits for `cargo build`; cargo test waits for it too,
#     so the two don't fight over the build lock.
#
# Usage: scripts/check.sh
#   KEEP_LOGS=1           keep the per-step logs and print where they are
#   CHECK_SKIP_BROWSER=1  leave out the two LinkedIn browser tests (reported as skipped, exit 1)
set -uo pipefail

cd "$(dirname "$0")/.."
root=$PWD

# Never let a check reach a real database: every e2e script sets its own temporary one, and this
# makes sure nothing falls back to a DATABASE_URL from the calling shell.
unset DATABASE_URL DATABASE_URL_UNPOOLED

logs=$(mktemp -d "${TMPDIR:-/tmp}/check.XXXXXX")
if [ -z "${KEEP_LOGS:-}" ]; then
  trap 'rm -rf "$logs"' EXIT
fi

now_ms() { date +%s%3N; }
started=$(now_ms)

steps=()      # in the order they are reported
declare -A pids=()

# timed NAME COMMAND...: run a step in the foreground, recording its exit code and duration.
timed() {
  local name=$1 t0 rc
  shift
  t0=$(now_ms)
  ("$@") >"$logs/$name.log" 2>&1
  rc=$?
  echo "$rc $(($(now_ms) - t0))" >"$logs/$name.result"
  return $rc
}

# run NAME COMMAND...: the same, in the background.
run() {
  steps+=("$1")
  timed "$@" &
  pids[$1]=$!
}

# run_now NAME COMMAND...: a reported step in the foreground; returns its exit code.
run_now() {
  steps+=("$1")
  timed "$@"
}

# Steps whose prerequisite failed are reported as skipped, not run (and fail the pipeline).
skip() {
  steps+=("$1")
  echo "skip 0" >"$logs/$1.result"
  echo "not run: $2" >"$logs/$1.log"
}

syntax() {
  local f
  for f in extension/*.js; do node --check "$f" || return 1; done
  bash -n extension/build.sh
}

# The two browser tests, in turn, on the signed-in profile.
profile=$root/.chromium-dev-profile
chromium_on_profile() { pgrep -a chromium 2>/dev/null | grep -F -- "--user-data-dir=$profile" || true; }
browser_preflight() {
  local open
  open=$(chromium_on_profile)
  if [ -n "$open" ]; then
    echo "a Chromium is already running on $profile; close it first (not killed):"
    echo "$open"
    return 1
  fi
}
# Chromium can take a moment to let go of the profile after the first test stops it.
wait_for_profile() {
  local i
  for i in $(seq 1 100); do
    [ -z "$(chromium_on_profile)" ] && return 0
    sleep 0.1
  done
  echo "Chromium from the previous browser test still holds $profile"
  return 1
}

# --- build ---------------------------------------------------------------------------------------
run_now client-ensure bash -c 'cd server && npm run client:ensure'
client_ok=$?
if [ $client_ok = 0 ]; then
  run typecheck bash -c 'cd server && npm run typecheck'
  run_now cargo-build bash -c 'cd server && cargo build'
  build_ok=$?
else
  skip typecheck "client-ensure failed"
  skip cargo-build "client-ensure failed"
  build_ok=1
fi

# --- checks that need no server binary ------------------------------------------------------------
run syntax syntax
run refresh-window node scripts/test-refresh-window.mjs
run diff-check git diff --check

# --- checks that run the server ------------------------------------------------------------------
server_steps=(
  "auth server/scripts/test-auth-e2e.sh"
  "followers python3 server/scripts/test-followers-e2e.py"
  "sync-devices python3 server/scripts/test-sync-devices-e2e.py"
  "extension-join python3 server/scripts/test-extension-join-e2e.py"
  "reports python3 server/scripts/test-reports-e2e.py"
  "delete-member python3 server/scripts/test-delete-member-e2e.py"
  "snapshot-dedupe python3 server/scripts/test-snapshot-dedupe-e2e.py"
  "stats python3 server/scripts/test-stats-e2e.py"
  "sync-banner python3 server/scripts/test-sync-banner-e2e.py"
)
# The browser tests, one after the other. The join-flow test runs even if the extension test
# failed: they check different things.
extension_e2e() { browser_preflight && node scripts/test-extension-e2e.mjs; }
join_flow_e2e() { wait_for_profile && node scripts/test-join-flow-e2e.mjs; }
browser_chain() {
  timed extension-e2e extension_e2e
  timed join-flow-e2e join_flow_e2e
}
if [ $build_ok = 0 ]; then
  run cargo-test bash -c 'cd server && cargo test'
  for entry in "${server_steps[@]}"; do
    # shellcheck disable=SC2086
    run $entry
  done
  if [ -n "${CHECK_SKIP_BROWSER:-}" ]; then
    # For iterating without touching LinkedIn. Still a failed (incomplete) check overall.
    skip extension-e2e "CHECK_SKIP_BROWSER is set"
    skip join-flow-e2e "CHECK_SKIP_BROWSER is set"
  else
    # One chain in the background, reported as its two steps.
    steps+=(extension-e2e join-flow-e2e)
    browser_chain &
  fi
else
  skip cargo-test "cargo-build failed"
  for entry in "${server_steps[@]}"; do skip "${entry%% *}" "cargo-build failed"; done
  skip extension-e2e "cargo-build failed"
  skip join-flow-e2e "cargo-build failed"
fi

wait

# --- report --------------------------------------------------------------------------------------
failed=()
for name in "${steps[@]}"; do
  read -r rc ms <"$logs/$name.result"
  if [ "$rc" = skip ]; then
    status=skip
    failed+=("$name")
  elif [ "$rc" = 0 ]; then
    status=ok
  else
    status=FAIL
    failed+=("$name")
  fi
  printf '%-5s %-16s %6.1fs\n' "$status" "$name" "$(awk "BEGIN { print $ms / 1000 }")"
done
total=$(( $(now_ms) - started ))
printf '%-22s %6.1fs\n' "total (wall clock)" "$(awk "BEGIN { print $total / 1000 }")"

if [ ${#failed[@]} -gt 0 ]; then
  for name in "${failed[@]}"; do
    echo
    echo "--- $name: last 40 lines of output ---"
    tail -n 40 "$logs/$name.log"
  done
  echo
  echo "FAILED: ${failed[*]}"
  [ -n "${KEEP_LOGS:-}" ] && echo "logs: $logs"
  exit 1
fi
[ -n "${KEEP_LOGS:-}" ] && echo "logs: $logs"
echo "all checks passed"
