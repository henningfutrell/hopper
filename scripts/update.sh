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
#   2. takes the master key from HOPPER_MASTER_KEY at launch (a secret manager), else unseals the key sealed to this host
#      (master-key.sh beside compose.yaml, issue #1296), else asks for it on the terminal (nothing is shown); without it
#      the update stops, so the hopper never fails to start for want of it. It reads no plaintext file and no container;
#   3. looks for your rootless Podman socket (issue #1157): when podman.socket is on, the new compose.yaml gives it to the
#      hopper; when it is off, the update goes on without it and says the one line that turns it on. A compose.override.yaml
#      that is the old compose.sandboxes.yaml goes to compose.override.yaml.bak: compose.yaml gives the socket now;
#   4. backs up the database (hopper-backup.dump) and pulls the image;
#   5. checks the new compose.yaml with compose.override.yaml as compose merges them (issue #1246): a target mounted twice
#      or a port published twice stops the update before it changes anything. An override entry that only repeats what
#      compose.yaml gives is removed when you accept it (on the terminal, or HOPPER_UPDATE_FIX_OVERRIDE=1; the old file:
#      compose.override.yaml.bak);
#   6. puts in the compose.yaml of the image with the install's own settings (`hopper update carry`; the old one stays as
#      compose.yaml.bak), pulls the stack, stops it and starts it on the image, so every container is made again. When
#      hopper-compose.service owns the stack (hopper-service.sh, issue #1320), it stops and starts it through that service,
#      with the key sealed to this host, else with the key given to the update, for that start only (issue #1372), so the
#      published port belongs to the service and not to this shell. When it does not start: back to the old compose.yaml, compose.override.yaml and the image the hopper ran before;
#   7. checks that the hopper runs the image pulled, answers /api/health, that its published port answers on this host
#      (issue #1320), has its master key, that the openfga-migrate
#      one-shot exited 0 (then removes its container, issue #1247), and that the stack has no drift (`hopper update
#      drift`), and says the result. It exits 1 when one of these fails;
#   8. when all of these pass, removes the older hopper images (issue #1120): it keeps the one it runs and the one it ran
#      before, to go back to. An image a container still uses is not removed. A master-key.sh and a hopper-service.sh
#      beside compose.yaml are replaced with the new image's; when the service owns the stack, master-key.sh is put in
#      even when none is here, and with no key sealed it says the line that seals it (issue #1487). With Podman and no
#      service, it says the line that installs it.
#
#   HOPPER_UPDATE_WAIT          seconds to wait for the hopper's health (default: 180)
#   HOPPER_UPDATE_FIX_OVERRIDE  1: remove the compose.override.yaml entries compose.yaml gives itself, with no question
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

main() {
  local project=hopper

  [ -f compose.yaml ] || fail "no compose.yaml here: run it in the folder that holds the hopper's compose.yaml"
  # The image compose.yaml names now: a failed start goes back to it.
  local old_ref; old_ref="$(sed -n 's/^ *image: \${HOPPER_IMAGE:-\([^}]*\)}.*/\1/p' compose.yaml | head -n 1)"
  local image="${1:-$old_ref}"
  [ -n "$image" ] || fail "give the image to update to: bash -s -- ghcr.io/henningfutrell/hopper:<channel>"

  [[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || fail "'$image' is no image reference"

  # The master key, given at launch (issue #970), or sealed to this host (issue #1296): never from a plaintext file or the
  # running container.
  local sealed=0
  if [ -z "${HOPPER_MASTER_KEY:-}" ] && [ -f master-key.sh ] && { [ -f hopper-master-key.cred ] || [ -f hopper-master-key.enc ]; }; then
    HOPPER_MASTER_KEY="$(bash master-key.sh unseal)" \
      || fail 'the master key sealed to this host does not unseal (above): the update stops, and nothing changed'
    HOPPER_MASTER_KEY_SEALED="$(bash master-key.sh method)"
    export HOPPER_MASTER_KEY_SEALED
    sealed=1
    say "the master key: unsealed from this host ($HOPPER_MASTER_KEY_SEALED)"
  fi
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

  # The user service (issue #1320): when it owns the stack, the stack stops and starts through it, so its published port
  # belongs to the service and not to this shell. It starts the stack with the key sealed to this host, else with the key
  # given to this update, for each start only (issue #1372).
  local service=0 service_key=0
  if [ "$runtime" = podman ] && [ -f hopper-service.sh ] && systemctl --user is-enabled --quiet hopper-compose.service 2>/dev/null; then
    service=1
    if ! { [ -f hopper-master-key.cred ] || [ -f hopper-master-key.enc ]; }; then
      service_key=1
    elif [ "$sealed" = 0 ] && [ "$(bash master-key.sh unseal 2>/dev/null || true)" != "$HOPPER_MASTER_KEY" ]; then
      fail 'the master key given is not the one sealed to this host, which hopper-compose.service starts the stack with: seal the right key (bash master-key.sh seal), then run the update again. Nothing changed'
    fi
    repair_units
    if [ "$service_key" = 1 ]; then
      say 'hopper-compose.service owns the stack: the update stops and starts it through the service, with the master key given to this update (none is sealed here)'
    else
      say 'hopper-compose.service owns the stack: the update stops and starts it through the service'
    fi
  fi

  # The image the hopper runs now: after the update, the one before, kept to go back to.
  local previous=''
  local running_id; running_id="$("$runtime" ps -q --filter label=com.docker.compose.project=$project --filter label=com.docker.compose.service=hopper 2>/dev/null | head -n 1 || true)"
  [ -z "$running_id" ] || previous="$("$runtime" inspect --format '{{.Image}}' "$running_id" 2>/dev/null || true)"
  previous="${previous#sha256:}"

  if [ -n "$("$runtime" ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres 2>/dev/null || true)" ]; then
    say 'back up the database: hopper-backup.dump'
    "${compose[@]}" exec -T postgres pg_dump -U hopper -d hopper -Fc </dev/null >hopper-backup.dump.next || fail 'the backup of the database failed: the update stops, and nothing changed'
    mv hopper-backup.dump.next hopper-backup.dump
  fi

  # The rootless Podman socket (issue #1157): compose.yaml mounts the path the update writes in, else /dev/null.
  local socket=''
  if [ "$runtime" = podman ]; then
    if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ]; then
      socket="$XDG_RUNTIME_DIR/podman/podman.sock"
      say "the hopper gets your rootless Podman socket: $socket"
    else
      say 'podman.socket is off: the hopper starts with no container runtime socket, so it cannot read its containers (Resources) or start sandbox boxes. Turn it on with this line, then run the update again: systemctl --user enable --now podman.socket'
    fi
  fi
  # compose.sandboxes.yaml saved as compose.override.yaml (issue #603) mounts the same socket: podman-compose would mount it
  # twice, and the stack would not start. Any other override that does is a conflict, found below.
  local sandboxes=0
  if [ -f compose.override.yaml ] && [ "$(grep -Ev '^ *(#|$)' compose.override.yaml)" = "$SANDBOXES_OVERRIDE" ]; then
    sandboxes=1
  fi

  local local_image=0
  [[ "$image" == localhost/* ]] && local_image=1
  if [ "$local_image" = 0 ]; then
    say "pull $image"
    "$runtime" pull "$image" >&2 || fail "the pull of $image failed: the update stops, and nothing changed"
  fi

  # The merge compose will start (issue #1246), checked while nothing changed yet.
  local carry=("$runtime" run --rm -i "$image" hopper update)
  local flags=(--image "$image" --podman-socket "$socket" --with-override)
  local fixed_override=0 swapped=0 code=0
  merge_input "$sandboxes" | "${carry[@]}" check "${flags[@]}" >/dev/null || code=$?
  if [ "$code" = 4 ]; then
    local fixed
    fixed="$(merge_input "$sandboxes" | "${carry[@]}" fix-override "${flags[@]}")" \
      || fail 'compose.override.yaml conflicts with the compose.yaml of the new version (above): fix it as said, then run the update again. Nothing changed'
    if ! accept_fix; then
      fail 'compose.override.yaml repeats what the compose.yaml of the new version gives (above): the stack would not start. Nothing changed. Remove those entries yourself, or run the update again with HOPPER_UPDATE_FIX_OVERRIDE=1 (or answer y on a terminal) and it removes them, with a backup'
    fi
    cp compose.override.yaml compose.override.yaml.bak
    printf '%s\n' "$fixed" >compose.override.yaml
    fixed_override=1
    say 'removed the repeated entries from compose.override.yaml (the old file: compose.override.yaml.bak)'
  elif [ "$code" != 0 ]; then
    fail 'the check of compose.yaml and compose.override.yaml failed (above): the update stops, and nothing changed'
  fi

  say "put in the compose.yaml of $image (the old one: compose.yaml.bak)"
  merge_input "$sandboxes" | "${carry[@]}" carry "${flags[@]}" >compose.yaml.next \
    || { rm -f compose.yaml.next; restore_files; fail 'hopper update carry failed: the update stops, and the old files are back'; }
  diff -u compose.yaml compose.yaml.next >&2 || true
  cp compose.yaml compose.yaml.bak
  mv compose.yaml.next compose.yaml
  swapped=1
  if [ "$sandboxes" = 1 ]; then
    say 'compose.override.yaml was compose.sandboxes.yaml: compose.yaml gives the socket now (the old file: compose.override.yaml.bak)'
    mv compose.override.yaml compose.override.yaml.bak
  fi

  export HOPPER_IMAGE="$image"
  say 'pull the stack'
  "${compose[@]}" pull </dev/null >&2 || [ "$local_image" = 1 ] \
    || { restore_files; fail "${compose[*]} pull failed: the old compose.yaml is back, and the stack that runs was not touched"; }
  # Every container is made again on the new image: podman-compose's plain `up -d` keeps a container whose image changed
  # under the same tag, and it cannot `--force-recreate` a service with no container yet (issue #894). So the old stack
  # stops (its volumes stay), and the new one starts.
  say 'stop the stack (its volumes and data stay), and start it on the new image'
  if ! restart_stack; then
    say 'the stack did not start: back to the old compose.yaml and image'
    unset HOPPER_IMAGE
    [ "$service" = 1 ] || "${compose[@]}" down </dev/null >/dev/null 2>&1 || true
    restore_files
    [ "$service" = 1 ] || clear_one_shot "$runtime"
    # The pull moved the tag compose.yaml.bak names when the update kept its channel: the tag goes back to the image the
    # hopper ran before.
    local back=''
    if [ -n "$previous" ] && [ -n "$old_ref" ] && "$runtime" tag "$previous" "$old_ref" >/dev/null 2>&1; then
      back=", back on the image it ran before (${previous:0:12})"
    fi
    if [ "$service" = 1 ]; then service_restart || true; else "${compose[@]}" up -d </dev/null >&2 || true; fi
    fail "${compose[*]} up failed on $image. The old compose.yaml is back and the old stack was started again${back}; the database backup is hopper-backup.dump"
  fi

  check "$runtime" "$image" "${HOPPER_UPDATE_WAIT:-180}" "$service"
  prune "$runtime" "$image" "$previous"
  # master-key.sh comes with the service too (issue #1487): without it no key can be sealed, and a restart of this host
  # leaves the stack down until a person gives the key.
  if [ "$sealed" = 1 ] || [ "$service" = 1 ] || [ -f master-key.sh ]; then refresh_script "$runtime" "$image" master-key.sh master-key; fi
  [ "$service" = 0 ] || refresh_script "$runtime" "$image" hopper-service.sh service
  if [ "$service_key" = 1 ] && [ -f master-key.sh ]; then
    say 'no master key is sealed here: after a restart of this host the stack does not start by itself. Seal it: bash master-key.sh seal (it asks for the key), then systemctl --user restart hopper-compose.service'
  fi
  if [ "$runtime" = podman ] && [ "$service" = 0 ]; then
    say "the stack runs under this shell: its published port goes away when this shell's session ends. Put it under a user service of its own, once (docs/deploy.md \"The user service\"): $runtime run --rm $image hopper service script > hopper-service.sh && bash hopper-service.sh install"
  fi
}

# The stack stopped and started on the new image: through hopper-compose.service when it owns the stack (issue #1320),
# else with the compose tool (main's own variables).
restart_stack() {
  if [ "$service" = 1 ]; then
    service_restart
    return
  fi
  "${compose[@]}" down </dev/null >&2 || say 'the stop did not remove everything (a box on the hopper network keeps it); the start goes on'
  clear_one_shot "$runtime"
  "${compose[@]}" up -d </dev/null >&2
}

# The units an older hopper-service.sh wrote with WorkingDirectory quoted, which systemd refuses, so the restart fails
# (issue #1453): the quotes taken out, and the user manager loads them again.
repair_units() {
  local unit file changed=0
  for unit in hopper-compose.service hopper-compose-check.service; do
    file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
    [ -f "$file" ] && grep -q '^WorkingDirectory="' "$file" || continue
    sed -i 's/^WorkingDirectory="\(.*\)"$/WorkingDirectory=\1/' "$file"
    changed=1
  done
  [ "$changed" = 1 ] || return 0
  systemctl --user daemon-reload </dev/null >&2 || fail 'systemctl --user daemon-reload failed after the WorkingDirectory of hopper-compose.service was repaired. Nothing else changed'
  say 'repaired WorkingDirectory in the hopper-compose units (it was quoted, which systemd refuses)'
}

# hopper-compose.service restarted. With no key sealed here (issue #1372), the key given to this update goes into the user
# manager's environment from this process's environment, never as an argument, for this start only, and is removed after.
service_restart() {
  if [ "$service_key" = 0 ]; then
    systemctl --user restart hopper-compose.service </dev/null >&2
    return
  fi
  local status=0
  systemctl --user import-environment HOPPER_MASTER_KEY </dev/null >&2 || return
  systemctl --user restart hopper-compose.service </dev/null >&2 || status=$?
  systemctl --user unset-environment HOPPER_MASTER_KEY </dev/null >&2 || true
  return "$status"
}

# A script beside compose.yaml — master-key.sh (issue #1296), hopper-service.sh (issue #1320) — replaced with the one of
# the image updated to. One that does not come keeps the old file: it still works.
refresh_script() {
  local runtime=$1 image=$2 file=$3 command=$4
  if "$runtime" run --rm "$image" hopper "$command" script </dev/null >"$file.next" 2>/dev/null && [ -s "$file.next" ]; then
    mv "$file.next" "$file"
    say "put in the $file of $image"
  else
    rm -f "$file.next"
    say "the image gives no $file: the old one stays"
  fi
}

# Whether the hopper's published port answers on this host (issue #1320): on rootless Podman a process of the caller that
# started the container serves it, and the container shows Up after that process is gone. Unpublished: yes.
port_answers() {
  local runtime=$1 id=$2 line addr host port
  line="$("$runtime" port "$id" 2>/dev/null | head -n 1 || true)"
  addr="${line##*-> }"
  [ -n "$line" ] && [ "$addr" != "$line" ] || return 0
  port="${addr##*:}"; host="${addr%:*}"; host="${host#[}"; host="${host%]}"
  case "$host" in '' | 0.0.0.0 | ::) host=127.0.0.1 ;; esac
  published="$host:$port"
  (: >"/dev/tcp/$host/$port") 2>/dev/null
}

# compose.yaml, the mark, then compose.override.yaml (none when it is the old compose.sandboxes.yaml, moved aside):
# what `hopper update carry --with-override` reads (issue #1246).
merge_input() {
  printf '%s\n%s\n' "$(<compose.yaml)" '#--- hopper update: compose.override.yaml'
  [ "$1" = 1 ] || [ ! -f compose.override.yaml ] || printf '%s\n' "$(<compose.override.yaml)"
}

# Whether the person lets the update remove the override entries compose.yaml gives itself: HOPPER_UPDATE_FIX_OVERRIDE=1,
# else their answer on the terminal; with neither, no.
accept_fix() {
  [ "${HOPPER_UPDATE_FIX_OVERRIDE:-}" = 1 ] && return 0
  local tty="${HOPPER_UPDATE_TTY:-/dev/tty}" answer=''
  { : <"$tty"; } 2>/dev/null || return 1
  printf 'hopper update: compose.yaml gives these itself now: remove them from compose.override.yaml (a backup stays as compose.override.yaml.bak)? [y/N] ' >&2
  IFS= read -r answer <"$tty" || true
  [[ "$answer" =~ ^[Yy] ]]
}

# The files as they were before the update: compose.yaml and compose.override.yaml (main's own variables).
restore_files() {
  [ "$swapped" = 0 ] || cp compose.yaml.bak compose.yaml
  [ "$swapped" = 0 ] || [ "$sandboxes" = 0 ] || mv compose.override.yaml.bak compose.override.yaml
  [ "$fixed_override" = 0 ] || mv compose.override.yaml.bak compose.override.yaml
}

# The older hopper images (issue #1120): every one but the one the hopper runs and the one it ran before. An image a
# container still uses, or that has more than one name, is not removed and not counted.
prune() {
  local runtime=$1 image=$2 previous=$3
  local want; want="$("$runtime" image inspect --format '{{.Id}}' "$image")"; want="${want#sha256:}"
  local id seen=' ' removed=0
  for id in $("$runtime" images -q --no-trunc --filter label=org.opencontainers.image.title=hopper 2>/dev/null || true); do
    id="${id#sha256:}"
    case "$seen" in *" $id "*) continue ;; esac
    seen="$seen$id "
    [ "$id" = "$want" ] || [ "$id" = "$previous" ] && continue
    "$runtime" rmi "$id" >/dev/null 2>&1 && removed=$((removed + 1))
  done
  local images=images; [ "$removed" = 1 ] && images=image
  say "removed $removed older hopper $images; kept the one it runs (${want:0:12})${previous:+ and the one before (${previous:0:12})}"
}

# The hopper after the recreate: the image pulled, healthy, with its master key, the stack as its compose file says.
check() {
  local runtime=$1 image=$2 wait=$3 service=$4
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

  local published=''
  if ! port_answers "$runtime" "$id"; then
    if [ "$service" = 1 ]; then
      fail "the hopper answers in its container, but its published port $published does not answer on this host. Restart it: systemctl --user restart hopper-compose.service"
    fi
    fail "the hopper answers in its container, but its published port $published does not answer on this host. Start the stack under the user service: bash hopper-service.sh install (docs/deploy.md \"The user service\")"
  fi

  local status
  status="$("$runtime" exec "$id" hopper master-key status </dev/null)" || fail 'hopper master-key status failed'
  local fingerprint; fingerprint="$(printf '%s' "$status" | sed -n 's/.*"fingerprint": *"\([0-9a-f]*\)".*/\1/p')"

  one_shot "$runtime" "$wait"

  local drift
  drift="$("$runtime" exec "$id" hopper update drift </dev/null)" \
    || fail "the stack differs from the compose file of this version: $drift"
  say "done: the hopper runs $image (${want:0:12}), it is healthy, its master key is given (fingerprint ${fingerprint:0:16}), and the stack is whole"
}

# The openfga-migrate one-shot (issue #1247): its container stays after it exits, and podman-compose's `down` can leave it,
# so the next `up -d` exits 125 (the container name is in use) though the rest of the stack starts.
ONE_SHOT=openfga-migrate
one_shot_ids() {
  "$1" ps -aq --filter label=com.docker.compose.project=hopper --filter "label=com.docker.compose.service=$ONE_SHOT" 2>/dev/null || true
}

# Before a start: removes the one-shot's container left from before. One that failed shows its last log lines first.
clear_one_shot() {
  local runtime=$1 id state
  for id in $(one_shot_ids "$runtime"); do
    state="$("$runtime" inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null || true)"
    if [ "${state#* }" != 0 ] && [ "${state%% *}" = exited ]; then
      say "the $ONE_SHOT run before this update failed (exit ${state#* }): its last log lines are below. It runs again now"
      "$runtime" logs --tail 20 "$id" >&2 2>&1 || true
    fi
    "$runtime" rm -f "$id" >/dev/null 2>&1 || true
  done
}

# After the start: waits until the one-shot exited 0, then removes its container, so the next `up -d` makes it again. It
# retries until postgres has made the schema (restart: on-failure): a non-zero exit fails the update only when it lasts.
one_shot() {
  local runtime=$1 wait=$2 id state=''
  id="$(one_shot_ids "$runtime" | head -n 1)"
  [ -n "$id" ] || return 0
  local deadline=$((SECONDS + wait))
  while :; do
    state="$("$runtime" inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null || true)"
    if [ "$state" = 'exited 0' ]; then
      "$runtime" rm -f "$id" >/dev/null 2>&1 || true
      say "$ONE_SHOT brought OpenFGA's tables up to date; its container is removed"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 2
  done
  "$runtime" logs --tail 20 "$id" >&2 2>&1 || true
  local code="${state#* }"
  if [ -n "$state" ] && [ "$code" != 0 ]; then
    fail "$ONE_SHOT failed (exit $code): its last log lines are above. OpenFGA's tables are not up to date, so access checks deny every credential. Fix the cause, then run the update again"
  fi
  fail "$ONE_SHOT did not end in ${wait} s (${state:-no state}): its last log lines are above. Run the update again"
}

# compose.sandboxes.yaml (issue #603) as it was shipped, without its comments and blank lines.
SANDBOXES_OVERRIDE='services:
  hopper:
    environment:
      HOPPER_PODMAN_SOCKET: /run/podman/podman.sock
    volumes:
      - type: bind
        source: ${XDG_RUNTIME_DIR:?the rootless Podman socket is under XDG_RUNTIME_DIR, which is not set}/podman/podman.sock
        target: /run/podman/podman.sock
    group_add: ["0"]
    security_opt: [label=disable]'

say() { printf 'hopper update: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }

main "$@"
