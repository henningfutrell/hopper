#!/usr/bin/env bash
# Install or upgrade job-hopper as systemd --user services: the daemon (job-hopper) and its
# own headless herdr session (job-hopper-herdr). Re-running upgrades in place.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/lib/job-hopper"
UNIT_DIR="$HOME/.config/systemd/user"
URL="http://127.0.0.1:4790"
RULES="$HOME/.config/job-hopper/rules.md"

step() { printf '==> %s\n' "$*"; }

step "copy src/, package.json, package-lock.json to $DEST (replacing old src/; node_modules kept for npm ci)"
mkdir -p "$DEST"
rm -rf "$DEST/src"
cp -r "$APP_DIR/src" "$DEST/src"
cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$DEST/"

step "npm ci --omit=dev --prefix $DEST"
npm ci --omit=dev --prefix "$DEST"

step "install units to $UNIT_DIR: job-hopper.service, job-hopper-herdr.service"
mkdir -p "$UNIT_DIR"
install -m 0644 "$APP_DIR/systemd/job-hopper.service" "$UNIT_DIR/job-hopper.service"
install -m 0644 "$APP_DIR/systemd/job-hopper-herdr.service" "$UNIT_DIR/job-hopper-herdr.service"

if [ -e "$RULES" ]; then
  step "keep existing rules file $RULES"
else
  step "write starter rules file $RULES (edit it: every answer tier reads it on each question)"
  mkdir -p "$(dirname "$RULES")"
  cat > "$RULES" <<'RULES_EOF'
# Standing rules for job-hopper's answer tiers (starter — edit me)

Every model tier answering a question from an unattended job reads this file.

- Never push or force-push.
- Never delete files outside the job's working directory.
- Never deploy or publish anything.
- Never spend money or buy anything.
- Never send messages, emails or posts to anyone.
- Prefer the smallest change that does the job.
- When unsure, say you are not confident, so a human is asked.
RULES_EOF
fi

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "systemctl --user enable job-hopper-herdr job-hopper"
systemctl --user enable job-hopper-herdr job-hopper

if systemctl --user is-active --quiet job-hopper-herdr; then
  step "job-hopper-herdr is active: NOT restarted (restarting it would kill every parked pane and its Claude job)"
else
  step "systemctl --user start job-hopper-herdr"
  systemctl --user start job-hopper-herdr
fi

step "systemctl --user restart job-hopper (starts it, or restarts onto the new code)"
systemctl --user restart job-hopper

step "wait for $URL/api/health (20 tries, 0.5 s apart)"
for i in $(seq 1 20); do
  if health="$(curl -fsS "$URL/api/health" 2>/dev/null)"; then
    printf 'health (try %s): %s\n' "$i" "$health"
    printf 'executors: %s\n' "$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log((JSON.parse(s).executors??[]).join(", ")))')"
    printf 'UI: %s/\n' "$URL"
    exit 0
  fi
  printf '  try %s/20: not up yet\n' "$i"
  sleep 0.5
done

echo "job-hopper did not answer /api/health in 10 s. Inspect: journalctl --user -u job-hopper -n 50" >&2
exit 1
