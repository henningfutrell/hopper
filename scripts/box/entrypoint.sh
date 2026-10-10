#!/bin/sh
# A sandbox box's main process (scripts/box/Dockerfile, issue #308): its herdr session, then the hopper
# client — which joins with HOPPER_JOIN the first time and dials in from then on. The root is read-only,
# so the client runs from its home volume: copied there once, where a release the hopper loads stays.
# The client exits 75 to run a release it was given, and is started again here; anything else ends the box.
# The join line leaves the environment first (issue #606): it goes to a file only this user can read, and the
# entrypoint runs itself again without HOPPER_JOIN, so this process, herdr and the jobs in its panes never hold
# it. The client reads the file (HOPPER_JOIN_FILE) once and removes it.
set -eu
join_file="${TMPDIR:-/tmp}/hopper-join"
if [ -n "${HOPPER_JOIN:-}" ]; then
  (umask 077 && printf '%s\n' "$HOPPER_JOIN" > "$join_file")
  exec env -u HOPPER_JOIN sh "$0"
fi
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
  if [ -f "$join_file" ]; then HOPPER_JOIN_FILE="$join_file" node "$lib/main.ts" & else node "$lib/main.ts" & fi
  client=$!
  code=0
  wait "$client" || code=$?
  [ "$code" = 75 ] || { kill "$herdr" 2>/dev/null; exit "$code"; }
done
