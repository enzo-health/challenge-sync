#!/usr/bin/env bash
# Where does a request's time go? Calls the busy GET routes and puts curl's
# client-side timings next to the server's own Server-Timing segments, so you
# can tell time spent in our function from time spent getting to it.
#
#   server/scripts/timings.sh http://127.0.0.1:3000
#   server/scripts/timings.sh https://social-challenge.enzo.health 'session=...'
#   N=5 server/scripts/timings.sh https://social-challenge.enzo.health
#
# GET only (read-only). The optional cookie is sent as a `Cookie:` header and
# never printed; without it the signed-in routes answer 401, and their row
# still shows. Each route gets one cold request (it pays for TCP/TLS, shown as
# connect/tls) and then N (default 3) warm requests on the same connection;
# the other columns are the median of those warm requests.
#
# Needs bash, curl >= 7.84 (for %header{}) and awk. See server/AGENTS.md,
# "Diagnosing a slow route".
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <base-url> [cookie]   (env N=<warm repeats>, default 3)" >&2
  exit 2
fi
base=${1%/}
cookie=${2:-}
n=${N:-3}
case $n in '' | *[!0-9]* | 0)
  echo "N must be a positive integer, got '$n'" >&2
  exit 2
  ;;
esac

routes=(
  /api/health
  /api/auth/me
  /api/leaderboard
  /api/stats/overview
  /api/me/posts
  /api/v1/stats
  /api/system/overview
)

# One line per request: status, connect, tls, ttfb, total (seconds), the
# Server-Timing header, the x-vercel-id header; tab-separated.
format='%{http_code}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%header{server-timing}\t%header{x-vercel-id}\n'

# sample ROUTE: the cold request plus N warm ones in a single curl, so the
# warm ones reuse the connection.
sample() {
  local args=(-sS --max-time 30 -w "$format") i
  for ((i = 0; i <= n; i++)); do args+=(-o /dev/null "$base$1"); done
  if [ -n "$cookie" ]; then
    # Through a file descriptor, not argv, so the cookie doesn't show in ps.
    curl "${args[@]}" -H @<(printf 'Cookie: %s\n' "$cookie")
  else
    curl "${args[@]}"
  fi
}

printf '%s  (%s warm request(s) per route, median; ms)\n\n' "$base" "$n"
printf '%-22s %6s %7s %7s %8s %8s %8s  %-12s %s\n' \
  route status connect tls ttfb 'ttfb-min' 'outside' 'x-vercel-id' 'server-timing'

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
for route in "${routes[@]}"; do
  if ! out=$(sample "$route" 2>"$errors"); then
    printf '%-22s %6s  %s\n' "$route" '-' "$(tail -1 "$errors")"
    continue
  fi
  printf '%s\n' "$out" | awk -F'\t' -v route="$route" '
    function median(list,    k, a, m) {
      m = split(list, a, " ")
      if (m == 0) return ""
      # insertion sort; m is small
      for (k = 2; k <= m; k++) {
        v = a[k] + 0; j = k - 1
        while (j >= 1 && a[j] + 0 > v) { a[j + 1] = a[j]; j-- }
        a[j + 1] = v
      }
      return (m % 2) ? a[(m + 1) / 2] : (a[m / 2] + a[m / 2 + 1]) / 2
    }
    function ms(s) { return s * 1000 }
    NR == 1 { connect = ms($2); tls = ms($3); vid = $7; status = $1; next }
    {
      status = $1; vid = ($7 != "" ? $7 : vid)
      ttfbs = ttfbs " " ms($4)
      if (min == "" || ms($4) < min) min = ms($4)
      nseg = split($6, entries, ",")
      for (e = 1; e <= nseg; e++) {
        entry = entries[e]; gsub(/^ +| +$/, "", entry)
        if (entry ~ /^route;desc=/) { desc = entry; sub(/^route;desc=/, "", desc); continue }
        if (entry !~ /;dur=/) continue
        name = entry; sub(/;.*/, "", name)
        dur = entry; sub(/.*;dur=/, "", dur)
        if (!(name in seen)) { seen[name] = 1; order[++names] = name }
        durs[name] = durs[name] " " dur
      }
    }
    END {
      if (NR == 0) { printf "%-22s %6s  no response\n", route, "-"; exit }
      ttfb = (ttfbs == "" ? "" : median(ttfbs))
      segs = ""
      for (i = 1; i <= names; i++) {
        v = median(durs[order[i]])
        segs = segs sprintf("%s=%.1f ", order[i], v)
        if (order[i] == "total") total = v
      }
      # Keep edge::function regions; drop the per-request id.
      if (split(vid, parts, "::") >= 2) vid = parts[1] "::" parts[2]
      if (desc != "") segs = segs "route=" desc
      if (segs == "") segs = "(no Server-Timing header)"
      outside = (ttfb != "" && total != "") ? sprintf("%.1f", ttfb - total) : "-"
      printf "%-22s %6s %7.1f %7.1f %8.1f %8.1f %8s  %-12s %s\n", route, status, connect, tls,
        ttfb, min, outside, (vid == "" ? "-" : vid), segs
    }'
done

cat <<'EOF'

  connect/tls  cold request only: TCP connect / TLS handshake done (ms since start); warm requests reuse it
  ttfb         time to first response byte, client side (median of warm; ttfb-min = fastest)
  outside      ttfb - total: network, TLS, Vercel edge and proxy hops, i.e. time not in our function
  x-vercel-id  edge region::function region (e.g. sfo1::pdx1); absent locally
  mw           nextrs middleware chain          seed     page data seeding (pages only)
  handler      the route function itself        total    whole request inside the function
  session      cookie/bearer session lookup     auth     reporting API key or admin check
  db, db-<x>   database queries (db-posts, db-members, db-profiles, ...)
  route        the route pattern that matched
  Server-Timing values are server-side ms inside the function; signed-out 0.0 is real (no I/O).
EOF
