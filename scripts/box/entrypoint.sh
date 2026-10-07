#!/bin/sh
# A sandbox box's main process (scripts/box/Dockerfile, issue #308): its herdr session, then the hopper
# client — which joins with HOPPER_JOIN the first time and dials in from then on. The root is read-only,
# so the client runs from its home volume: copied there once, where a release the hopper loads stays.
# The client exits 75 to run a release it was given, and is started again here; anything else ends the box.
set -eu
lib="$HOME/.local/lib/hopper-client"
if [ ! -f "$lib/main.ts" ]; then
  mkdir -p "$HOME/.local/lib"
  cp -r /usr/local/lib/hopper-client "$lib"
fi
herdr --session hopper-client server &
herdr=$!
client=
stop() { [ -n "$client" ] && kill "$client" 2>/dev/null; kill "$herdr" 2>/dev/null; exit 0; }
trap stop TERM INT
while :; do
  node "$lib/main.ts" &
  client=$!
  code=0
  wait "$client" || code=$?
  [ "$code" = 75 ] || { kill "$herdr" 2>/dev/null; exit "$code"; }
done
