#!/usr/bin/env bash
# The compose stack under a user service of its own (issue #1320, docs/deploy.md "The user service"). On rootless Podman,
# the published port is served by a rootlessport process that belongs to whoever started the hopper's container. Started
# from a terminal or by an agent, the port goes away when that caller exits, while the container still shows Up. Started
# by this service, the port belongs to the service: every start, restart, update and recovery goes through it. Podman
# only: with Docker, its daemon serves the port; on Kubernetes, none of this applies. Every image carries this file. Save
# it beside compose.yaml and master-key.sh, then run it in that folder:
#
#   podman run --rm <image> hopper service script > hopper-service.sh
#   bash hopper-service.sh install     write the user units, turn on linger, and start the stack through the service
#   bash hopper-service.sh uninstall   stop the stack and remove the units (the data stays)
#   bash hopper-service.sh start-with-key
#                                      restart the service with the master key given at launch: HOPPER_MASTER_KEY, else
#                                      asked on the terminal. No key needs to be sealed here
#
# The install puts in master-key.sh from the image when none is here, and seals the key given to it as HOPPER_MASTER_KEY
# (issue #1487): then a restart of this host brings the stack back with no person. With data and no key sealed, it says
# the line that seals it.
#
# The units, in ${XDG_CONFIG_HOME:-~/.config}/systemd/user:
#   hopper-compose.service       owns the stack. Its start takes the stack down and starts it again with the master key,
#                                for compose only: never a .env, a file or a volume (issue #1372). The key, in this order:
#                                  1. the systemd credential hopper-master-key (ImportCredential=, or a drop-in with
#                                     LoadCredentialEncrypted= or SetCredentialEncrypted=: systemd-creds, a TPM2);
#                                  2. HOPPER_MASTER_KEY in the service's environment at launch (start-with-key);
#                                  3. the key sealed to this host (bash master-key.sh run …).
#                                With none of them, it starts the stack with no key only when the hopper has no data yet
#                                (no volume hopper_postgres): a new hopper makes one. With data and no key, the start
#                                fails and says how to give the key: a new key would open none of the secrets.
#                                Compose gets the key as a file, never as a variable (issue #1487): written to
#                                $XDG_RUNTIME_DIR/hopper-service/master-key (in memory, a folder only this user opens),
#                                mounted read-only into the hopper's container (and hopper-vault's), and named by
#                                HOPPER_MASTER_KEY_FILE. No container's config holds the key, and after a restart of this
#                                host the file is gone, so a `podman start` of an old container does not start.
#                                Its stop takes the stack down and removes the file; the volumes and the data stay.
#   hopper-compose-alert.service runs when the start fails (OnFailure=, issue #1487): it says what stopped the start in a
#                                desktop notice (notify-send, when there is one) and gives it to hopper-alert.sh beside
#                                this file, when there is one, as its one argument: write there what reaches you (a
#                                webhook, a mail, a phone notice). The hopper is down then, so it cannot tell you itself.
#   hopper-compose-check.timer   every minute, hopper-compose-check.service checks the published port from this host.
#                                When the hopper's container runs and its port does not answer, twice, 10 s apart, it
#                                restarts hopper-compose.service.
# The settings compose.yaml names (HOPPER_PORT, HOPPER_BIND, COMPOSE_PROFILES, …) that are set where the install runs go
# into the service as its environment, but never a secret (a name with KEY, TOKEN, SECRET or PASSWORD) and never
# HOPPER_IMAGE: the update writes the image into compose.yaml. Run the install again to change them.
#
#   HOPPER_SERVICE_RETRY  seconds between the two tries of the port check (default: 10)
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

UNIT=hopper-compose.service
CHECK=hopper-compose-check
ALERT=hopper-compose-alert
PROJECT=hopper
# The systemd credential the service reads the master key from, and the volume that holds the hopper's data.
CREDENTIAL=hopper-master-key
DATA_VOLUME=${PROJECT}_postgres

main() {
  local command="${1:-}"
  [ $# -eq 0 ] || shift
  case "$command" in
    install) install ;;
    uninstall) uninstall ;;
    start-with-key) start_with_key ;;
    start) start ;;
    stop) stop ;;
    check) check ;;
    alert) alert ;;
    up) up ;;
    *) fail 'usage: bash hopper-service.sh install | uninstall | start-with-key (start, stop, check and alert are the units'"'"' own)' ;;
  esac
}

unit_dir() { printf '%s/systemd/user' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

# The folder the key compose reads is written to (issue #1487): in this user's runtime folder, in memory, gone at a
# restart of this host. Empty when there is no runtime folder.
key_dir() { [ -z "${XDG_RUNTIME_DIR:-}" ] || printf '%s/hopper-service' "$XDG_RUNTIME_DIR"; }

# The compose tool that sees the stack (issue #1063): podman-compose when its containers carry podman-compose's label,
# else `podman compose`. As words, for the unit.
compose_tool() {
  if [ -n "$(podman ps -aq --filter "label=io.podman.compose.project=$PROJECT" 2>/dev/null || true)" ]; then
    local path; path="$(command -v podman-compose)" || fail 'podman-compose started the hopper stack, but it is not on PATH: install it, then run the install again'
    printf '%s' "$path"
  else
    printf '%s compose' "$(command -v podman)"
  fi
}

# HOPPER_SERVICE_COMPOSE, the tool the install found, with the project.
compose() {
  local tool
  read -ra tool <<<"${HOPPER_SERVICE_COMPOSE:?no HOPPER_SERVICE_COMPOSE: install the service (bash hopper-service.sh install)}"
  "${tool[@]}" -p "$PROJECT" "$@"
}

# A value in a unit file: in double quotes, with systemd's specifiers (%) kept as they are.
quoted() {
  local v=$1
  [[ "$v" != *$'\n'* && "$v" != *'"'* && "$v" != *'\'* ]] || fail "this value cannot go in a unit file (a newline, a quote or a backslash): $v"
  printf '"%s"' "${v//%/%%}"
}

# An argument of a command line in a unit file: quoted, and $ kept as it is too.
argument() {
  local v; v="$(quoted "$1")"
  printf '%s' "${v//\$/\$\$}"
}

# The settings compose.yaml names that are set here, as Environment= lines: never a secret, never the image.
settings() {
  local name
  for name in $(grep -o '\${[A-Z0-9_]*:-' compose.yaml | sed 's/^\${//; s/:-$//' | sort -u) PODMAN_COMPOSE_PROVIDER; do
    [[ "$name" =~ KEY|TOKEN|SECRET|PASSWORD ]] && continue
    [ "$name" = HOPPER_IMAGE ] && continue
    [ -n "${!name+x}" ] || continue
    printf 'Environment=%s\n' "$(quoted "$name=${!name}")"
  done
}

# The image compose.yaml runs: HOPPER_IMAGE, else the default the file names.
image_ref() {
  [ -z "${HOPPER_IMAGE:-}" ] || { printf '%s' "$HOPPER_IMAGE"; return; }
  sed -n 's/^ *image: \${HOPPER_IMAGE:-\([^}]*\)}.*/\1/p' compose.yaml | head -n 1
}

# master-key.sh beside this file (issue #1487): put in from the image when none is here, then the key given to the install
# sealed to this host, so a restart of the host needs no person. The key goes to master-key.sh in its environment only.
master_key_script() {
  if [ ! -f master-key.sh ]; then
    local image; image="$(image_ref)"
    if [ -n "$image" ] && env -u HOPPER_MASTER_KEY podman run --rm "$image" hopper master-key script </dev/null >master-key.sh.next 2>/dev/null && [ -s master-key.sh.next ]; then
      mv master-key.sh.next master-key.sh
      say "put in master-key.sh from $image"
    else
      rm -f master-key.sh.next
      say "the image gives no master-key.sh: give the master key at launch (bash hopper-service.sh start-with-key, or the systemd credential $CREDENTIAL), or put it in and seal the key: podman run --rm <image> hopper master-key script > master-key.sh && bash master-key.sh seal"
      return 0
    fi
  fi
  sealed && return 0
  if [ -n "${HOPPER_MASTER_KEY:-}" ]; then
    check_key "$HOPPER_MASTER_KEY" 'HOPPER_MASTER_KEY'
    bash master-key.sh seal </dev/null || fail 'the seal of the master key failed (above): nothing changed'
    say 'sealed the master key given to the install to this host: the stack starts with it, also after a restart of this host'
  elif podman volume exists "$DATA_VOLUME" </dev/null >/dev/null 2>&1; then
    say 'no master key is sealed here: after a restart of this host the stack does not start by itself. Seal it: bash master-key.sh seal (it asks for the key), then systemctl --user restart hopper-compose.service'
  fi
}

install() {
  [ -f compose.yaml ] || fail 'no compose.yaml here: run it in the folder that holds the hopper'"'"'s compose.yaml'
  command -v podman >/dev/null || fail 'needs podman on PATH. With Docker, its daemon serves the port: no service is needed'
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail 'needs systemd running for this user (systemctl --user fails). In WSL: [boot] systemd=true in /etc/wsl.conf, then wsl --shutdown'
  local dir; dir="$(pwd -P)"
  local bash; bash="$(command -v bash)"
  local tool; tool="$(compose_tool)"
  local units; units="$(unit_dir)"
  master_key_script
  mkdir -p "$units"
  local env
  env="$(printf 'Environment=%s\nEnvironment=%s\n' "$(quoted "PATH=$PATH")" "$(quoted "HOPPER_SERVICE_COMPOSE=$tool")"; settings)"
  if [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/podman/podman.sock" ] && ! grep -q '^Environment="HOPPER_PODMAN_SOCKET_HOST=' <<<"$env"; then
    env+=$'\nEnvironment="HOPPER_PODMAN_SOCKET_HOST=%t/podman/podman.sock"'
  fi
  local exec; exec="$(argument "$bash") $(argument "$dir/hopper-service.sh")"
  cat >"$units/$UNIT.next" <<EOF
# Made by hopper-service.sh install (issue #1320): the hopper's compose stack in $dir. Run the install again to change it.
[Unit]
Description=hopper: the compose stack
After=podman.socket
OnFailure=$ALERT.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$(quoted "$dir")
$env
ImportCredential=$CREDENTIAL
ExecStart=$exec start
ExecStop=$exec stop
TimeoutStartSec=600
TimeoutStopSec=180

[Install]
WantedBy=default.target
EOF
  cat >"$units/$CHECK.service.next" <<EOF
# Made by hopper-service.sh install (issue #1320): the hopper's published port, checked from this host.
[Unit]
Description=hopper: check the published port from this host

[Service]
Type=oneshot
WorkingDirectory=$(quoted "$dir")
$env
ExecStart=$exec check
EOF
  cat >"$units/$CHECK.timer.next" <<EOF
# Made by hopper-service.sh install (issue #1320).
[Unit]
Description=hopper: check the published port every minute

[Timer]
OnActiveSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
  cat >"$units/$ALERT.service.next" <<EOF
# Made by hopper-service.sh install (issue #1487): runs when $UNIT fails, and says so where a person sees it.
[Unit]
Description=hopper: say that the compose stack did not start

[Service]
Type=oneshot
WorkingDirectory=$(quoted "$dir")
$env
ExecStart=$exec alert
EOF
  mv "$units/$UNIT.next" "$units/$UNIT"
  mv "$units/$CHECK.service.next" "$units/$CHECK.service"
  mv "$units/$CHECK.timer.next" "$units/$CHECK.timer"
  mv "$units/$ALERT.service.next" "$units/$ALERT.service"
  say "wrote $units/$UNIT, $CHECK.service, $CHECK.timer and $ALERT.service (compose: $tool)"

  # Linger: the user manager, and with it the service, starts at boot and stays after the last logout.
  local user="${USER:-$(id -un)}"
  if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != yes ]; then
    if loginctl enable-linger "$user" >/dev/null 2>&1; then
      say "turned on linger for $user: the stack starts at boot"
    else
      say "linger is off, and this user cannot turn it on: the stack starts only once $user logs in. Turn it on: sudo loginctl enable-linger $user"
    fi
  fi

  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" "$CHECK.timer" >/dev/null 2>&1 || fail "systemctl --user enable $UNIT $CHECK.timer failed"
  say 'start the stack through the service: it is taken down and started again under it (running jobs end)'
  systemctl --user restart "$UNIT" || fail "the start failed: see journalctl --user -u $UNIT -n 50"
  systemctl --user restart "$CHECK.timer"
  say "done: $UNIT owns the stack, and $CHECK.timer checks its port every minute. Restart it: systemctl --user restart $UNIT"
}

uninstall() {
  local units; units="$(unit_dir)"
  systemctl --user disable --now "$CHECK.timer" "$UNIT" >/dev/null 2>&1 || true
  rm -f "$units/$UNIT" "$units/$CHECK.service" "$units/$CHECK.timer" "$units/$ALERT.service"
  systemctl --user daemon-reload
  say "removed $UNIT and $CHECK.timer: the stack is stopped, its data stays. Start it again with: bash hopper-service.sh install"
}

# The openfga-migrate one-shot left from before (issue #1247): podman-compose's `down` can leave it, and the next `up -d`
# then exits 125.
clear_one_shot() {
  local id
  for id in $(podman ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=openfga-migrate 2>/dev/null || true); do
    podman rm -f "$id" >/dev/null 2>&1 || true
  done
}

check_key() {
  [[ "$1" =~ ^[0-9a-fA-F]{64}$ || "$1" =~ ^[A-Za-z0-9+/_-]{43}=?$ ]] \
    || fail "$2 is no master key: 32 bytes, as 64 hex digits or base64. Nothing changed"
}

# The key given at launch (issue #1372): the systemd credential, else HOPPER_MASTER_KEY in the service's environment.
# Writes "<where it came from>" on the first line and the key on the second; nothing when none is given.
launch_key() {
  local file="${CREDENTIALS_DIRECTORY:-}/$CREDENTIAL" key
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -f "$file" ]; then
    key="$(cat "$file")"
    check_key "$key" "the systemd credential $CREDENTIAL"
    printf 'the systemd credential %s\n%s' "$CREDENTIAL" "$key"
  elif [ -n "${HOPPER_MASTER_KEY:-}" ]; then
    check_key "$HOPPER_MASTER_KEY" 'HOPPER_MASTER_KEY'
    printf 'HOPPER_MASTER_KEY given at launch\n%s' "$HOPPER_MASTER_KEY"
  fi
}

sealed() { [ -f master-key.sh ] && { [ -f hopper-master-key.cred ] || [ -f hopper-master-key.enc ]; }; }

# ExecStart: the stack, made again under this service, so its port belongs to the service and not to a caller.
start() {
  local given from='' key=''
  given="$(launch_key)" || exit 1
  if [ -n "$given" ]; then from="${given%%$'\n'*}"; key="${given#*$'\n'}"; fi
  unset HOPPER_MASTER_KEY
  if [ -z "$key" ] && ! sealed && podman volume exists "$DATA_VOLUME" </dev/null >/dev/null 2>&1; then
    local script=''
    [ -f master-key.sh ] || script=' (no master-key.sh here: bash hopper-service.sh install puts it in)'
    fail "no master key is given, and the hopper keeps data (the volume $DATA_VOLUME): the stack does not start, and no new key is made. Give the key at launch: bash hopper-service.sh start-with-key (it asks for the key, or reads HOPPER_MASTER_KEY), or the systemd credential $CREDENTIAL, or seal it to this host: bash master-key.sh seal$script, then systemctl --user restart $UNIT (docs/deploy.md \"The user service\")"
  fi
  compose down </dev/null >&2 || say 'the stop did not remove everything (a box on the hopper network keeps it); the start goes on'
  clear_one_shot
  if [ -n "$key" ]; then
    say "start the stack with the master key from $from"
    HOPPER_MASTER_KEY="$key" exec bash "$0" up
  fi
  if sealed; then
    say 'start the stack with the master key sealed to this host'
    exec bash master-key.sh run bash "$0" up
  fi
  say 'no master key given and none sealed here, and the hopper has no data yet: the stack starts with no key (a new hopper makes one; save it, then give it at launch or seal it: bash master-key.sh seal)'
  up
}

# The stack started. The key, given as HOPPER_MASTER_KEY, goes to compose as a file (issue #1487): written where only this
# user opens it, in memory, and mounted read-only into the containers that read it. No container's config holds it.
up() {
  local dir; dir="$(key_dir)"
  [ -z "$dir" ] || rm -f "$dir/master-key"
  if [ -n "${HOPPER_MASTER_KEY:-}" ]; then
    [ -n "$dir" ] || fail 'no XDG_RUNTIME_DIR: the master key has no place in memory to go to the containers from, and the stack does not start. Start it from the user service (systemctl --user restart hopper-compose.service)'
    (umask 077 && mkdir -p "$dir") && chmod 700 "$dir" || fail "cannot make $dir for the master key"
    # The folder keeps out every other user of this host; the file is readable by the container's own user.
    (umask 022 && printf '%s' "$HOPPER_MASTER_KEY" >"$dir/master-key.next") && mv "$dir/master-key.next" "$dir/master-key" \
      || fail "cannot write the master key to $dir"
    export HOPPER_MASTER_KEY_HOST_FILE="$dir/master-key" HOPPER_MASTER_KEY_FILE=/run/hopper-master-key
    unset HOPPER_MASTER_KEY
  fi
  compose up -d </dev/null
}

# The key a person gives: HOPPER_MASTER_KEY, else asked on the terminal (nothing is shown).
given_key() {
  local key="${HOPPER_MASTER_KEY:-}"
  if [ -z "$key" ]; then
    local tty="${HOPPER_KEY_TTY:-/dev/tty}"
    { : <"$tty"; } 2>/dev/null || fail 'no master key: give it as HOPPER_MASTER_KEY, or run this in a terminal'
    printf 'hopper-service: paste the master key from your password manager (nothing is shown): ' >&2
    IFS= read -rs key <"$tty" || true
    printf '\n' >&2
  fi
  check_key "$key" 'that'
  printf '%s' "$key"
}

# The service restarted with the key given at launch (issue #1372): the key goes into the user manager's environment
# from this process's environment, never as an argument, for the one start only, and is removed from it after.
start_with_key() {
  [ -f "$(unit_dir)/$UNIT" ] || fail "no $UNIT: install it first (bash hopper-service.sh install)"
  local key; key="$(given_key)"
  trap 'systemctl --user unset-environment HOPPER_MASTER_KEY' EXIT
  HOPPER_MASTER_KEY="$key" systemctl --user import-environment HOPPER_MASTER_KEY
  say 'restart the stack through the service with the master key given at launch (running jobs end)'
  systemctl --user restart "$UNIT" || fail "the start failed: see journalctl --user -u $UNIT -n 50"
  say "done: $UNIT started the stack with the key. It is not kept: give it again at the next start, or seal it (bash master-key.sh seal)"
}

# ExecStop: the containers go, and the key's file; the volumes and the data stay.
stop() {
  local status=0 dir; dir="$(key_dir)"
  compose down </dev/null || status=$?
  [ -z "$dir" ] || rm -f "$dir/master-key"
  return "$status"
}

# OnFailure (issue #1487): the start failed, and the hopper is down, so it cannot say so itself. What stopped the start
# (the last line this script wrote in the service's journal) goes to a desktop notice and to hopper-alert.sh here.
alert() {
  local why
  why="$(journalctl --user -u "$UNIT" -n 50 -o cat --no-pager </dev/null 2>/dev/null | sed -n 's/^hopper-service: //p' | tail -n 1 || true)"
  local text="hopper on $(uname -n): $UNIT did not start: ${why:-see journalctl --user -u $UNIT -n 50}"
  say "$text"
  if command -v notify-send >/dev/null; then
    notify-send --urgency=critical 'hopper is down' "$text" </dev/null >/dev/null 2>&1 || true
  fi
  if [ -f hopper-alert.sh ]; then
    bash hopper-alert.sh "$text" </dev/null || say 'hopper-alert.sh failed (above)'
  else
    say 'no hopper-alert.sh here: write one beside hopper-service.sh that sends its one argument where you see it (a webhook, a mail), so a failed start reaches you (docs/deploy.md "The user service")'
  fi
}

# The address the hopper's port is published on, as "host port": loopback for every interface.
published() {
  local id=$1 line addr host port
  line="$(podman port "$id" 2>/dev/null | head -n 1 || true)"
  addr="${line##*-> }"
  [ -n "$line" ] && [ "$addr" != "$line" ] || return 1
  port="${addr##*:}"; host="${addr%:*}"; host="${host#[}"; host="${host%]}"
  case "$host" in '' | 0.0.0.0 | ::) host=127.0.0.1 ;; esac
  printf '%s %s' "$host" "$port"
}

reaches() { timeout 5 bash -c ': >"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null; }

# The timer's check: the port from this host. The container can show Up while its port is gone.
check() {
  if ! systemctl --user is-active --quiet "$UNIT"; then
    say "$UNIT is not active: nothing to check"
    return 0
  fi
  local id
  id="$(podman ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=hopper 2>/dev/null | head -n 1 || true)"
  [ -n "$id" ] || { say 'the hopper container does not run: nothing to check'; return 0; }
  local addr host port
  addr="$(published "$id")" || { say 'the hopper container publishes no port: nothing to check'; return 0; }
  read -r host port <<<"$addr"
  reaches "$host" "$port" && return 0
  sleep "${HOPPER_SERVICE_RETRY:-10}"
  reaches "$host" "$port" && return 0
  say "the published port $host:$port does not answer while the hopper container runs: restart $UNIT"
  systemctl --user restart --no-block "$UNIT"
}

say() { printf 'hopper-service: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }

main "$@"
