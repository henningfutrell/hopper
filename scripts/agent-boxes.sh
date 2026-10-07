#!/usr/bin/env bash
# Agent boxes for testing (design.md "Agent boxes", issue #295): one container per agent CLI — claude,
# codex, cursor, omp, opencode — on this machine's docker, each an ssh target with its own herdr
# session, so the hopper attaches to all of them and so can you. Per box `<prefix>-<agent>`:
#   - the image `<prefix>-<agent>` from scripts/agent-box/Dockerfile, with this machine's herdr in it;
#   - the container, restarted with docker, its sshd published on 127.0.0.1 only (a free port), its
#     home the volume `<prefix>-<agent>-home` (the agent's sign-in lives there, and outlives the box);
#   - authorized there: the hopper's key (HOPPER_SSH_KEY_FILE, or its public line HOPPER_SSH_PUBLIC_KEY)
#     with `restrict`, and your own public keys (~/.ssh/id_*.pub), so you can open a terminal there and
#     sign the agent in;
#   - an ssh Host `<prefix>-<agent>` in ~/.ssh/<prefix>.config (Included from ~/.ssh/config), and its
#     host key in ~/.ssh/known_hosts — read from the container itself through docker, never learned
#     from a connection — so the Machines view's Add form takes it like any ssh target.
# With --attach, each box is also attached to the hopper as an ssh machine (through the operator CLI,
# `hopper config`: needs the daemon's HOPPER_DATABASE_URL or HOPPER_DATABASE_URL_FILE). A box is
# attached with no executors, so no queued job lands on it by chance; list them in Plugins.
# --remove removes the boxes (their containers, Hosts and known_hosts lines; with --attach, their
# machines too); their home volumes stay. Re-running keeps a running box and refreshes the rest.
#   usage: agent-boxes.sh [--attach] [--remove] [agent...]    (no agent: all of them)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${HOPPER_APP_DIR:-$HOME/.local/lib/hopper}"
PREFIX="${HOPPER_BOX_PREFIX:-hopper-box}"
ALL_AGENTS=(claude codex cursor omp opencode)
SSH_DIR="$HOME/.ssh"
BOXES_CONFIG="$SSH_DIR/$PREFIX.config"
KNOWN="$SSH_DIR/known_hosts"

usage() { echo "usage: $0 [--attach] [--remove] [agent...]   agents: ${ALL_AGENTS[*]} (default: all)" >&2; exit 2; }
step() { printf '==> %s\n' "$*" >&2; }
die() { printf 'agent-boxes: %s\n' "$*" >&2; exit 1; }

ATTACH=0; REMOVE=0; AGENTS=()
for a in "$@"; do
  case "$a" in
    --attach) ATTACH=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) usage ;;
    claude|codex|cursor|omp|opencode) AGENTS+=("$a") ;;
    *) usage ;;
  esac
done
[ ${#AGENTS[@]} -gt 0 ] || AGENTS=("${ALL_AGENTS[@]}")
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "HOPPER_BOX_PREFIX must be lower-case letters, digits, _ and -"

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "docker does not answer (docker info failed)"

# The plugins config through the operator CLI: get it, change it with scripts/agent-boxes.ts, set it.
hopper_cli() { node "$APP/src/cli.ts" "$@"; }
edit_plugins() {
  [ -n "${HOPPER_DATABASE_URL:-}${HOPPER_DATABASE_URL_FILE:-}" ] \
    || die "--attach needs the daemon's database: HOPPER_DATABASE_URL or HOPPER_DATABASE_URL_FILE, as in its environment"
  [ -f "$APP/src/cli.ts" ] || die "no hopper install at $APP (HOPPER_APP_DIR)"
  local version config
  version="$(hopper_cli config version plugins)" || die "cannot read the plugins config"
  config="$(hopper_cli config get plugins)" || die "cannot read the plugins config"
  printf '%s' "$config" | node "$SRC/scripts/agent-boxes.ts" "$@" | hopper_cli config set plugins --if-version "$version" >/dev/null \
    || die "the plugins config was not changed"
}

# ~/.ssh/<prefix>.config: one Host per running box, rewritten whole; Included from ~/.ssh/config.
write_ssh_config() {
  install -d -m 700 "$SSH_DIR"
  local tmp="$BOXES_CONFIG.new" name port
  {
    echo "# Written by the hopper's scripts/agent-boxes.sh: its agent boxes. Rewritten on every run."
    for name in $(docker ps --filter "label=hopper.agent-box" --format '{{.Names}}' | sort); do
      case "$name" in "$PREFIX"-*) ;; *) continue ;; esac
      port="$(docker port "$name" 22/tcp 2>/dev/null | awk -F: '/^127\.0\.0\.1:/ { print $2; exit }')"
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

if [ "$REMOVE" = 1 ]; then
  NAMES=()
  for agent in "${AGENTS[@]}"; do
    name="$PREFIX-$agent"; NAMES+=("$name")
    port="$(docker port "$name" 22/tcp 2>/dev/null | awk -F: '/^127\.0\.0\.1:/ { print $2; exit }' || true)"
    [ -z "$port" ] || forget_host "[127.0.0.1]:$port"
    step "remove $name"
    docker rm -f -- "$name" >/dev/null 2>&1 || true
  done
  write_ssh_config
  if [ "$ATTACH" = 1 ]; then step "detach ${NAMES[*]} from the hopper"; edit_plugins detach "${NAMES[@]}"; fi
  step "removed; their homes stay (docker volume rm ${NAMES[*]/%/-home})"
  exit 0
fi

# The hopper's key: the file its runtime mounts (made when missing), or its public line as the Machines
# view's Add form shows it — the key a signed-in user's runtime offers (issue #293).
KEY="${HOPPER_SSH_KEY_FILE:-}"
if [ -n "$KEY" ]; then
  if [ ! -e "$KEY" ]; then
    mkdir -p "$(dirname "$KEY")"
    ssh-keygen -q -t ed25519 -N '' -C hopper -f "$KEY"
  fi
  HOPPER_PUB="$(ssh-keygen -y -f "$KEY" | awk '{ print $1, $2 }')"
else
  [ -n "${HOPPER_SSH_PUBLIC_KEY:-}" ] || die "name the hopper's ssh key: HOPPER_SSH_KEY_FILE (its file), or HOPPER_SSH_PUBLIC_KEY (its public line, as Machines → Add shows it)"
  HOPPER_PUB="$(printf '%s\n' "$HOPPER_SSH_PUBLIC_KEY" | awk '{ print $1, $2 }')"
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
  step "build $name (the $agent CLI)"
  docker build -q -t "$name" --build-arg AGENT="$agent" "$CONTEXT" >/dev/null || die "building $name failed"

  state="$(docker container inspect --format '{{.State.Running}}' -- "$name" 2>/dev/null || true)"
  if [ "$state" = true ] && [ "$(docker container inspect --format '{{.Image}}' -- "$name")" != "$(docker image inspect --format '{{.Id}}' "$name")" ]; then
    step "$name runs an older image: start it again from the new one"
    docker rm -f -- "$name" >/dev/null; state=''
  fi
  if [ "$state" = true ]; then
    step "$name already runs"
  elif [ "$state" = false ]; then
    step "start $name"; docker start -- "$name" >/dev/null
  else
    step "create $name"
    docker run -d --name "$name" --hostname "$name" --restart unless-stopped --init \
      --label hopper.agent-box="$agent" -p 127.0.0.1::22 -v "$name-home:/home/agent" "$name" >/dev/null
  fi

  port=''
  for _ in $(seq 1 30); do
    port="$(docker port "$name" 22/tcp 2>/dev/null | awk -F: '/^127\.0\.0\.1:/ { print $2; exit }' || true)"
    if [ -n "$port" ] && docker exec -- "$name" test -s /etc/ssh/ssh_host_ed25519_key.pub; then break; fi
    sleep 1
  done
  [ -n "$port" ] || die "$name publishes no ssh port (docker logs $name)"

  step "let the hopper and you into $name"
  authorized | docker exec -i -u agent -- "$name" sh -c 'umask 077; mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys'
  HOST_KEY="$(docker exec -- "$name" cat /etc/ssh/ssh_host_ed25519_key.pub | awk '{ print $1, $2 }')"
  [[ "$HOST_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || die "no host key in $name"
  install -d -m 700 "$SSH_DIR"
  forget_host "[127.0.0.1]:$port"
  printf '[127.0.0.1]:%s %s\n' "$port" "$HOST_KEY" >> "$KNOWN"
  chmod 600 "$KNOWN"
  write_ssh_config

  # As the hopper reaches it — its key alone, the pinned host key — when its key file is here; else in the box.
  if [ -n "$KEY" ]; then
    step "check $name over ssh, as the hopper"
    check() { ssh -F "$SSH_DIR/config" -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
      -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -i "$KEY" -- "$name" "/usr/local/bin/herdr --session hopper status server" 2>/dev/null; }
  else
    step "check $name's herdr session"
    check() { docker exec -u agent -- "$name" /usr/local/bin/herdr --session hopper status server 2>/dev/null; }
  fi
  ok=''
  for _ in $(seq 1 20); do
    if check | grep -q '^status: running$'; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || die "$name: its herdr session does not answer (docker logs $name)"
  [ "$ATTACHED" = '[' ] || ATTACHED+=','
  ATTACHED+="{\"name\":\"$name\",\"ssh\":\"$name\",\"hostKey\":\"$HOST_KEY\"}"
done
ATTACHED+=']'

if [ "$ATTACH" = 1 ]; then
  step "attach them to the hopper"
  edit_plugins attach "$ATTACHED"
fi

echo
for agent in "${AGENTS[@]}"; do
  printf '%s runs the %s CLI: ssh -t %s    (or: herdr --remote %s --session hopper)\n' "$PREFIX-$agent" "$agent" "$PREFIX-$agent" "$PREFIX-$agent"
done
cat <<EOF

Sign each agent in there once (its home keeps it). Then:
EOF
if [ "$ATTACH" = 1 ]; then
  echo "They are attached (Machines), with no executors: list the ones each runs in Plugins → Machine sources."
else
  echo "Attach them: Machines → Add, one ssh target each (${AGENTS[*]/#/$PREFIX-}), or run this again with --attach."
fi
echo "Jobs run in the box's own directories: a job's work tree must exist there."
