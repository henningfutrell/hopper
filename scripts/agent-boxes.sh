#!/usr/bin/env bash
# Agent boxes (design.md "Agent boxes", issues #295 and #307): one container per agent CLI — claude,
# codex, cursor, omp, opencode — on this machine's docker, each an ssh target with its own herdr session,
# attached to the hopper and running its agent's jobs, and a terminal you can open there. One command,
# safe to run again: a run puts every box back as it should be, whatever happened to it since.
#
# The hopper is found, not described:
#   - the hopper in its compose container (compose.yaml): the running container of the compose service
#     `hopper` in the project HOPPER_COMPOSE_PROJECT (default `hopper`, compose.yaml's name;
#     HOPPER_CONTAINER names another container, HOPPER_CONTAINER= none). The boxes join its network and
#     it reaches each as `agent@<box>`; its operator CLI and its key are asked for through `docker exec`.
#     No database to reach, no host install, no ssh config.
#   - a hopper installed on this host: HOPPER_DATABASE_URL or HOPPER_DATABASE_URL_FILE (as in its
#     environment) and its install (HOPPER_APP_DIR); it reaches each box through the Host this script
#     writes into ~/.ssh.
#   - none: the boxes alone, with the hopper's key named — HOPPER_SSH_KEY_FILE (its file, made when
#     missing) or HOPPER_SSH_PUBLIC_KEY (its public line, as Machines → Add shows it).
# HOPPER_USER names the hopper's user when it has several.
#
# Per box `<prefix>-<agent>` (HOPPER_BOX_PREFIX, default hopper-box):
#   - the image `<prefix>-<agent>` from scripts/agent-box/Dockerfile, with this machine's herdr in it;
#   - the container, restarted with docker, on the hopper's network, its sshd published on 127.0.0.1
#     at a fixed port (HOPPER_BOX_PORT_BASE + 1 for claude, + 2 codex, + 3 cursor, + 4 omp, + 5 opencode;
#     base 2220), its home the volume `<prefix>-<agent>-home` (the agent's sign-in, outliving the box);
#   - authorized there: the hopper's key with `restrict`, and your own public keys (~/.ssh/id_*.pub);
#   - an ssh Host `<prefix>-<agent>` in ~/.ssh/<prefix>.config (Included from ~/.ssh/config) and its host
#     key in ~/.ssh/known_hosts, read from the box through docker — for your terminal there;
#   - attached to the hopper as an ssh machine running its agent's executor, its host key pinned.
# --sign-in signs in, at this terminal, each box's agent that is not signed in yet (opencode needs none).
# --remove removes the boxes (their containers, Hosts, known_hosts lines, machines); their homes stay.
# --check proves each box answers the hopper in its compose container (issue #305), and changes nothing:
# from that container, ssh as the hopper connects — its own key, the host key it pins, the box by name on
# its network — then the box's herdr session must be running and its agent CLI must answer. One line per
# box; exit 1 when any fails.
#   usage: agent-boxes.sh [--sign-in] [--remove] [--check] [agent...]    (no agent: all of them)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${HOPPER_APP_DIR:-$HOME/.local/lib/hopper}"
PREFIX="${HOPPER_BOX_PREFIX:-hopper-box}"
PORT_BASE="${HOPPER_BOX_PORT_BASE:-2220}"
PROJECT="${HOPPER_COMPOSE_PROJECT:-hopper}"
ALL_AGENTS=(claude codex cursor omp opencode)
SSH_DIR="$HOME/.ssh"
BOXES_CONFIG="$SSH_DIR/$PREFIX.config"
KNOWN="$SSH_DIR/known_hosts"

usage() { echo "usage: $0 [--sign-in] [--remove] [--check] [agent...]   agents: ${ALL_AGENTS[*]} (default: all)" >&2; exit 2; }
step() { printf '==> %s\n' "$*" >&2; }
die() { printf 'agent-boxes: %s\n' "$*" >&2; exit 1; }
networks() { docker container inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' -- "$1" | grep -v '^$'; }

SIGN_IN=0; REMOVE=0; CHECK=0; AGENTS=()
for a in "$@"; do
  case "$a" in
    --sign-in) SIGN_IN=1 ;;
    --remove) REMOVE=1 ;;
    --check) CHECK=1 ;;
    -h|--help) usage ;;
    claude|codex|cursor|omp|opencode) AGENTS+=("$a") ;;
    *) usage ;;
  esac
done
[ ${#AGENTS[@]} -gt 0 ] || AGENTS=("${ALL_AGENTS[@]}")
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "HOPPER_BOX_PREFIX must be lower-case letters, digits, _ and -"
[[ "$PORT_BASE" =~ ^[0-9]+$ ]] && [ "$PORT_BASE" -ge 1024 ] && [ "$PORT_BASE" -le 65500 ] || die "HOPPER_BOX_PORT_BASE must be a port from 1024 to 65500"

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "docker does not answer (docker info failed)"

# Where the hopper is: `host` (its database named), `container` (its compose container), or `none`.
MODE=none; HC=''; NET=''
if [ -n "${HOPPER_DATABASE_URL:-}${HOPPER_DATABASE_URL_FILE:-}" ]; then
  MODE=host
  [ -f "$APP/src/cli.ts" ] || die "no hopper install at $APP (HOPPER_APP_DIR)"
else
  if [ "${HOPPER_CONTAINER+set}" = set ]; then
    HC="$HOPPER_CONTAINER"
  else
    HC="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=hopper \
      --format '{{.Names}}' 2>/dev/null | head -n 1 || true)"
  fi
  if [ -n "$HC" ]; then
    MODE=container
    NET="$(networks "$HC" 2>/dev/null | head -n 1 || true)"
    [ -n "$NET" ] || die "the hopper's container $HC is on no network docker names"
    step "the hopper runs in container $HC (network $NET)"
  fi
fi

USER_ARGS=()
[ -z "${HOPPER_USER:-}" ] || USER_ARGS=(--user "$HOPPER_USER")
# The hopper's operator CLI, where the hopper runs (it holds the database's credentials there).
hopper_cli() {
  if [ "$MODE" = container ]; then docker exec -- "$HC" hopper "$@"; else node "$APP/src/cli.ts" "$@"; fi
}
hopper_cli_in() {
  if [ "$MODE" = container ]; then docker exec -i -- "$HC" hopper "$@"; else node "$APP/src/cli.ts" "$@"; fi
}
# The plugins config through the operator CLI: get it, change it with scripts/agent-boxes.ts, set it.
edit_plugins() {
  local version config
  version="$(hopper_cli config version plugins "${USER_ARGS[@]}" </dev/null)" || die "cannot read the hopper's plugins config"
  config="$(hopper_cli config get plugins "${USER_ARGS[@]}" </dev/null)" || die "cannot read the hopper's plugins config"
  printf '%s' "$config" | node "$SRC/scripts/agent-boxes.ts" "$@" | hopper_cli_in config set plugins --if-version "$version" "${USER_ARGS[@]}" >/dev/null \
    || die "the plugins config was not changed"
}

# A box's fixed sshd port on 127.0.0.1: the same on every start, so its Host and known_hosts line hold.
port_of() {
  local i
  for i in "${!ALL_AGENTS[@]}"; do [ "${ALL_AGENTS[$i]}" != "$1" ] || { echo $((PORT_BASE + i + 1)); return; }; done
}
published() { docker port "$1" 22/tcp 2>/dev/null | awk -F: '/^127\.0\.0\.1:/ { print $2; exit }' || true; }

# ~/.ssh/<prefix>.config: one Host per running box, rewritten whole; Included from ~/.ssh/config.
write_ssh_config() {
  install -d -m 700 "$SSH_DIR"
  local tmp="$BOXES_CONFIG.new" name port
  {
    echo "# Written by the hopper's scripts/agent-boxes.sh: its agent boxes. Rewritten on every run."
    for name in $(docker ps --filter "label=hopper.agent-box" --format '{{.Names}}' | sort); do
      case "$name" in "$PREFIX"-*) ;; *) continue ;; esac
      port="$(published "$name")"
      [ -n "$port" ] || continue
      printf 'Host %s\n  HostName 127.0.0.1\n  Port %s\n  User agent\n\n' "$name" "$port"
    done
  } > "$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$BOXES_CONFIG"
  local include="Include $BOXES_CONFIG"
  touch "$SSH_DIR/config" && chmod 600 "$SSH_DIR/config"
  if ! grep -qxF "$include" "$SSH_DIR/config"; then
    # First in the file: an Include after a Host line would belong to that Host.
    { echo "$include"; echo; cat "$SSH_DIR/config"; } > "$SSH_DIR/config.new"
    chmod 600 "$SSH_DIR/config.new" && mv "$SSH_DIR/config.new" "$SSH_DIR/config"
  fi
}

forget_host() { [ ! -f "$KNOWN" ] || ssh-keygen -R "$1" -f "$KNOWN" >/dev/null 2>&1 || true; rm -f "$KNOWN.old"; }

# Whether a box's agent is signed in, asked of its own CLI. opencode runs its own free models unsigned.
signed_in() {
  local name="$1" agent="$2" said
  case "$agent" in
    claude) docker exec -u agent -- "$name" claude auth status 2>/dev/null | grep -q '"loggedIn": true' ;;
    codex) docker exec -u agent -- "$name" codex login status >/dev/null 2>&1 ;;
    cursor) said="$(docker exec -u agent -- "$name" cursor-agent status 2>&1)" && ! grep -qi 'not logged in' <<<"$said" ;;
    omp) said="$(docker exec -u agent -- "$name" omp models 2>&1)" && ! grep -qE 'No models available|models\.yml' <<<"$said" ;;
    opencode) true ;;
  esac
}
# Its CLI's own sign-in, at this terminal (a device code or a link to open anywhere).
sign_in_command() {
  case "$1" in
    claude) echo 'claude auth login' ;;
    codex) echo 'codex login --device-auth' ;;
    cursor) echo 'cursor-agent login' ;;
    omp) echo 'omp login' ;;
  esac
}

if [ "$REMOVE" = 1 ]; then
  NAMES=()
  for agent in "${AGENTS[@]}"; do
    name="$PREFIX-$agent"; NAMES+=("$name")
    port="$(published "$name")"
    [ -z "$port" ] || forget_host "[127.0.0.1]:$port"
    step "remove $name"
    docker rm -f -- "$name" >/dev/null 2>&1 || true
  done
  write_ssh_config
  if [ "$MODE" != none ]; then step "detach ${NAMES[*]} from the hopper"; edit_plugins detach "${NAMES[@]}"; fi
  step "removed; their homes stay (docker volume rm ${NAMES[*]/%/-home})"
  exit 0
fi

# --check: run in the hopper's container, as the hopper (src/executors/ssh.ts sshArgv): its own key and
# the host key it pins for `agent@<box>`, both in its work dir. Prints the herdr status line, then `cli: `
# and the agent CLI's version, or what failed.
CHECK_SH='box=$1; cli=$2; [ "$cli" = cursor ] && cli=cursor-agent
for d in "${HOPPER_WORK_DIR:?the hopper container sets no HOPPER_WORK_DIR}"/users/*/ssh; do
  grep -q "^agent@$box " "$d/known_hosts" 2>/dev/null || continue
  exec ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes \
    -o ConnectTimeout=5 -o UserKnownHostsFile="$d/known_hosts" -o HostKeyAlias="agent@$box" -i "$d/hopper_ed25519" \
    -l agent -- "$box" "herdr --session hopper status server 2>&1 | head -n 1
      if v=\$($cli --version 2>/dev/null | head -n 1) && [ -n \"\$v\" ]; then echo \"cli: \$v\"; else echo \"no $cli on the box\"; fi"
done
echo "the hopper pins no host key for agent@$box: attach it (agent-boxes.sh)"; exit 1'

if [ "$CHECK" = 1 ]; then
  [ "$MODE" = container ] || die "--check needs the hopper's compose container running (project $PROJECT): it checks each box as that hopper reaches it"
  failed=0
  for agent in "${AGENTS[@]}"; do
    name="$PREFIX-$agent"
    out="$(printf '%s\n' "$CHECK_SH" | docker exec -i -- "$HC" sh -s -- "$name" "$agent" 2>&1 || true)"
    status_line="$(sed -n 1p <<<"$out")"; cli_line="$(sed -n 2p <<<"$out")"
    if [ "$status_line" = 'status: running' ] && [[ "$cli_line" == 'cli: '* ]]; then
      printf '%s: ok — herdr session running, %s\n' "$name" "${cli_line#cli: }"
    else
      printf '%s: FAILED — %s\n' "$name" "$(tr '\n' ' ' <<<"$out" | sed 's/ *$//')"; failed=1
    fi
  done
  exit "$failed"
fi

# The hopper's key: the file its runtime mounts (made when missing), its public line, or the hopper's own.
KEY="${HOPPER_SSH_KEY_FILE:-}"
if [ -n "$KEY" ]; then
  if [ ! -e "$KEY" ]; then
    mkdir -p "$(dirname "$KEY")"
    ssh-keygen -q -t ed25519 -N '' -C hopper -f "$KEY"
  fi
  HOPPER_PUB="$(ssh-keygen -y -f "$KEY" | awk '{ print $1, $2 }')"
elif [ -n "${HOPPER_SSH_PUBLIC_KEY:-}" ]; then
  HOPPER_PUB="$(printf '%s\n' "$HOPPER_SSH_PUBLIC_KEY" | awk '{ print $1, $2 }')"
elif [ "$MODE" != none ]; then
  HOPPER_PUB="$(hopper_cli ssh-key "${USER_ARGS[@]}" | awk '{ print $1, $2 }')" || die "the hopper did not give its ssh key (hopper ssh-key)"
else
  die "no hopper found to attach to: run the hopper (compose.yaml), or name its key: HOPPER_SSH_KEY_FILE (its file), or HOPPER_SSH_PUBLIC_KEY (its public line, as Machines → Add shows it)"
fi
[[ "$HOPPER_PUB" =~ ^ssh-[a-z0-9-]+\ [A-Za-z0-9+/=]+$ ]] || die "the hopper's ssh key is not a public key line: $HOPPER_PUB"
HERDR="${HOPPER_BOX_HERDR:-$(command -v herdr || true)}"
[ -x "$HERDR" ] || die "herdr not found here: the boxes run this machine's herdr (or set HOPPER_BOX_HERDR)"

CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
cp "$SRC/scripts/agent-box/Dockerfile" "$SRC/scripts/agent-box/entrypoint.sh" "$SRC/scripts/agent-box/pickup.ts" "$CONTEXT/"
cp "$HERDR" "$CONTEXT/herdr"

# Who may log in to a box: the hopper's key restricted, then each of your own keys that is not it.
authorized() {
  printf 'restrict %s hopper\n' "$HOPPER_PUB"
  local pub k
  for pub in "$SSH_DIR"/id_*.pub; do
    [ -f "$pub" ] || continue
    k="$(awk '{ print $1, $2 }' "$pub")"
    [ "$k" = "$HOPPER_PUB" ] || printf '%s owner\n' "$k"
  done
}

ATTACHED='['
for agent in "${AGENTS[@]}"; do
  name="$PREFIX-$agent"
  port="$(port_of "$agent")"
  step "build $name (the $agent CLI)"
  before="$(docker image inspect --format '{{.Id}}' "$name" 2>/dev/null || true)"
  docker build -q -t "$name" --build-arg AGENT="$agent" "$CONTEXT" >/dev/null || die "building $name failed"

  state="$(docker container inspect --format '{{.State.Running}}' -- "$name" 2>/dev/null || true)"
  if [ -n "$state" ] && [ "$(docker container inspect --format '{{.Image}}' -- "$name")" != "$(docker image inspect --format '{{.Id}}' "$name")" ]; then
    step "$name has an older image: start it again from the new one"
    docker rm -f -- "$name" >/dev/null; state=''
  elif [ -n "$state" ] && [ "$(docker container inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' -- "$name")" != "127.0.0.1:$port" ]; then
    step "$name is not published at its fixed port $port: start it again there"
    docker rm -f -- "$name" >/dev/null; state=''
  fi
  if [ "$state" = true ]; then
    step "$name already runs"
  elif [ "$state" = false ]; then
    step "start $name"; docker start -- "$name" >/dev/null
  else
    step "create $name"
    docker run -d --name "$name" --hostname "$name" --restart unless-stopped --init ${NET:+--network "$NET"} \
      --label hopper.agent-box="$agent" -p "127.0.0.1:$port:22" -v "$name-home:/home/agent" "$name" >/dev/null \
      || die "$name did not start (is 127.0.0.1:$port taken? HOPPER_BOX_PORT_BASE moves the ports)"
  fi
  # The image this build replaced, untagged now and run by nothing: removed, so rebuilds do not pile up (issue #401).
  if [ -n "$before" ] && [ "$before" != "$(docker image inspect --format '{{.Id}}' "$name")" ]; then
    docker image rm -- "$before" >/dev/null 2>&1 || true
  fi
  # On the hopper's network, whatever happened to the box since (a network left, a box started by hand).
  if [ -n "$NET" ] && ! networks "$name" | grep -qxF "$NET"; then
    step "join $name to the hopper's network $NET"
    docker network connect "$NET" "$name"
  fi

  for _ in $(seq 1 30); do
    if [ "$(published "$name")" = "$port" ] && docker exec -- "$name" test -s /etc/ssh/ssh_host_ed25519_key.pub; then break; fi
    sleep 1
  done
  [ "$(published "$name")" = "$port" ] || die "$name publishes no ssh port (docker logs $name)"

  step "let the hopper and you into $name"
  authorized | docker exec -i -u agent -- "$name" sh -c 'umask 077; mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys'
  HOST_KEY="$(docker exec -- "$name" cat /etc/ssh/ssh_host_ed25519_key.pub | awk '{ print $1, $2 }')"
  [[ "$HOST_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || die "no host key in $name"
  install -d -m 700 "$SSH_DIR"
  forget_host "[127.0.0.1]:$port"
  printf '[127.0.0.1]:%s %s\n' "$port" "$HOST_KEY" >> "$KNOWN"
  chmod 600 "$KNOWN"
  write_ssh_config

  # Its herdr session: over ssh as the hopper reaches it when its key file is here, else in the box.
  if [ -n "$KEY" ]; then
    step "check $name over ssh, as the hopper"
    check() { ssh -F "$SSH_DIR/config" -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
      -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -i "$KEY" -- "$name" "/usr/local/bin/herdr --session hopper status server" 2>/dev/null; }
  else
    step "check $name's herdr session"
    check() { docker exec -u agent -- "$name" herdr --session hopper status server 2>/dev/null; }
  fi
  ok=''
  for _ in $(seq 1 20); do
    if check | grep -q '^status: running$'; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || die "$name: its herdr session does not answer (docker logs $name)"
  # The hopper in its container reaches the box by name on its network, port 22: the box's own host key answers there.
  if [ "$MODE" = container ]; then
    step "check the hopper reaches $name"
    ok=''
    for _ in $(seq 1 10); do
      if docker exec -- "$HC" ssh-keyscan -T 5 -t ed25519 "$name" 2>/dev/null | awk '{ print $2, $3 }' | grep -qxF "$HOST_KEY"; then ok=1; break; fi
      sleep 1
    done
    [ -n "$ok" ] || die "the hopper ($HC) does not reach $name on $NET"
  fi
  target="$name"; [ "$MODE" != container ] || target="agent@$name"
  [ "$ATTACHED" = '[' ] || ATTACHED+=','
  ATTACHED+="{\"name\":\"$name\",\"agent\":\"$agent\",\"ssh\":\"$target\",\"hostKey\":\"$HOST_KEY\"}"
done
ATTACHED+=']'

if [ "$MODE" != none ]; then
  step "attach them to the hopper, each running its agent's executor"
  edit_plugins attach "$ATTACHED"
fi

if [ "$SIGN_IN" = 1 ]; then
  for agent in "${AGENTS[@]}"; do
    name="$PREFIX-$agent"
    signed_in "$name" "$agent" && continue
    [ -t 0 ] && [ -t 1 ] || die "--sign-in signs in at a terminal: run it in one"
    step "sign $agent in, in $name (its home keeps it)"
    # shellcheck disable=SC2046 # the CLI's own words
    docker exec -it -u agent -w /home/agent -- "$name" $(sign_in_command "$agent") || true
  done
fi

echo
UNSIGNED=()
for agent in "${AGENTS[@]}"; do
  name="$PREFIX-$agent"
  if signed_in "$name" "$agent"; then said='signed in'; else said='not signed in'; UNSIGNED+=("$agent"); fi
  printf '%s runs the %s CLI (%s): ssh -t %s    (or: herdr --remote %s --session hopper)\n' "$name" "$agent" "$said" "$name" "$name"
done
echo
if [ "$MODE" != none ]; then
  echo "Attached to the hopper (Machines), each running its agent's executor."
else
  echo "No hopper found: run the hopper (compose.yaml), then this again, and the boxes are attached."
fi
if [ ${#UNSIGNED[@]} -gt 0 ]; then
  echo "Sign in the rest once (each box's home keeps it): $0 --sign-in ${UNSIGNED[*]}"
fi
echo "Jobs run in the box's own directories (~/hopper-jobs by default)."
