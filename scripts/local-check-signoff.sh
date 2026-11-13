#!/usr/bin/env bash
# Run the repository's checks locally, then publish a GitHub commit status that branch protection
# can require without running the build suite in GitHub Actions.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit all tracked changes before signing off; the status must describe one exact commit." >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) is required." >&2; exit 1; }

sha=$(git rev-parse HEAD)
branch=$(git branch --show-current)
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
if [ -z "$upstream" ] || ! git merge-base --is-ancestor "$sha" "$upstream"; then
  echo "Push $branch before signing off so GitHub knows commit $sha." >&2
  exit 1
fi

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
post_status() {
  gh api --method POST "repos/$repo/statuses/$sha" \
    -f state="$1" \
    -f context='local-checks' \
    -f description="$2" >/dev/null
}

# A sign-off never skips the live LinkedIn browser tests when the extension changed: they run
# unless the extension (and the files those tests depend on) is byte-for-byte what they last passed
# with on this machine. See scripts/check.sh. CHECK_LIVE=always is honoured; never is not.
if [ "${CHECK_LIVE:-auto}" != always ]; then
  export CHECK_LIVE=auto
fi
live=$(scripts/check.sh --live-status)
case $live in
  skip-unchanged*) passed="All local checks passed; LinkedIn browser tests skipped, extension unchanged since their last pass" ;;
  *)               passed="All local checks passed, including the live LinkedIn browser tests" ;;
esac
echo "$live"

post_status pending "Local checks are running"
if just check; then
  post_status success "$passed"
  echo "GitHub status local-checks=success posted for $sha: $passed"
else
  post_status failure "Local checks failed"
  exit 1
fi
