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
#
# The units, in ${XDG_CONFIG_HOME:-~/.config}/systemd/user:
#   hopper-compose.service       owns the stack. Its start takes the stack down and starts it again with the master key
#                                sealed to this host (bash master-key.sh run …), for compose only: never a file or a
#                                volume. With no key sealed here, it starts the stack with no key (a new hopper makes one).
#                                Its stop takes the stack down; the volumes and the data stay.
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
PROJECT=hopper

main() {
  local command="${1:-}"
  [ $# -eq 0 ] || shift
  case "$command" in
    install) install ;;
    uninstall) uninstall ;;
    start) start ;;
    stop) stop ;;
    check) check ;;
    up) compose up -d </dev/null ;;
    *) fail 'usage: bash hopper-service.sh install | uninstall (start, stop and check are the units'"'"' own)' ;;
  esac
}

unit_dir() { printf '%s/systemd/user' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

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

install() {
  [ -f compose.yaml ] || fail 'no compose.yaml here: run it in the folder that holds the hopper'"'"'s compose.yaml'
  command -v podman >/dev/null || fail 'needs podman on PATH. With Docker, its daemon serves the port: no service is needed'
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail 'needs systemd running for this user (systemctl --user fails). In WSL: [boot] systemd=true in /etc/wsl.conf, then wsl --shutdown'
  local dir; dir="$(pwd -P)"
  local bash; bash="$(command -v bash)"
  local tool; tool="$(compose_tool)"
  local units; units="$(unit_dir)"
  [ -f master-key.sh ] || say 'no master-key.sh here: the service starts the stack with no master key. Seal the key first (docs/deploy.md "The master key sealed to the host")'
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

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$(quoted "$dir")
$env
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
  mv "$units/$UNIT.next" "$units/$UNIT"
  mv "$units/$CHECK.service.next" "$units/$CHECK.service"
  mv "$units/$CHECK.timer.next" "$units/$CHECK.timer"
  say "wrote $units/$UNIT, $CHECK.service and $CHECK.timer (compose: $tool)"

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
  rm -f "$units/$UNIT" "$units/$CHECK.service" "$units/$CHECK.timer"
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

# ExecStart: the stack, made again under this service, so its port belongs to the service and not to a caller. The
# down removes the containers of a service turned off (COMPOSE_PROFILES changed, then the install run again).
start() {
  compose down --remove-orphans </dev/null >&2 || say 'the stop did not remove everything (a box on the hopper network keeps it); the start goes on'
  clear_one_shot
  if [ -f master-key.sh ] && { [ -f hopper-master-key.cred ] || [ -f hopper-master-key.enc ]; }; then
    say 'start the stack with the master key sealed to this host'
    exec bash master-key.sh run bash "$0" up
  fi
  say 'no master key sealed here: the stack starts with no key (a new hopper makes one; seal it: bash master-key.sh seal)'
  compose up -d </dev/null
}

# ExecStop: the containers go, the volumes and the data stay.
stop() {
  compose down </dev/null
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
