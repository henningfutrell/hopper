#!/usr/bin/env bash
# Install or upgrade hopper as systemd --user services on this host: the daemon (hopper)
# and its own headless herdr session (hopper-herdr). Re-running upgrades in place. This is one
# deploy recipe; the container image is another (docs/deploy.md).
#
# Everything the daemon keeps is in its database: HOPPER_DATABASE_URL in
# ~/.config/hopper/daemon.env (the unit's EnvironmentFile, mode 600) says which. The first
# install needs it: set it there, or run with HOPPER_DATABASE_URL set and it is written there.
# Config is in that database — the plugins, the rules, sign-in and the webhook subscriptions — and
# edited from the UI; there is no config file. Secrets are daemon.env lines.
#
# Build-only mode (HOPPER_INSTALL_INTO=<dir>, used by the daemon's self-update, design.md
# "Self-update"): build the install into <dir> and stop there — no service, unit or config is
# touched. HOPPER_INSTALL_REPO / _BRANCH / _COMMIT then say what it was built from, since the
# source is an unpacked tree with no .git.
#
# The rename from job-hopper (issue #112): an install from before it is moved to the new names here
# (src/update/rename.ts), its state kept. A job-hopper daemon's self-update runs this script in build-only
# mode under the old variable names, which are read for that alone.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/lib/hopper"
UNIT_DIR="$HOME/.config/systemd/user"
URL="http://127.0.0.1:4790"
CONFIG_DIR="$HOME/.config/hopper"
ENV_FILE="$CONFIG_DIR/daemon.env"
BIN_DIR="$HOME/.local/bin"

step() { printf '==> %s\n' "$*"; }

if [ -z "${HOPPER_INSTALL_INTO:-}" ] && [ -n "${JOB_HOPPER_INSTALL_INTO:-}" ]; then
  HOPPER_INSTALL_INTO="$JOB_HOPPER_INSTALL_INTO" HOPPER_INSTALL_REPO="${JOB_HOPPER_INSTALL_REPO:-}"
  HOPPER_INSTALL_BRANCH="${JOB_HOPPER_INSTALL_BRANCH:-}" HOPPER_INSTALL_COMMIT="${JOB_HOPPER_INSTALL_COMMIT:-}"
fi
INTO="${HOPPER_INSTALL_INTO:-}"
# install.json: what this install is built from, so the daemon can tell when a newer one exists.
if [ -n "$INTO" ]; then
  REPO="${HOPPER_INSTALL_REPO:?build-only mode needs HOPPER_INSTALL_REPO}"
  BRANCH="${HOPPER_INSTALL_BRANCH:?build-only mode needs HOPPER_INSTALL_BRANCH}"
  COMMIT="${HOPPER_INSTALL_COMMIT:?build-only mode needs HOPPER_INSTALL_COMMIT}"
else
  REPO="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
  BRANCH="${HOPPER_UPDATE_BRANCH:-main}"
  COMMIT="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$COMMIT" ] && [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "warning: $APP_DIR has uncommitted changes; install.json names $COMMIT, which they are not part of" >&2
  fi
fi

# The UI is the one built part (ui/ -> ui/dist). It is built in a throwaway copy so the checkout's
# node_modules (possibly a symlink shared by worktrees) and ui/dist are never touched, and a clean
# clone with no node_modules installs the same way.
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/hopper-ui.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
step "build the UI bundle in $BUILD (copy ui/, src/, site/hopper-logo.svg, package*.json; npm ci with dev dependencies; npm run build:ui)"
cp -r "$APP_DIR/ui" "$APP_DIR/src" "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$BUILD/"
# Tailwind finds the classes the UI uses by scanning its files, and skips what a .gitignore ignores, up
# to the filesystem root: a TMPDIR inside an ignored directory hid them all, and the UI shipped unstyled
# (issue #266). The copy's own .gitignore takes everything back in.
printf '!*\n' > "$BUILD/.gitignore"
mkdir -p "$BUILD/site" && cp "$APP_DIR/site/hopper-logo.svg" "$BUILD/site/"
rm -rf "$BUILD/ui/dist" "$BUILD/ui/node_modules"
npm ci --prefix "$BUILD" --no-audit --no-fund
npm run build:ui --prefix "$BUILD"
[ -s "$BUILD/ui/dist/index.html" ] || { echo "UI build wrote no $BUILD/ui/dist/index.html" >&2; exit 1; }

# The install: src/, scripts/, systemd/ (self-update installs changed units from here), ui/dist/,
# package*.json, WHATS-NEW.md (the Updates panel's "this version"), production node_modules, install.json.
assemble() {
  local target="$1"
  step "copy src/, scripts/, systemd/, ui/dist/, package.json, package-lock.json, WHATS-NEW.md to $target (replacing old ones; node_modules kept for npm ci)"
  mkdir -p "$target/ui"
  rm -rf "$target/src" "$target/scripts" "$target/systemd" "$target/ui/dist"
  cp -r "$APP_DIR/src" "$target/src"
  cp -r "$BUILD/ui/dist" "$target/ui/dist"
  cp -r --preserve=mode "$APP_DIR/scripts" "$target/scripts"
  cp -r "$APP_DIR/systemd" "$target/systemd"
  cp "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$target/"
  cp "$APP_DIR/WHATS-NEW.md" "$target/"

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

if [ -n "$INTO" ]; then
  assemble "$INTO"
  step "built into $INTO (build-only mode: no service, unit or config touched)"
  exit 0
fi
assemble "$DEST"

# A job-hopper install becomes this one: its config dir, daemon.env, work dir and client relay lines move
# to the new names, and its units go. It waits (exit 1) while a job holds a pane in its herdr session.
step "move a job-hopper install on this host to the new names, if there is one (node $DEST/src/update/rename.ts install)"
node "$DEST/src/update/rename.ts" install

# The database comes first: the daemon does not start without one, and none is assumed.
# It is a secret (it carries the password): the line itself, or a mounted file the
# HOPPER_DATABASE_URL_FILE line names (docs/design.md "Secrets").
env_line() { [ -r "$ENV_FILE" ] && grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
if [ -z "$(env_line HOPPER_DATABASE_URL)" ] && [ -z "$(env_line HOPPER_DATABASE_URL_FILE)" ]; then
  if [ -n "${HOPPER_DATABASE_URL:-}" ]; then
    step "write HOPPER_DATABASE_URL to $ENV_FILE (mode 600)"
    mkdir -p "$CONFIG_DIR"
    (umask 077; printf 'HOPPER_DATABASE_URL=%s\n' "$HOPPER_DATABASE_URL" >> "$ENV_FILE")
  else
    echo "no HOPPER_DATABASE_URL (or HOPPER_DATABASE_URL_FILE) in $ENV_FILE: which database does the daemon keep everything in?" >&2
    echo "  Postgres: docker compose -f $APP_DIR/deploy/compose.yaml up -d postgres (docs/deploy.md), then" >&2
    echo "  HOPPER_DATABASE_URL=postgres://hopper:<password>@127.0.0.1:<port>/hopper bash $0" >&2
    exit 1
  fi
fi
chmod 600 "$ENV_FILE"

# The operator CLI against the daemon's database, given the way daemon.env gives it.
cli() {
  local file; file="$(env_line HOPPER_DATABASE_URL_FILE)"
  if [ -n "$file" ]; then HOPPER_DATABASE_URL_FILE="$file" node "$DEST/src/cli.ts" "$@"
  else HOPPER_DATABASE_URL="$(env_line HOPPER_DATABASE_URL)" node "$DEST/src/cli.ts" "$@"; fi
}

step "link the CLI: $BIN_DIR/hopper -> $DEST/src/cli.ts"
mkdir -p "$BIN_DIR"
chmod 755 "$DEST/src/cli.ts"
ln -sfn "$DEST/src/cli.ts" "$BIN_DIR/hopper"

step "install units to $UNIT_DIR: hopper.service, hopper-herdr.service"
mkdir -p "$UNIT_DIR"
install -m 0644 "$APP_DIR/systemd/hopper.service" "$UNIT_DIR/hopper.service"
install -m 0644 "$APP_DIR/systemd/hopper-herdr.service" "$UNIT_DIR/hopper-herdr.service"

PLUGIN_DIR="$(env_line HOPPER_PLUGIN_DIR)"
if [ -n "$PLUGIN_DIR" ]; then
  step "plugin types: $PLUGIN_DIR/tsconfig.json maps hopper/plugin to $DEST/src/plugins/sdk.ts (an owner-edited one is kept)"
  node "$DEST/scripts/write-plugin-tsconfig.ts" "$PLUGIN_DIR" "$DEST/src/plugins/sdk.ts"
fi

step "systemctl --user daemon-reload"
systemctl --user daemon-reload

step "systemctl --user enable hopper-herdr hopper"
systemctl --user enable hopper-herdr hopper

if systemctl --user is-active --quiet hopper-herdr; then
  step "hopper-herdr is active: NOT restarted (restarting it would kill every parked pane and its Claude job)"
else
  step "systemctl --user start hopper-herdr"
  systemctl --user start hopper-herdr
fi

step "systemctl --user restart hopper (starts it, or restarts onto the new code)"
systemctl --user restart hopper

step "wait for $URL/api/health (20 tries, 0.5 s apart)"
for i in $(seq 1 20); do
  if health="$(curl -fsS "$URL/api/health" 2>/dev/null)"; then
    printf 'health (try %s): %s\n' "$i" "$health"
    printf 'executors: %s\n' "$(printf '%s' "$health" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log((JSON.parse(s).executors??[]).join(", ")))')"
    printf 'UI: %s/ (shows only the sign-in page until you sign in)\n' "$URL"
    if cli config version rules 2>/dev/null | grep -qx missing; then
      step "no rules in the database yet: write the starter (edit them in the UI, Settings → Question gates)"
      node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")))' < "$APP_DIR/scripts/starter-rules.md" \
        | cli config set rules --if-version missing
    fi
    node "$DEST/src/update/rename.ts" cleanup
    echo "open the UI: $URL/ and sign in with GitHub; the first person to sign in with GitHub is the admin (docs/sign-in.md)"
    if [ -n "$(env_line HOPPER_LAN_NAMES)" ]; then
      printf 'LAN: %s (another device: log in with the device-link button in a logged-in UI)\n' "$(env_line HOPPER_LAN_NAMES)"
    else
      echo "LAN: off. To reach the UI from other machines, set HOPPER_LAN_NAMES and HOPPER_LAN_PEERS in $ENV_FILE (docs/design.md \"Reaching the UI across the LAN\")"
    fi
    # GitHub: the gh CLI by default; this hopper's own App when its key is set (README "Connect GitHub").
    if [ -n "$(env_line GITHUB_APP_PRIVATE_KEY)$(env_line GITHUB_APP_PRIVATE_KEY_FILE)" ]; then
      echo "GitHub: this hopper's own GitHub App (GITHUB_APP_PRIVATE_KEY in $ENV_FILE); the gh CLI source is paused"
    elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
      echo "GitHub: the gh CLI, signed in (the default). Next: say whose issues it takes (README \"Give it jobs\")"
    else
      echo "next: connect GitHub. Default: gh auth login (as this user). Or create a GitHub App of your own: bash $DEST/scripts/create-github-app.sh. Never use another hopper's App key. README \"Connect GitHub\""
    fi
    exit 0
  fi
  printf '  try %s/20: not up yet\n' "$i"
  sleep 0.5
done

echo "hopper did not answer /api/health in 10 s. Inspect: journalctl --user -u hopper -n 50" >&2
exit 1
