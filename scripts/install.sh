#!/usr/bin/env bash
# Install or upgrade job-hopper as systemd --user services: the daemon (job-hopper) and its
# own headless herdr session (job-hopper-herdr). Re-running upgrades in place. Config starters
# (rules.md, webhooks.yaml) are written only when absent. plugins.yaml is the daemon's: it writes
# it on the first boot without one, from sources.yaml and the unit's environment of that boot (so
# an upgrade restarts once on the new code under the OLD unit before installing the new one).
#
# Stage mode (JOB_HOPPER_INSTALL_STAGE=<dir>, used by the daemon's self-update, design.md
# "Self-update"): build the install into <dir> and stop there — no service, unit or config is
# touched. JOB_HOPPER_INSTALL_REPO / _BRANCH / _COMMIT then say what it was built from, since the
# source is an unpacked tree with no .git.
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

STAGE="${JOB_HOPPER_INSTALL_STAGE:-}"
# install.json: what this install is built from, so the daemon can tell when a newer one exists.
if [ -n "$STAGE" ]; then
  REPO="${JOB_HOPPER_INSTALL_REPO:?stage mode needs JOB_HOPPER_INSTALL_REPO}"
  BRANCH="${JOB_HOPPER_INSTALL_BRANCH:?stage mode needs JOB_HOPPER_INSTALL_BRANCH}"
  COMMIT="${JOB_HOPPER_INSTALL_COMMIT:?stage mode needs JOB_HOPPER_INSTALL_COMMIT}"
else
  REPO="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
  BRANCH="${JOB_HOPPER_UPDATE_BRANCH:-main}"
  COMMIT="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$COMMIT" ] && [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "warning: $APP_DIR has uncommitted changes; install.json names $COMMIT, which they are not part of" >&2
  fi
fi

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

# The install: src/, scripts/, systemd/ (self-update installs changed units from here), ui/dist/,
# package*.json, production node_modules, install.json.
assemble() {
  local target="$1"
  step "copy src/, scripts/, systemd/, ui/dist/, package.json, package-lock.json to $target (replacing old ones; node_modules kept for npm ci)"
  mkdir -p "$target/ui"
  rm -rf "$target/src" "$target/scripts" "$target/systemd" "$target/ui/dist"
  cp -r "$APP_DIR/src" "$target/src"
  cp -r "$BUILD/ui/dist" "$target/ui/dist"
  cp -r --preserve=mode "$APP_DIR/scripts" "$target/scripts"
  cp -r "$APP_DIR/systemd" "$target/systemd"
  cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$target/"

  step "npm ci --omit=dev --prefix $target"
  npm ci --omit=dev --prefix "$target"

  if [ -n "$REPO" ] && [ -n "$COMMIT" ]; then
    step "write $target/install.json: $BRANCH at $COMMIT (self-update compares against it)"
    node -e 'const [file, repo, branch, commit] = process.argv.slice(1);
process.getBuiltinModule("node:fs").writeFileSync(file, JSON.stringify({ repo, branch, commit, installedAt: new Date().toISOString() }, null, 2) + "\n");' \
      "$target/install.json" "$REPO" "$BRANCH" "$COMMIT"
  else
    rm -f "$target/install.json"
    echo "warning: $APP_DIR is not a git clone with an origin: no install.json, so self-update is off for this install" >&2
  fi
}

if [ -n "$STAGE" ]; then
  assemble "$STAGE"
  step "staged in $STAGE (stage mode: no service, unit or config touched)"
  exit 0
fi
assemble "$DEST"

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
