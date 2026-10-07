#!/usr/bin/env bash
# Prepare another machine to run hopper jobs (design.md "Attached machines"): over ssh, check
# herdr and claude are there, install hopper's own herdr session unit (hopper-herdr), enable
# and start it, and confirm the session runs. Let the hopper in with its own key only (issue #59,
# design.md "Target authentication"): the public half of HOPPER_SSH_KEY_FILE goes into the
# machine's authorized_keys with `restrict` (no forwarding, no pty), and the machine's host key is
# pinned as the one this user's ~/.ssh/known_hosts already trusts — never learned from a connection.
# Then print how to attach it in the UI (Plugins). Re-running is safe: the unit is replaced and
# restarted only if it is not running, and the key is added once.
#   usage: HOPPER_SSH_KEY_FILE=<hopper key> attach-machine.sh <ssh-target> [lanes]
#   (<ssh-target>: a ~/.ssh/config alias or user@host; the key file is created when missing)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="$APP_DIR/systemd/hopper-herdr.service"
SESSION=hopper

usage() { echo "usage: HOPPER_SSH_KEY_FILE=<the hopper's ssh key> $0 <ssh-target> [lanes]" >&2; exit 2; }
[ $# -ge 1 ] || usage
TARGET="$1"
LANES="${2:-2}"
case "$TARGET" in -*|'') usage ;; esac
case "$LANES" in ''|*[!0-9]*|0) usage ;; esac
KEY="${HOPPER_SSH_KEY_FILE:-}"
[ -n "$KEY" ] || usage

step() { printf '==> %s\n' "$*"; }
die() { printf 'attach-machine: %s\n' "$*" >&2; exit 1; }
# One remote command, run by the target's login shell (sh, bash or zsh). Batch mode: never prompts.
remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$TARGET" "$1"; }

step "reach $TARGET over ssh"
remote true || die "cannot reach $TARGET over ssh (ssh -o BatchMode=yes $TARGET true failed)"

step "pin the host key of $TARGET from ~/.ssh/known_hosts"
DEST="$(ssh -G -- "$TARGET")"
HOST="$(printf '%s\n' "$DEST" | awk '$1 == "hostname" { print $2; exit }')"
PORT="$(printf '%s\n' "$DEST" | awk '$1 == "port" { print $2; exit }')"
[ "$PORT" = 22 ] || HOST="[$HOST]:$PORT"
KNOWN="$(ssh-keygen -F "$HOST" -f "$HOME/.ssh/known_hosts" 2>/dev/null | grep -v '^#' || true)"
HOST_KEY="$(printf '%s\n' "$KNOWN" | awk '$2 == "ssh-ed25519" { print $2, $3; exit }')"
[ -n "$HOST_KEY" ] || HOST_KEY="$(printf '%s\n' "$KNOWN" | awk 'NF >= 3 { print $2, $3; exit }')"
[ -n "$HOST_KEY" ] || die "no host key for $TARGET in ~/.ssh/known_hosts: connect once by hand (ssh $TARGET), check its fingerprint, then run this again"

step "check herdr and claude on $TARGET"
# The hopper calls herdr there by name, from its PATH and then ~/.local/bin (issue #311): look it up
# the same way.
HERDR_PATH='PATH="$PATH:$HOME/.local/bin"'
for bin in herdr claude; do
  remote "$HERDR_PATH; command -v $bin >/dev/null" || die "$bin not found on $TARGET (not on its PATH, not in ~/.local/bin)"
done

step "let the hopper in on $TARGET with its own key, restricted"
if [ ! -e "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  ssh-keygen -q -t ed25519 -N '' -C hopper -f "$KEY"
fi
PUB="$(ssh-keygen -y -f "$KEY" | awk '{ print $1, $2 }')"
remote "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && { grep -qF '$PUB' ~/.ssh/authorized_keys || printf '%s\n' 'restrict $PUB hopper' >> ~/.ssh/authorized_keys; }"

step "install ~/.config/systemd/user/hopper-herdr.service on $TARGET"
remote 'mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/hopper-herdr.service' < "$UNIT"

step "enable and start hopper-herdr on $TARGET"
remote 'systemctl --user daemon-reload && systemctl --user enable --now hopper-herdr' || die "systemctl on $TARGET failed"

if ! remote 'loginctl show-user "$(id -un)" -p Linger' | grep -q '^Linger=yes'; then
  printf 'attach-machine: warning: no linger on %s: its herdr session stops when you log out. Run there: sudo loginctl enable-linger "$(id -un)"\n' "$TARGET" >&2
fi

step "verify the herdr session on $TARGET"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if remote "$HERDR_PATH; herdr --session $SESSION status server" | grep -q '^status: running$'; then
    echo "herdr session $SESSION is running on $TARGET"
    cat <<EOF

Attach it in the UI: Plugins → Machine sources, add an ssh instance named $TARGET, then set its
options (the daemon follows them without a restart):
  ssh: $TARGET
  lanes: $LANES
  hostKey: $HOST_KEY
The daemon needs HOPPER_SSH_KEY_FILE=$KEY in its environment (daemon.env).

Jobs there run in the same working directories as here: each job's cwd must exist on $TARGET.
EOF
    # Attached before the rename (issue #112): its old unit still runs session job-hopper, which the
    # stored plugins config entry names (store migration 12) until it is attached again, as now.
    if remote 'test -e ~/.config/systemd/user/job-hopper-herdr.service'; then
      cat <<EOF
$TARGET was attached as job-hopper: its instance in Plugins names session job-hopper. Once no job runs
there, clear that option in Plugins, then remove the old unit there:
  ssh $TARGET 'systemctl --user disable --now job-hopper-herdr && rm ~/.config/systemd/user/job-hopper-herdr.service'
EOF
    fi
    exit 0
  fi
  sleep 1
done
die "herdr session $SESSION is not running on $TARGET (check there: journalctl --user -u hopper-herdr)"
