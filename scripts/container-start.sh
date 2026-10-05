#!/bin/sh
# The image's entrypoint (Dockerfile, compose.yaml): starts job-hopper's own herdr session, where jobs
# run on this container's `local` machine, then runs the command (the daemon). The session is kept
# running as job-hopper-herdr.service keeps it on a host: started again when it stops.
set -eu
(
  while :; do
    herdr --session job-hopper status server 2>/dev/null | grep -q '^status: running' \
      || herdr --session job-hopper server >/dev/null 2>&1 || true
    sleep 2
  done
) &
exec "$@"
