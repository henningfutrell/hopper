#!/usr/bin/env bash
# The docker socket the hopper uses (issue #59, design.md "Target authentication"). Docker's own
# socket has no authentication: whoever can open it is root on this machine, and the root daemon's
# socket opens to the whole docker group. So the hopper never uses it (its unit makes it
# inaccessible); it uses this: an allowlisting socket proxy (wollomatic/socket-proxy, pinned by
# digest) that lets through ping, inspect and exec on the named container targets and refuses
# everything else, listening on a socket only this user may open. The proxy runs in a container with
# no network, a read-only root and no capabilities, restarted with docker. Re-running replaces it
# with the new allowlist. Then print the daemon.env line.
#   usage: docker-proxy.sh <container> [<container>...]
#   JOB_HOPPER_DOCKER_DIR (default ~/.local/state/job-hopper/docker) holds the socket.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${JOB_HOPPER_DOCKER_DIR:-$HOME/.local/state/job-hopper/docker}"
NAME="${JOB_HOPPER_DOCKER_PROXY_NAME:-job-hopper-docker-proxy}"
ROOT_SOCKET=/var/run/docker.sock

usage() { echo "usage: $0 <container> [<container>...]" >&2; exit 2; }
[ $# -ge 1 ] || usage
for c in "$@"; do case "$c" in -*|'') usage ;; esac; done

step() { printf '==> %s\n' "$*" >&2; }
die() { printf 'docker-proxy: %s\n' "$*" >&2; exit 1; }

# The image and the allowlist come from the daemon's own code (src/executors/docker.ts), one owner.
mapfile -t ALLOW < <(node --input-type=module -e '
  const { proxyAllowlist, SOCKET_PROXY_IMAGE } = await import(process.argv[1]);
  for (const a of [SOCKET_PROXY_IMAGE, ...proxyAllowlist(process.argv.slice(2))]) console.log(a);
' "$APP_DIR/src/executors/docker.ts" "$@") || die "bad container name"
IMAGE="${ALLOW[0]}"

step "socket directory $DIR (only this user)"
install -d -m 700 "$DIR"
chmod 700 "$DIR"

step "start $NAME for: $*"
docker rm -f -- "$NAME" >/dev/null 2>&1 || true
rm -f "$DIR/docker.sock"
docker run -d --name "$NAME" --restart unless-stopped \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(stat -c %g "$ROOT_SOCKET")" \
  -v "$ROOT_SOCKET:$ROOT_SOCKET:ro" -v "$DIR:/run/proxy" \
  "$IMAGE" -proxysocketendpoint /run/proxy/docker.sock -proxysocketendpointfilemode 384 "${ALLOW[@]:1}" >/dev/null

for _ in $(seq 1 50); do [ -S "$DIR/docker.sock" ] && break; sleep 0.2; done
[ -S "$DIR/docker.sock" ] || die "the proxy did not open $DIR/docker.sock (docker logs $NAME)"
docker --host "unix://$DIR/docker.sock" version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  && die "the proxy lets through more than it should (docker version answered)"

step "the hopper reaches docker through unix://$DIR/docker.sock; add to daemon.env:"
echo "JOB_HOPPER_DOCKER_HOST=unix://$DIR/docker.sock"
