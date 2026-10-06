#!/usr/bin/env bash
# The curl install (issue #87):
#
#   curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
#
# The install page (site/install.html) serves this file as install.sh (.github/workflows/pages.yml);
# the raw URL of scripts/get.sh on main works the same.
#
# Checks what the install needs, clones the hopper's source into $HOPPER_SRC (or updates the
# clone already there), gives it a database, and runs that source's scripts/install.sh — which
# installs or upgrades the systemd --user services (docs/deploy.md "This host"). Run it again to
# upgrade; the daemon's self-update then tracks the same repository and ref.
#
# The database, first that applies: the one ~/.config/hopper/daemon.env already names; the
# HOPPER_DATABASE_URL given to this script; else the bundled Postgres (deploy/compose.yaml), started
# with docker and a fresh password that install.sh writes into daemon.env.
#
#   HOPPER_SOURCE_REPO  the repository to install from (default: this one)
#   HOPPER_SOURCE_REF   the branch to install and track (default: main)
#   HOPPER_SRC          where the source clone lives (default: ~/.local/share/hopper/source)
#   POSTGRES_PORT       the bundled Postgres's loopback port (default: 5433)
#
# Over a job-hopper install (the name before issue #112) it is an upgrade: its source clone moves to the
# new default, its database is the one its daemon.env names, and install.sh moves the rest.
#
# On Windows it runs inside WSL, with systemd on (site/install.html "On Windows", issue #116).
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

main() {
  local repo="${HOPPER_SOURCE_REPO:-https://github.com/henningfutrell/hopper.git}"
  local ref="${HOPPER_SOURCE_REF:-main}"
  local src="${HOPPER_SRC:-$HOME/.local/share/hopper/source}"
  local env_file="$HOME/.config/hopper/daemon.env"
  local old_env_file="$HOME/.config/job-hopper/daemon.env" old_src="$HOME/.local/share/job-hopper/source"

  step() { printf '==> %s\n' "$*"; }
  fail() { printf 'hopper install: %s\n' "$*" >&2; exit 1; }

  local tool
  for tool in git node npm systemctl; do
    command -v "$tool" >/dev/null || fail "needs $tool on PATH (README.md \"What you need\")"
  done
  local major; major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [ "$major" -ge 24 ] 2>/dev/null || fail "needs Node.js >= 24; this one is $(node --version)"
  # The daemon runs as systemd --user services; WSL starts without systemd unless told to.
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail "needs systemd running for this user (systemctl --user fails). In WSL: add the two lines [boot] and systemd=true to /etc/wsl.conf, run wsl --shutdown in PowerShell, open Ubuntu again and rerun. Elsewhere: log in to a session with a systemd user manager"

  if [ -z "${HOPPER_SRC:-}" ] && [ -d "$old_src/.git" ] && [ ! -e "$src" ]; then
    step "move the job-hopper source clone $old_src to $src"
    mkdir -p "$(dirname "$src")"
    mv "$old_src" "$src"
  fi
  if [ -d "$src/.git" ]; then
    [ -z "$(git -C "$src" status --porcelain --untracked-files=no)" ] \
      || fail "$src has local changes; commit or discard them, or set HOPPER_SRC to another directory"
    step "update $src to $ref of $repo"
    git -C "$src" remote set-url origin "$repo"
    git -C "$src" fetch --quiet origin "$ref"
    git -C "$src" checkout --quiet -B "$ref" FETCH_HEAD
  else
    step "clone $ref of $repo into $src"
    mkdir -p "$(dirname "$src")"
    git clone --quiet --branch "$ref" "$repo" "$src"
  fi

  if [ -r "$env_file" ] && grep -qE '^HOPPER_DATABASE_URL(_FILE)?=' "$env_file"; then
    step "database: the one $env_file names"
  elif [ -r "$old_env_file" ] && grep -qE '^JOB_HOPPER_DATABASE_URL(_FILE)?=' "$old_env_file"; then
    step "database: the one the job-hopper install's $old_env_file names (install.sh moves it to $env_file)"
  elif [ -n "${HOPPER_DATABASE_URL:-}" ]; then
    step "database: HOPPER_DATABASE_URL as given"
  else
    command -v docker >/dev/null || fail "no database: set HOPPER_DATABASE_URL=postgres://user:password@host:port/database, or install docker for the bundled Postgres"
    # The bundled Postgres keeps its password in its volume from the first start; a new one would not match.
    # Its volume keeps the name from before the rename (deploy/compose.yaml).
    if docker volume inspect job-hopper_postgres >/dev/null 2>&1; then
      fail "the docker volume job-hopper_postgres exists, and its password is not in $env_file: set HOPPER_DATABASE_URL with that password, or remove the volume (its data with it)"
    fi
    local password; password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
    local port="${POSTGRES_PORT:-5433}"
    step "database: the bundled Postgres on 127.0.0.1:$port (docker compose -f $src/deploy/compose.yaml up -d --wait postgres)"
    POSTGRES_PASSWORD="$password" docker compose -f "$src/deploy/compose.yaml" up -d --wait postgres
    export HOPPER_DATABASE_URL="postgres://hopper:$password@127.0.0.1:$port/hopper"
  fi

  step "bash $src/scripts/install.sh"
  HOPPER_UPDATE_BRANCH="$ref" bash "$src/scripts/install.sh"
}

main "$@"
