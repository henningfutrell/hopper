#!/usr/bin/env bash
# Start a container target (design.md "Container targets", issue #58): a plain container on this
# machine's docker that the hopper reaches through `docker exec`, not ssh. No agent, no herdr, no
# sshd runs in it: its main process only sleeps, and the command executor runs each job in it.
# No network, read-only root, every capability dropped; /tmp is a tmpfs. Restarted with docker.
# Re-running is safe: a running container is kept, a stopped one started. Then print the
# plugins.yaml lines that attach it.
#   usage: container-target.sh <container> [lanes]
set -euo pipefail

IMAGE="${HOPPER_TARGET_IMAGE:-alpine:latest}"

usage() { echo "usage: $0 <container> [lanes]" >&2; exit 2; }
[ $# -ge 1 ] || usage
NAME="$1"
LANES="${2:-1}"
case "$NAME" in -*|'') usage ;; esac
case "$LANES" in ''|*[!0-9]*|0) usage ;; esac

step() { printf '==> %s\n' "$*" >&2; }

state="$(docker container inspect --format '{{.State.Running}}' -- "$NAME" 2>/dev/null || true)"
if [ "$state" = true ]; then
  step "container $NAME already runs"
elif [ "$state" = false ]; then
  step "start container $NAME"
  docker start -- "$NAME" >/dev/null
else
  step "create container $NAME from $IMAGE"
  docker run -d --name "$NAME" --hostname "$NAME" --restart unless-stopped \
    --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --init "$IMAGE" sleep infinity >/dev/null
fi

docker exec -- "$NAME" true || { echo "container-target: docker exec into $NAME failed" >&2; exit 1; }
step "container $NAME runs; attach it in plugins.yaml (hopper config edit plugins.yaml):"
cat <<YAML
executors:
  - { name: command, plugin: command }
machines:
  - { name: $NAME, plugin: docker, options: { docker: $NAME, lanes: $LANES, executors: [command] } }
YAML
step "the hopper reaches it only through its socket proxy (issue #59): bash scripts/docker-proxy.sh <every container target, $NAME among them>"
