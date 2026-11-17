#!/bin/sh
# wrangler's build command: worker-build (pinned) compiles the room to wasm and writes build/.
# The pinned worker-build is installed into .tools/ the first time (needs network once).
set -eu
cd "$(dirname "$0")"
want=0.9.0
bin=.tools/bin/worker-build
if ! [ -x "$bin" ] || [ "$("$bin" --version 2>/dev/null)" != "$want" ]; then
  echo "plaza/build.sh: installing worker-build $want into plaza/.tools" >&2
  cargo install --quiet --locked worker-build --version "$want" --root .tools
fi
exec "$bin" --release
