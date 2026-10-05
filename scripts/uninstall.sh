#!/usr/bin/env bash
# Remove the job-hopper services (daemon + its herdr session) and code. Keeps the database (it holds
# the queue and every config document) and $CONFIG_DIR (daemon.env, the secret files it names).
set -euo pipefail

DEST="$HOME/.local/lib/job-hopper"
UNIT_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/job-hopper"

step() { printf '==> %s\n' "$*"; }

step "systemctl --user disable --now job-hopper"
systemctl --user disable --now job-hopper || echo "  (not enabled or not running)"

echo "WARNING: stopping job-hopper-herdr closes every pane in herdr session 'job-hopper' (running and parked Claude jobs)."
step "systemctl --user disable --now job-hopper-herdr"
systemctl --user disable --now job-hopper-herdr || echo "  (not enabled or not running)"

step "remove $UNIT_DIR/job-hopper.service and $UNIT_DIR/job-hopper-herdr.service"
rm -f "$UNIT_DIR/job-hopper.service" "$UNIT_DIR/job-hopper-herdr.service"

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "remove $DEST"
rm -rf "$DEST"

echo "Kept the database JOB_HOPPER_DATABASE_URL names — the queue and every config document are your data. Drop it by hand to discard them."
echo "Kept $CONFIG_DIR — daemon.env and the secret files it names."
echo "The GitHub App itself stays on GitHub; delete it at https://github.com/settings/apps if you no longer want it."
echo "The herdr session directory ~/.config/herdr/sessions/job-hopper is kept; remove it with: herdr session delete job-hopper"
