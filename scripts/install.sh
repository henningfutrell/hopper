#!/usr/bin/env bash
# Install or upgrade job-hopper as a systemd --user service. Re-running upgrades in place.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/lib/job-hopper"
UNIT_DIR="$HOME/.config/systemd/user"
URL="http://127.0.0.1:4790"

step() { printf '==> %s\n' "$*"; }

step "copy src/, package.json, package-lock.json to $DEST (replacing old src/; node_modules kept for npm ci)"
mkdir -p "$DEST"
rm -rf "$DEST/src"
cp -r "$APP_DIR/src" "$DEST/src"
cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$DEST/"

step "npm ci --omit=dev --prefix $DEST"
npm ci --omit=dev --prefix "$DEST"

step "install unit to $UNIT_DIR/job-hopper.service"
mkdir -p "$UNIT_DIR"
install -m 0644 "$APP_DIR/systemd/job-hopper.service" "$UNIT_DIR/job-hopper.service"

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "systemctl --user enable job-hopper"
systemctl --user enable job-hopper

step "systemctl --user restart job-hopper (starts it, or restarts onto the new code)"
systemctl --user restart job-hopper

step "wait for $URL/api/health (20 tries, 0.5 s apart)"
for i in $(seq 1 20); do
  if health="$(curl -fsS "$URL/api/health" 2>/dev/null)"; then
    printf 'health (try %s): %s\n' "$i" "$health"
    printf 'UI: %s/\n' "$URL"
    exit 0
  fi
  printf '  try %s/20: not up yet\n' "$i"
  sleep 0.5
done

echo "job-hopper did not answer /api/health in 10 s. Inspect: journalctl --user -u job-hopper -n 50" >&2
exit 1
