#!/bin/sh
# A sandbox box's main process (scripts/box/Dockerfile, issue #308): its herdr session, then the hopper
# client — which joins with HOPPER_JOIN the first time and dials in from then on. The root is read-only,
# so the client runs from its home volume: copied there once, where a release the hopper loads stays.
# The client exits 75 to run a release it was given, and is started again here; anything else ends the box.
# The join line leaves the environment first (issue #606): it goes to a file only this user can read, and the
# entrypoint runs itself again without HOPPER_JOIN, so this process, herdr and the jobs in its panes never hold
# it. The client reads the file (HOPPER_JOIN_FILE) once and removes it.
# Told to stop, it stops the client and waits for it before herdr, whose panes the jobs run in: a lane pod's client
# (HOPPER_CLIENT_DRAIN, issue #1284) first leaves the hopper and lets the jobs on it end.
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
# The trap is set before anything starts, and a stop that comes before the client's pid is kept (between its start and
# `client=$!`) is only noted: the loop stops once it knows the pid, so the client still ends before herdr (issue #1884).
# A child is told to stop only once it runs its own program: between its fork and its exec it still has this shell's
# trap, and dash drops a TERM that comes there, so the wait for the client never ended (issue #1950). Until the exec
# its command line is this shell's.
herdr= client= starting= stopping=
self=$(tr '\0' ' ' < "/proc/$$/cmdline")
halt() {
  while [ "$(tr '\0' ' ' 2>/dev/null < "/proc/$1/cmdline")" = "$self" ]; do sleep 0.05; done
  kill "$1" 2>/dev/null || :
}
stop() {
  if [ -n "$starting" ]; then stopping=1; return; fi
  if [ -n "$client" ]; then halt "$client"; wait "$client" 2>/dev/null || :; fi
  [ -z "$herdr" ] || halt "$herdr"
  exit 0
}
trap stop TERM INT
starting=1
herdr --session hopper-client server &
herdr=$!
starting=
[ -z "$stopping" ] || stop
while :; do
  starting=1
  if [ -f "$join_file" ]; then HOPPER_JOIN_FILE="$join_file" node "$lib/main.ts" & else node "$lib/main.ts" & fi
  client=$!
  starting=
  [ -z "$stopping" ] || stop
  code=0
  wait "$client" || code=$?
  [ "$code" = 75 ] || { halt "$herdr"; exit "$code"; }
done
