#!/usr/bin/env bash
# Install or upgrade job-hopper as systemd --user services on this host: the daemon (job-hopper)
# and its own headless herdr session (job-hopper-herdr). Re-running upgrades in place. This is one
# deploy recipe; the container image is another (docs/deploy.md).
#
# Everything the daemon keeps is in its database: JOB_HOPPER_DATABASE_URL in
# ~/.config/job-hopper/daemon.env (the unit's EnvironmentFile, mode 600) says which. The first
# install needs it: set it there, or run with JOB_HOPPER_DATABASE_URL set and it is written there.
# Config is config documents in that database (plugins.yaml, webhooks.yaml, rules.md, auth.yaml),
# edited from the UI or with `job-hopper config edit <document>`; secrets are daemon.env lines.
#
# Build-only mode (JOB_HOPPER_INSTALL_INTO=<dir>, used by the daemon's self-update, design.md
# "Self-update"): build the install into <dir> and stop there — no service, unit or config is
# touched. JOB_HOPPER_INSTALL_REPO / _BRANCH / _COMMIT then say what it was built from, since the
# source is an unpacked tree with no .git.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/lib/job-hopper"
UNIT_DIR="$HOME/.config/systemd/user"
URL="http://127.0.0.1:4790"
CONFIG_DIR="$HOME/.config/job-hopper"
ENV_FILE="$CONFIG_DIR/daemon.env"
BIN_DIR="$HOME/.local/bin"

step() { printf '==> %s\n' "$*"; }

INTO="${JOB_HOPPER_INSTALL_INTO:-}"
# install.json: what this install is built from, so the daemon can tell when a newer one exists.
if [ -n "$INTO" ]; then
  REPO="${JOB_HOPPER_INSTALL_REPO:?build-only mode needs JOB_HOPPER_INSTALL_REPO}"
  BRANCH="${JOB_HOPPER_INSTALL_BRANCH:?build-only mode needs JOB_HOPPER_INSTALL_BRANCH}"
  COMMIT="${JOB_HOPPER_INSTALL_COMMIT:?build-only mode needs JOB_HOPPER_INSTALL_COMMIT}"
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

if [ -n "$INTO" ]; then
  assemble "$INTO"
  step "built into $INTO (build-only mode: no service, unit or config touched)"
  exit 0
fi
assemble "$DEST"

# The database comes first: the daemon does not start without one, and none is assumed.
env_line() { [ -r "$ENV_FILE" ] && grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
if [ -z "$(env_line JOB_HOPPER_DATABASE_URL)" ]; then
  if [ -n "${JOB_HOPPER_DATABASE_URL:-}" ]; then
    step "write JOB_HOPPER_DATABASE_URL to $ENV_FILE (mode 600)"
    mkdir -p "$CONFIG_DIR"
    (umask 077; printf 'JOB_HOPPER_DATABASE_URL=%s\n' "$JOB_HOPPER_DATABASE_URL" >> "$ENV_FILE")
  else
    echo "no JOB_HOPPER_DATABASE_URL in $ENV_FILE: which database does the daemon keep everything in?" >&2
    echo "  Postgres: docker compose -f $APP_DIR/deploy/compose.yaml up -d postgres (docs/deploy.md), then" >&2
    echo "  JOB_HOPPER_DATABASE_URL=postgres://hopper:<password>@127.0.0.1:<port>/hopper bash $0" >&2
    echo "  SQLite (local use): JOB_HOPPER_DATABASE_URL=sqlite:$HOME/.local/share/job-hopper/store.sqlite bash $0" >&2
    exit 1
  fi
fi
chmod 600 "$ENV_FILE"

# Config files from before the database are migrated, never silently replaced by the built-ins.
if [ -e "$CONFIG_DIR/plugins.yaml" ] && JOB_HOPPER_DATABASE_URL="$(env_line JOB_HOPPER_DATABASE_URL)" node "$DEST/src/cli.ts" config version plugins.yaml 2>/dev/null | grep -qx missing; then
  echo "$CONFIG_DIR/plugins.yaml exists but the database has no plugins.yaml: move the old install first (docs/deploy.md \"Moving an existing install\"):" >&2
  echo "  systemctl --user stop job-hopper" >&2
  echo "  JOB_HOPPER_DATABASE_URL=… $DEST/src/cli.ts migrate-local --from-sqlite <old db> --config-dir $CONFIG_DIR --secrets-out <file>" >&2
  echo "then add the secrets to $ENV_FILE and run install.sh again; or move $CONFIG_DIR/plugins.yaml aside to start empty" >&2
  exit 1
fi

step "link the CLI: $BIN_DIR/job-hopper -> $DEST/src/cli.ts"
mkdir -p "$BIN_DIR"
chmod 755 "$DEST/src/cli.ts"
ln -sfn "$DEST/src/cli.ts" "$BIN_DIR/job-hopper"

step "install units to $UNIT_DIR: job-hopper.service, job-hopper-herdr.service"
mkdir -p "$UNIT_DIR"
install -m 0644 "$APP_DIR/systemd/job-hopper.service" "$UNIT_DIR/job-hopper.service"
install -m 0644 "$APP_DIR/systemd/job-hopper-herdr.service" "$UNIT_DIR/job-hopper-herdr.service"

PLUGIN_DIR="$(env_line JOB_HOPPER_PLUGIN_DIR)"
if [ -n "$PLUGIN_DIR" ]; then
  step "plugin types: $PLUGIN_DIR/tsconfig.json maps job-hopper/plugin to $DEST/src/plugins/sdk.ts (an owner-edited one is kept)"
  node "$DEST/scripts/write-plugin-tsconfig.ts" "$PLUGIN_DIR" "$DEST/src/plugins/sdk.ts"
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
    printf 'UI: %s/ (read-only until you log in)\n' "$URL"
    if JOB_HOPPER_DATABASE_URL="$(env_line JOB_HOPPER_DATABASE_URL)" node "$DEST/src/cli.ts" config version rules.md 2>/dev/null | grep -qx missing; then
      step "no rules.md in the database yet: write the starter (edit it in the UI, Questions → Question gates)"
      JOB_HOPPER_DATABASE_URL="$(env_line JOB_HOPPER_DATABASE_URL)" node "$DEST/src/cli.ts" config set rules.md --if-version missing < "$APP_DIR/scripts/starter-rules.md"
    fi
    echo "open the UI: bash $DEST/scripts/open-ui.sh (or mint a code: job-hopper login-code)"
    if [ -n "$(env_line JOB_HOPPER_LAN_NAMES)" ]; then
      printf 'LAN: %s (another device: log in with the device-link button in a logged-in UI)\n' "$(env_line JOB_HOPPER_LAN_NAMES)"
    else
      echo "LAN: off. To reach the UI from other machines, set JOB_HOPPER_LAN_NAMES and JOB_HOPPER_LAN_PEERS in $ENV_FILE (docs/design.md \"Reaching the UI across the LAN\")"
    fi
    if [ -z "$(env_line GITHUB_APP_PRIVATE_KEY)" ]; then
      echo "next: create the GitHub App (bash $DEST/scripts/create-github-app.sh), then its key goes in $ENV_FILE as GITHUB_APP_PRIVATE_KEY"
    fi
    exit 0
  fi
  printf '  try %s/20: not up yet\n' "$i"
  sleep 0.5
done

echo "job-hopper did not answer /api/health in 10 s. Inspect: journalctl --user -u job-hopper -n 50" >&2
exit 1
