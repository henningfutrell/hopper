#!/usr/bin/env bash
# Install or upgrade job-hopper as systemd --user services: the daemon (job-hopper) and its
# own headless herdr session (job-hopper-herdr). Re-running upgrades in place. Config starters
# (rules.md, webhooks.yaml) are written only when absent. plugins.yaml is the daemon's: it writes
# it on the first boot without one, from sources.yaml and the unit's environment of that boot (so
# an upgrade restarts once on the new code under the OLD unit before installing the new one).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/lib/job-hopper"
UNIT_DIR="$HOME/.config/systemd/user"
URL="http://127.0.0.1:4790"
CONFIG_DIR="$HOME/.config/job-hopper"
RULES="$CONFIG_DIR/rules.md"
PLUGINS="$CONFIG_DIR/plugins.yaml"
WEBHOOKS="$CONFIG_DIR/webhooks.yaml"
PLUGIN_DIR="${JOB_HOPPER_PLUGIN_DIR:-$CONFIG_DIR/plugins}"

step() { printf '==> %s\n' "$*"; }

# The UI is the one built part (ui/ -> ui/dist). It is built in a throwaway copy so the checkout's
# node_modules (possibly a symlink shared by worktrees) and ui/dist are never touched, and a clean
# clone with no node_modules installs the same way.
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/job-hopper-ui.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
step "build the UI bundle in $BUILD (copy ui/, src/, package*.json; npm ci with dev dependencies; npm run build:ui)"
cp -r "$APP_DIR/ui" "$APP_DIR/src" "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$BUILD/"
rm -rf "$BUILD/ui/dist" "$BUILD/ui/node_modules"
npm ci --prefix "$BUILD" --no-audit --no-fund
npm run build:ui --prefix "$BUILD"
[ -s "$BUILD/ui/dist/index.html" ] || { echo "UI build wrote no $BUILD/ui/dist/index.html" >&2; exit 1; }

step "copy src/, scripts/, ui/dist/, package.json, package-lock.json to $DEST (replacing old src/, scripts/ and ui/; node_modules kept for npm ci)"
mkdir -p "$DEST/ui"
rm -rf "$DEST/src" "$DEST/scripts" "$DEST/ui/dist"
cp -r "$APP_DIR/src" "$DEST/src"
cp -r "$BUILD/ui/dist" "$DEST/ui/dist"
cp -r --preserve=mode "$APP_DIR/scripts" "$DEST/scripts"
cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$DEST/"

step "npm ci --omit=dev --prefix $DEST"
npm ci --omit=dev --prefix "$DEST"

if [ ! -e "$PLUGINS" ] && [ -e "$UNIT_DIR/job-hopper.service" ]; then
  step "no $PLUGINS yet: restart job-hopper once on the new code under the OLD unit, so the daemon folds sources.yaml and that unit's environment into it"
  systemctl --user restart job-hopper
  for i in $(seq 1 20); do
    [ -e "$PLUGINS" ] && break
    printf '  try %s/20: %s not written yet\n' "$i" "$PLUGINS"
    sleep 0.5
  done
  if [ -e "$PLUGINS" ]; then
    step "wrote $PLUGINS (sources.yaml, if any, is now sources.yaml.migrated)"
  else
    echo "job-hopper did not write $PLUGINS in 10 s. Inspect: journalctl --user -u job-hopper -n 50" >&2
    exit 1
  fi
fi

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

if [ -e "$WEBHOOKS" ]; then
  step "keep existing webhooks file $WEBHOOKS"
else
  step "write starter webhooks file $WEBHOOKS (mode 600; re-read within 5 s of every change)"
  mkdir -p "$CONFIG_DIR"
  (umask 077; cat > "$WEBHOOKS" <<'WEBHOOKS_EOF'
# job-hopper outbound webhooks: every event, signed with HMAC-SHA256 (docs/events.md).
version: 1
webhooks: []
# webhooks:
#   - name: grok-bot                     # unique; the reconcile key
#     url: http://127.0.0.1:4795/hook
#     events: ["question.escalated", "job.finished", "job.failed"]   # or ["*"]
#     secret: "<hex>"                    # or secretFile: ~/.config/job-hopper/grok-bot.secret
#     active: true
WEBHOOKS_EOF
  )
fi
chmod 600 "$WEBHOOKS"

step "plugin types: $PLUGIN_DIR/tsconfig.json maps job-hopper/plugin to $DEST/src/plugins/sdk.ts (an owner-edited one is kept)"
node "$DEST/scripts/write-plugin-tsconfig.ts" "$PLUGIN_DIR" "$DEST/src/plugins/sdk.ts"

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
    printf 'UI: %s/ (read-only until you log in)\n' "$URL"
    echo 'open the UI: bash ~/.local/lib/job-hopper/scripts/open-ui.sh'
    if [ -r "$CONFIG_DIR/daemon.env" ] && grep -q '^JOB_HOPPER_LAN_NAMES=' "$CONFIG_DIR/daemon.env"; then
      printf 'LAN: %s (another device: log in with the device-link button in a logged-in UI)\n' "$(grep '^JOB_HOPPER_LAN_NAMES=' "$CONFIG_DIR/daemon.env" | cut -d= -f2-)"
    else
      echo "LAN: off. To reach the UI from other machines, set JOB_HOPPER_LAN_NAMES and JOB_HOPPER_LAN_PEERS in $CONFIG_DIR/daemon.env (docs/design.md \"Reaching the UI across the LAN\")"
    fi
    if [ ! -e "$CONFIG_DIR/github-app.json" ]; then
      echo 'next: create the GitHub App (one click in the browser): bash ~/.local/lib/job-hopper/scripts/create-github-app.sh'
    fi
    exit 0
  fi
  printf '  try %s/20: not up yet\n' "$i"
  sleep 0.5
done

echo "job-hopper did not answer /api/health in 10 s. Inspect: journalctl --user -u job-hopper -n 50" >&2
exit 1
