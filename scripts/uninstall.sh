#!/usr/bin/env bash
# Remove the job-hopper service and code. Keeps the queue database.
set -euo pipefail

DEST="$HOME/.local/lib/job-hopper"
UNIT="$HOME/.config/systemd/user/job-hopper.service"
DATA="$HOME/.local/share/job-hopper"

step() { printf '==> %s\n' "$*"; }

step "systemctl --user disable --now job-hopper"
systemctl --user disable --now job-hopper || echo "  (not enabled or not running)"

step "remove $UNIT"
rm -f "$UNIT"

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "remove $DEST"
rm -rf "$DEST"

echo "Kept $DATA — the queue database is your data. Delete it by hand to discard the queue."
