#!/usr/bin/env bash
# Remove the hopper services (daemon + its herdr session) and code. Keeps the database (it holds
# the queue and every config document) and $CONFIG_DIR (daemon.env, the secret files it names).
set -euo pipefail

DEST="$HOME/.local/lib/hopper"
UNIT_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/hopper"

step() { printf '==> %s\n' "$*"; }

step "systemctl --user disable --now hopper"
systemctl --user disable --now hopper || echo "  (not enabled or not running)"

echo "WARNING: stopping hopper-herdr closes every pane in herdr session 'hopper' (running and parked Claude jobs)."
step "systemctl --user disable --now hopper-herdr"
systemctl --user disable --now hopper-herdr || echo "  (not enabled or not running)"

step "remove $UNIT_DIR/hopper.service and $UNIT_DIR/hopper-herdr.service"
rm -f "$UNIT_DIR/hopper.service" "$UNIT_DIR/hopper-herdr.service"

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "remove $DEST"
rm -rf "$DEST"

echo "Kept the database HOPPER_DATABASE_URL names — the queue and every config document are your data. Drop it by hand to discard them."
echo "Kept $CONFIG_DIR — daemon.env and the secret files it names."
echo "The GitHub App itself stays on GitHub; delete it at https://github.com/settings/apps if you no longer want it."
echo "The herdr session directory ~/.config/herdr/sessions/hopper is kept; remove it with: herdr session delete hopper"
