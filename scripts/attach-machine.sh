#!/usr/bin/env bash
# Prepare another machine to run job-hopper jobs (design.md "Attached machines"): over ssh, check
# herdr and claude are there, install job-hopper's own herdr session unit (job-hopper-herdr), enable
# and start it, and confirm the session runs. Then print the plugins.yaml lines that attach it.
# Re-running is safe: the unit is replaced and restarted only if it is not running.
#   usage: attach-machine.sh <ssh-target> [lanes]    (<ssh-target>: a ~/.ssh/config alias or user@host)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="$APP_DIR/systemd/job-hopper-herdr.service"
SESSION=job-hopper

usage() { echo "usage: $0 <ssh-target> [lanes]" >&2; exit 2; }
[ $# -ge 1 ] || usage
TARGET="$1"
LANES="${2:-2}"
case "$TARGET" in -*|'') usage ;; esac
case "$LANES" in ''|*[!0-9]*|0) usage ;; esac

step() { printf '==> %s\n' "$*"; }
die() { printf 'attach-machine: %s\n' "$*" >&2; exit 1; }
# One remote command, run by the target's login shell (sh, bash or zsh). Batch mode: never prompts.
remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$TARGET" "$1"; }

step "reach $TARGET over ssh"
remote true || die "cannot reach $TARGET over ssh (ssh -o BatchMode=yes $TARGET true failed)"

step "check herdr and claude on $TARGET"
for bin in herdr claude; do
  remote "command -v $bin >/dev/null" || die "$bin not found on $TARGET (on the PATH of its non-interactive login shell)"
done

step "install ~/.config/systemd/user/job-hopper-herdr.service on $TARGET"
remote 'mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/job-hopper-herdr.service' < "$UNIT"

step "enable and start job-hopper-herdr on $TARGET"
remote 'systemctl --user daemon-reload && systemctl --user enable --now job-hopper-herdr' || die "systemctl on $TARGET failed"

if ! remote 'loginctl show-user "$(id -un)" -p Linger' | grep -q '^Linger=yes'; then
  printf 'attach-machine: warning: no linger on %s: its herdr session stops when you log out. Run there: sudo loginctl enable-linger "$(id -un)"\n' "$TARGET" >&2
fi

step "verify the herdr session on $TARGET"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if remote "herdr --session $SESSION status server" | grep -q '^status: running$'; then
    echo "herdr session $SESSION is running on $TARGET"
    cat <<EOF

Add to ~/.config/job-hopper/plugins.yaml on this machine, then: systemctl --user restart job-hopper

attachedMachines:
  - { name: $TARGET, ssh: $TARGET, lanes: $LANES }

Jobs there run in the same working directories as here: each job's cwd must exist on $TARGET.
EOF
    exit 0
  fi
  sleep 1
done
die "herdr session $SESSION is not running on $TARGET (check there: journalctl --user -u job-hopper-herdr)"
