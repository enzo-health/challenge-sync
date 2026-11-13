#!/usr/bin/env bash
# The local check pipeline (`just check`), in two tiers.
#
# FAST TIER, always, a couple of seconds: build once, then everything at the same time: typecheck,
# cargo test, syntax checks, the refresh-window unit test, the extension's own sync code against a
# local server (scripts/test-extension-sync-e2e.mjs), and every server e2e. Each server e2e starts
# its own debug server on PORT=0 (a free port the OS picks) with a fresh temporary database, so
# they share nothing.
#
# LIVE TIER, only when it can have changed: the two browser tests that drive the real extension
# against the owner's live LinkedIn account (test-extension-e2e, then test-join-flow-e2e; ~2.5
# minutes, one after the other because they share .chromium-dev-profile and port 3312). They run
# when anything they depend on differs from the last time both passed on this machine:
#
#   - every tracked or new (not ignored) file under extension/ (dist/ is ignored),
#   - the two test scripts,
#   - the site's half of the sign-in handshake that only they exercise: server/app/join/ and
#     server/components/get-started.tsx (bridge.js talks to it).
#
# That is a content hash, so uncommitted edits count and it doesn't matter how far behind main is.
# After both pass, the hash is written to .check-live-pass (git-ignored, per machine); a later run
# with the same hash skips them and still passes. Before they run, extension/dist/unpacked (which
# they load) must match a fresh build of the sources, or the pass would be recorded for code that
# was never tested.
#
# Prints one line per step (ok/FAIL/skip and how long it took), the tail of each failing step's
# log, and the total.
#
# Usage: scripts/check.sh [--live-status]
#   --live-status   only say whether the live tests would run, and why; run nothing
#   CHECK_LIVE=auto     (default) run the live tests only when their inputs changed
#   CHECK_LIVE=always   run them regardless
#   CHECK_LIVE=never    skip them; if their inputs changed this is reported loudly and exits 3
#   KEEP_LOGS=1         keep the per-step logs and print where they are
#
# Exit status: 0 everything that had to run passed (live tests run or unchanged); 1 a step failed;
# 3 the fast tier passed but the live tests were force-skipped although their inputs changed.
set -uo pipefail

cd "$(dirname "$0")/.."
root=$PWD

# Never let a check reach a real database: every e2e script sets its own temporary one, and this
# makes sure nothing falls back to a DATABASE_URL from the calling shell.
unset DATABASE_URL DATABASE_URL_UNPOOLED

# --- does the live tier need to run? -------------------------------------------------------------
live_record=$root/.check-live-pass
live_paths=(extension scripts/test-extension-e2e.mjs scripts/test-join-flow-e2e.mjs
            server/app/join server/components/get-started.tsx)

live_hash() {
  git ls-files -z -c -o --exclude-standard -- "${live_paths[@]}" | sort -zu |
    while IFS= read -r -d '' f; do
      if [ -f "$f" ]; then
        printf '%s %s\n' "$(sha256sum <"$f" | cut -c1-64)" "$f"
      else
        printf 'deleted %s\n' "$f"
      fi
    done | sha256sum | cut -c1-64
}
recorded() { [ -f "$live_record" ] && sed -n "s/^$1=//p" "$live_record"; }

hash_now=$(live_hash)
mode=${CHECK_LIVE:-auto}
if [ -n "$(recorded hash)" ] && [ "$(recorded hash)" = "$hash_now" ]; then
  unchanged=true
  since="extension unchanged since its last live pass ($(recorded date), $(recorded commit))"
else
  unchanged=false
  if [ -f "$live_record" ]; then since="extension changed since its last live pass ($(recorded date), $(recorded commit))"
  else since="no live pass of this extension recorded on this machine"; fi
fi
case "$mode" in
  auto)   if $unchanged; then live=skip-unchanged; else live=run; fi ;;
  always) live=run ;;
  never)  if $unchanged; then live=skip-unchanged; else live=skip-forced; fi ;;
  *) echo "CHECK_LIVE must be auto, always or never (got: $mode)" >&2; exit 2 ;;
esac

if [ "${1:-}" = "--live-status" ]; then
  # First word is machine-readable: run | skip-unchanged | skip-forced.
  case $live in
    run)            echo "run: the live LinkedIn tests would run; $since (CHECK_LIVE=$mode)" ;;
    skip-unchanged) echo "skip-unchanged: $since" ;;
    skip-forced)    echo "skip-forced: CHECK_LIVE=never, but $since" ;;
  esac
  exit 0
fi

# --- step plumbing -------------------------------------------------------------------------------
logs=$(mktemp -d "${TMPDIR:-/tmp}/check.XXXXXX")
if [ -z "${KEEP_LOGS:-}" ]; then
  trap 'rm -rf "$logs"' EXIT
fi

now_ms() { date +%s%3N; }
started=$(now_ms)

steps=()      # in the order they are reported

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
}
# run_now NAME COMMAND...: a reported step in the foreground; returns its exit code.
run_now() {
  steps+=("$1")
  timed "$@"
}
# skip NAME KIND REASON: a step not run. KIND is "skip" (fine), "unmet" (a prerequisite failed)
# or "forced" (CHECK_LIVE=never with changed inputs); the last two do not pass.
skip() {
  steps+=("$1")
  echo "$2 0" >"$logs/$1.result"
  echo "$3" >"$logs/$1.log"
}

syntax() {
  local f
  for f in extension/*.js; do node --check "$f" || return 1; done
  bash -n extension/build.sh
}

# --- the live tier's helpers ---------------------------------------------------------------------
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
# The browser tests load extension/dist/unpacked; it must be what the sources build to now.
unpacked_current() {
  local tmp
  tmp=$(mktemp -d)
  rsync -a --exclude dist extension/ "$tmp/"
  (cd "$tmp" && ./build.sh http://localhost:3312 --dir >/dev/null 2>&1) || { rm -rf "$tmp"; echo "build.sh failed"; return 1; }
  if ! diff -r "$tmp/dist/unpacked" extension/dist/unpacked >/dev/null 2>&1; then
    rm -rf "$tmp"
    echo "extension/dist/unpacked is missing or older than the sources: run \`just extension-dev\`"
    echo "(cd extension && ./build.sh http://localhost:3312 --dir), then check again."
    return 1
  fi
  rm -rf "$tmp"
}
live_preflight() { browser_preflight && unpacked_current; }
join_flow_e2e() { wait_for_profile && node scripts/test-join-flow-e2e.mjs; }
live_chain() {
  if ! timed live-preflight live_preflight; then
    skip extension-e2e unmet "not run: live-preflight failed"
    skip join-flow-e2e unmet "not run: live-preflight failed"
    return
  fi
  timed extension-e2e node scripts/test-extension-e2e.mjs
  local first=$?
  timed join-flow-e2e join_flow_e2e
  local second=$?
  # Record only a pass of both, for exactly the inputs that were tested.
  if [ $first = 0 ] && [ $second = 0 ] && [ "$(live_hash)" = "$hash_now" ]; then
    printf 'hash=%s\ndate=%s\ncommit=%s\n' "$hash_now" "$(date '+%Y-%m-%d %H:%M')" \
      "$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- "${live_paths[@]}" || echo '+uncommitted')" >"$live_record"
  fi
}

# --- build ---------------------------------------------------------------------------------------
# Plain node rather than `npm run`: same scripts, without npm's start-up on the critical path.
if run_now client-ensure node server/.nextrs/ensure-client.mjs; then
  run typecheck bash -c 'cd server && npm run --silent typecheck'
  run_now cargo-build bash -c 'cd server && cargo build --quiet'
  build_ok=$?
else
  skip typecheck unmet "not run: client-ensure failed"
  skip cargo-build unmet "not run: client-ensure failed"
  build_ok=1
fi

# --- checks that need no server binary ------------------------------------------------------------
run syntax syntax
run refresh-window node scripts/test-refresh-window.mjs
run diff-check git diff --check

# --- checks that run the server, and the live tier -----------------------------------------------
server_steps=(
  "extension-sync node scripts/test-extension-sync-e2e.mjs"
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
if [ $build_ok = 0 ]; then
  run cargo-test bash -c 'cd server && cargo test --quiet'
  for entry in "${server_steps[@]}"; do
    # shellcheck disable=SC2086
    run $entry
  done
  case $live in
    run)
      steps+=(live-preflight extension-e2e join-flow-e2e)
      live_chain &
      ;;
    skip-unchanged)
      skip extension-e2e skip "$since"
      skip join-flow-e2e skip "$since"
      ;;
    skip-forced)
      skip extension-e2e forced "FORCED SKIP (CHECK_LIVE=never): $since"
      skip join-flow-e2e forced "FORCED SKIP (CHECK_LIVE=never): $since"
      ;;
  esac
else
  skip cargo-test unmet "not run: cargo-build failed"
  for entry in "${server_steps[@]}"; do skip "${entry%% *}" unmet "not run: cargo-build failed"; done
  skip extension-e2e unmet "not run: cargo-build failed"
  skip join-flow-e2e unmet "not run: cargo-build failed"
fi

wait

# --- report --------------------------------------------------------------------------------------
failed=()
forced=()
for name in "${steps[@]}"; do
  read -r rc ms <"$logs/$name.result"
  note=""
  case $rc in
    0)      status=ok ;;
    skip)   status=skip; note="  $(cat "$logs/$name.log")" ;;
    forced) status='SKIP!'; note="  $(cat "$logs/$name.log")"; forced+=("$name") ;;
    unmet)  status=FAIL; note="  $(cat "$logs/$name.log")"; failed+=("$name") ;;
    *)      status=FAIL; failed+=("$name") ;;
  esac
  printf '%-5s %-16s %6.1fs%s\n' "$status" "$name" "$(awk "BEGIN { print $ms / 1000 }")" "$note"
done
total=$(( $(now_ms) - started ))
printf '%-22s %6.1fs\n' "total (wall clock)" "$(awk "BEGIN { print $total / 1000 }")"

for name in "${failed[@]}"; do
  echo
  echo "--- $name: last 40 lines of output ---"
  tail -n 40 "$logs/$name.log"
done
[ -n "${KEEP_LOGS:-}" ] && echo "logs: $logs"
if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "FAILED: ${failed[*]}"
  exit 1
fi
if [ ${#forced[@]} -gt 0 ]; then
  echo
  echo "!!! NOT FULLY CHECKED: the live LinkedIn tests were skipped (CHECK_LIVE=never), but"
  echo "!!! $since."
  echo "!!! Nothing was recorded. Run without CHECK_LIVE=never before signing off."
  exit 3
fi
case $live in
  skip-unchanged) echo "all checks passed (live LinkedIn tests skipped: $since)" ;;
  *)              echo "all checks passed" ;;
esac
