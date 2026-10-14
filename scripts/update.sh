#!/usr/bin/env bash
# The update of a container install (issue #1104, docs/deploy.md "Update"): one command, in the folder that holds
# compose.yaml. Every image carries this file; run it from the image you update to:
#
#   podman run --rm --pull=always <image> hopper update script | bash -s -- <image>
#   docker run --rm --pull=always <image> hopper update script | bash -s -- <image>
#
# <image> is ghcr.io/henningfutrell/hopper:<channel>; unset, the image compose.yaml names. In order, it:
#   1. finds the compose tool that started the stack and uses it with the project `hopper` (issue #1063): a tool that does
#      not see the stack that runs would start a second stack on the same data, so the update stops before it changes anything;
#   2. takes the master key from HOPPER_MASTER_KEY at launch (a secret manager), else asks for it on the terminal (nothing
#      is shown); without it the update stops, so the hopper never comes back limited. It reads no file and no container;
#   3. backs up the database (hopper-backup.dump), puts in the compose.yaml of the image with the install's own settings
#      (`hopper update carry`; the old one stays as compose.yaml.bak), pulls, stops the stack and starts it on the image,
#      so every container is made again (when it does not start: back to the old compose.yaml and stack);
#   4. checks that the hopper runs the image pulled, answers /api/health, has its master key and that the stack has no
#      drift (`hopper update drift`), and says the result. It exits 1 when one of these fails.
#
#   HOPPER_UPDATE_WAIT  seconds to wait for the hopper's health (default: 180)
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

main() {
  local project=hopper

  [ -f compose.yaml ] || fail "no compose.yaml here: run it in the folder that holds the hopper's compose.yaml"
  local image="${1:-}"
  if [ -z "$image" ]; then
    image="$(sed -n 's/^ *image: \${HOPPER_IMAGE:-\([^}]*\)}.*/\1/p' compose.yaml | head -n 1)"
    [ -n "$image" ] || fail "give the image to update to: bash -s -- ghcr.io/henningfutrell/hopper:<channel>"
  fi
  [[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || fail "'$image' is no image reference"

  # The master key, given at launch (issue #970): never from a file or the running container.
  if [ -z "${HOPPER_MASTER_KEY:-}" ]; then
    local tty="${HOPPER_UPDATE_TTY:-/dev/tty}"
    if { : <"$tty"; } 2>/dev/null; then
      printf 'hopper update: paste the master key from your password manager (nothing is shown): ' >&2
      IFS= read -rs HOPPER_MASTER_KEY <"$tty" || true
      printf '\n' >&2
    fi
  fi
  [ -n "${HOPPER_MASTER_KEY:-}" ] || fail 'the master key is not given: the update stops, and nothing changed. Give it at launch (export HOPPER_MASTER_KEY="$(pass show hopper/master-key)", or read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY), or run the update in a terminal'
  [[ "$HOPPER_MASTER_KEY" =~ ^[0-9a-fA-F]{64}$ || "$HOPPER_MASTER_KEY" =~ ^[A-Za-z0-9+/_-]{43}=?$ ]] \
    || fail 'HOPPER_MASTER_KEY is no master key: 32 bytes, as 64 hex digits or base64. The update stops, and nothing changed'
  export HOPPER_MASTER_KEY

  # The container runtime: the one the stack runs in, else podman, else docker.
  local runtime=''
  local r
  for r in podman docker; do
    command -v "$r" >/dev/null && [ -n "$("$r" ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null)" ] && { runtime=$r; break; }
  done
  [ -n "$runtime" ] || runtime="$(command -v podman >/dev/null && echo podman || { command -v docker >/dev/null && echo docker; } || true)"
  [ -n "$runtime" ] || fail 'needs podman or docker on PATH'

  # The compose tool. podman-compose and docker-compose each see only the stack they started (issue #1063); `podman
  # compose` runs docker-compose when it finds it, else podman-compose, or the one PODMAN_COMPOSE_PROVIDER names.
  local compose
  local stack; stack="$("$runtime" ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)"
  if [ "$runtime" = docker ]; then
    compose=(docker compose -p "$project")
  elif [ -n "$stack" ] && [ -n "$(podman ps -aq --filter "label=io.podman.compose.project=$project" 2>/dev/null || true)" ]; then
    command -v podman-compose >/dev/null || fail 'podman-compose started the hopper stack, but it is not on PATH: install it, then run the update again'
    compose=(podman-compose -p "$project")
  else
    compose=(podman compose -p "$project")
  fi
  if [ -n "$stack" ] && ! "${compose[@]}" ps -q 2>/dev/null </dev/null | grep -Eq '^[0-9a-f]{12,}$'; then
    fail "${compose[*]} does not see the hopper stack that runs. It would start a second stack on the same data: the update stops, and nothing changed. The stack runs in $runtime: start it once with the compose tool that made it, then run the update again"
  fi
  say "compose: ${compose[*]}"

  if [ -n "$("$runtime" ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres 2>/dev/null || true)" ]; then
    say 'back up the database: hopper-backup.dump'
    "${compose[@]}" exec -T postgres pg_dump -U hopper -d hopper -Fc </dev/null >hopper-backup.dump.next || fail 'the backup of the database failed: the update stops, and nothing changed'
    mv hopper-backup.dump.next hopper-backup.dump
  fi

  local local_image=0
  [[ "$image" == localhost/* ]] && local_image=1
  if [ "$local_image" = 0 ]; then
    say "pull $image"
    "$runtime" pull "$image" >&2 || fail "the pull of $image failed: the update stops, and nothing changed"
  fi

  say "put in the compose.yaml of $image (the old one: compose.yaml.bak)"
  "$runtime" run --rm -i "$image" hopper update carry --image "$image" <compose.yaml >compose.yaml.next \
    || { rm -f compose.yaml.next; fail 'hopper update carry failed: the update stops, and nothing changed'; }
  diff -u compose.yaml compose.yaml.next >&2 || true
  cp compose.yaml compose.yaml.bak
  mv compose.yaml.next compose.yaml

  export HOPPER_IMAGE="$image"
  say 'pull the stack'
  "${compose[@]}" pull </dev/null >&2 || [ "$local_image" = 1 ] || fail "${compose[*]} pull failed. To go back: cp compose.yaml.bak compose.yaml"
  # Every container is made again on the new image: podman-compose's plain `up -d` keeps a container whose image changed
  # under the same tag, and it cannot `--force-recreate` a service with no container yet (issue #894). So the old stack
  # stops (its volumes stay), and the new one starts.
  say 'stop the stack (its volumes and data stay), and start it on the new image'
  "${compose[@]}" down </dev/null >&2 || say 'the stop did not remove everything (a box on the hopper network keeps it); the start goes on'
  if ! "${compose[@]}" up -d </dev/null >&2; then
    say 'the stack did not start: back to the old compose.yaml and image'
    unset HOPPER_IMAGE
    "${compose[@]}" down </dev/null >/dev/null 2>&1 || true
    cp compose.yaml.bak compose.yaml
    "${compose[@]}" up -d </dev/null >&2 || true
    fail "${compose[*]} up failed on $image. The old compose.yaml is back and the old stack was started again; the database backup is hopper-backup.dump"
  fi

  check "$runtime" "$image" "${HOPPER_UPDATE_WAIT:-180}"
}

# The hopper after the recreate: the image pulled, healthy, with its master key, the stack as its compose file says.
check() {
  local runtime=$1 image=$2 wait=$3
  local want id running
  want="$("$runtime" image inspect --format '{{.Id}}' "$image")"; want="${want#sha256:}"
  id="$("$runtime" ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=hopper | head -n 1)"
  [ -n "$id" ] || fail 'the hopper container does not run after the recreate'
  running="$("$runtime" inspect --format '{{.Image}}' "$id")"; running="${running#sha256:}"
  [ "$running" = "$want" ] || fail "the hopper runs the image ${running:0:12}, not $image (${want:0:12}): run the update again"

  local health="fetch('http://127.0.0.1:'+(process.env.HOPPER_PORT||'4790')+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
  local deadline=$((SECONDS + wait))
  while :; do
    if [ "$("$runtime" inspect --format '{{.State.Running}}' "$id" 2>/dev/null)" != true ]; then
      "$runtime" logs --tail 20 "$id" >&2 2>&1 || true
      fail 'the hopper container stopped: its last log lines are above. A wrong master key stops it ("the master key does not match this database")'
    fi
    "$runtime" exec "$id" node -e "$health" </dev/null >/dev/null 2>&1 && break
    [ "$SECONDS" -lt "$deadline" ] || fail "the hopper did not answer /api/health in ${wait} s: see $runtime logs $id"
    sleep 2
  done

  local status
  status="$("$runtime" exec "$id" hopper master-key status </dev/null)" || fail 'hopper master-key status failed'
  if printf '%s' "$status" | grep -Eq '"source": *"missing"'; then
    fail "the hopper started limited: the master key it was given does not open its secrets. $(printf '%s' "$status" | sed -n 's/.*"problem": *"\(.*\)".*/\1/p')"
  fi
  local fingerprint; fingerprint="$(printf '%s' "$status" | sed -n 's/.*"fingerprint": *"\([0-9a-f]*\)".*/\1/p')"

  local drift
  drift="$("$runtime" exec "$id" hopper update drift </dev/null)" \
    || fail "the stack differs from the compose file of this version: $drift"
  say "done: the hopper runs $image (${want:0:12}), it is healthy, its master key is given (fingerprint ${fingerprint:0:16}), and the stack is whole. Optional: $runtime image prune -f --filter label=org.opencontainers.image.title=hopper"
}

say() { printf 'hopper update: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }

main "$@"
