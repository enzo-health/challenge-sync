#!/usr/bin/env bash
# Build a distributable extension for one server.
#
#   ./build.sh https://challenge.example.com        -> dist/challenge-sync-<version>.zip
#   ./build.sh http://localhost:3312 --dir          -> dist/unpacked/ (load unpacked, no zip)
#
# The server URL is a build-time constant, in THREE places that must agree: SERVER_URL in
# config.js, the matching entry in manifest.json's host_permissions, and the content script's
# `matches`. The extension reads the site's
# session cookie, and Chrome only allows that for an origin the manifest declares — so a build with
# one updated and not the other fails to connect with no useful message. This script writes both
# from a single argument, which is the whole reason it exists.
set -euo pipefail
cd "$(dirname "$0")"

url=${1:-}
if [ -z "$url" ]; then
    echo "usage: ./build.sh <server-url> [--dir]" >&2
    echo "   e.g. ./build.sh https://challenge.example.com" >&2
    exit 1
fi
url=${url%/}   # a trailing slash breaks the host_permissions match pattern

case "$url" in
    https://*) ;;
    http://localhost*|http://127.0.0.1*) echo "note: building against a local server — for development only" >&2 ;;
    http://*) echo "REFUSING: $url is plain http and not localhost. The sync token would travel in clear text." >&2; exit 1 ;;
    *) echo "REFUSING: $url does not look like a URL." >&2; exit 1 ;;
esac

out=dist/unpacked
rm -rf dist && mkdir -p "$out"
cp -r manifest.json *.js *.html *.css icons generated "$out"/

python3 - "$url" "$out" <<'PY'
import json, pathlib, re, sys
url, out = sys.argv[1], pathlib.Path(sys.argv[2])

config = out / "config.js"
text = config.read_text()
text, n = re.subn(r'export const SERVER_URL = "[^"]*";', f'export const SERVER_URL = "{url}";', text)
assert n == 1, "SERVER_URL not found in config.js — did it get renamed?"
config.write_text(text)

manifest_path = out / "manifest.json"
manifest = json.loads(manifest_path.read_text())
# Keep LinkedIn; replace whatever server origin was there with this build's.
hosts = [h for h in manifest["host_permissions"] if "linkedin.com" in h]
hosts.append(f"{url}/*")
manifest["host_permissions"] = hosts
manifest["homepage_url"] = url
# The bridge content script runs on the server's pages only, so it follows the same origin.
for script in manifest.get("content_scripts", []):
    script["matches"] = [f"{url}/*"]
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

print(f"  server URL : {url}")
print(f"  host perms : {hosts}")
print(f"  version    : {manifest['version']}")
print(f"  homepage   : {manifest['homepage_url']}")
PY

# Prove the two agree, so a mismatch can never ship.
python3 - "$out" <<'PY'
import json, pathlib, re, sys
out = pathlib.Path(sys.argv[1])
server = re.search(r'export const SERVER_URL = "([^"]*)";', (out / "config.js").read_text()).group(1)
hosts = json.loads((out / "manifest.json").read_text())["host_permissions"]
homepage = json.loads((out / "manifest.json").read_text())["homepage_url"]
if not any(h.startswith(server) for h in hosts):
    raise SystemExit(f"MISMATCH: SERVER_URL {server} has no matching host_permission in {hosts}")
if homepage != server:
    raise SystemExit(f"MISMATCH: SERVER_URL {server} does not match homepage_url {homepage}")
bridge = [m for s in json.loads((out / "manifest.json").read_text()).get("content_scripts", []) for m in s["matches"]]
if bridge != [f"{server}/*"]:
    raise SystemExit(f"MISMATCH: SERVER_URL {server} does not match content script matches {bridge}")
print("  verified   : config.js and manifest.json agree")
PY

if [ "${2:-}" = "--dir" ]; then
    echo "built $out (load unpacked from there)"
    exit 0
fi

version=$(python3 -c "import json;print(json.load(open('$out/manifest.json'))['version'])")
zip="dist/challenge-sync-${version}.zip"
(cd "$out" && zip -qr "../../$zip" .)
echo "built $zip"
