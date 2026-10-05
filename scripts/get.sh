#!/usr/bin/env bash
# The curl install (issue #87):
#
#   curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash
#
# The install page (site/index.html) serves this file as install.sh (.github/workflows/pages.yml);
# the raw URL of scripts/get.sh on main works the same.
#
# Checks what the install needs, clones the hopper's source into $JOB_HOPPER_SRC (or updates the
# clone already there), gives it a database, and runs that source's scripts/install.sh — which
# installs or upgrades the systemd --user services (docs/deploy.md "This host"). Run it again to
# upgrade; the daemon's self-update then tracks the same repository and ref.
#
# The database, first that applies: the one ~/.config/job-hopper/daemon.env already names; the
# JOB_HOPPER_DATABASE_URL given to this script; else the bundled Postgres (deploy/compose.yaml), started
# with docker and a fresh password that install.sh writes into daemon.env.
#
#   JOB_HOPPER_REPO  the repository to install from (default: this one)
#   JOB_HOPPER_REF   the branch to install and track (default: main)
#   JOB_HOPPER_SRC   where the source clone lives (default: ~/.local/share/job-hopper/source)
#   POSTGRES_PORT    the bundled Postgres's loopback port (default: 5433)
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

main() {
  local repo="${JOB_HOPPER_REPO:-https://github.com/henningfutrell/hopper.git}"
  local ref="${JOB_HOPPER_REF:-main}"
  local src="${JOB_HOPPER_SRC:-$HOME/.local/share/job-hopper/source}"
  local env_file="$HOME/.config/job-hopper/daemon.env"

  step() { printf '==> %s\n' "$*"; }
  fail() { printf 'job-hopper install: %s\n' "$*" >&2; exit 1; }

  local tool
  for tool in git node npm systemctl; do
    command -v "$tool" >/dev/null || fail "needs $tool on PATH (README.md \"What you need\")"
  done
  local major; major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [ "$major" -ge 24 ] 2>/dev/null || fail "needs Node.js >= 24; this one is $(node --version)"

  if [ -d "$src/.git" ]; then
    [ -z "$(git -C "$src" status --porcelain --untracked-files=no)" ] \
      || fail "$src has local changes; commit or discard them, or set JOB_HOPPER_SRC to another directory"
    step "update $src to $ref of $repo"
    git -C "$src" remote set-url origin "$repo"
    git -C "$src" fetch --quiet origin "$ref"
    git -C "$src" checkout --quiet -B "$ref" FETCH_HEAD
  else
    step "clone $ref of $repo into $src"
    mkdir -p "$(dirname "$src")"
    git clone --quiet --branch "$ref" "$repo" "$src"
  fi

  if [ -r "$env_file" ] && grep -qE '^JOB_HOPPER_DATABASE_URL(_FILE)?=' "$env_file"; then
    step "database: the one $env_file names"
  elif [ -n "${JOB_HOPPER_DATABASE_URL:-}" ]; then
    step "database: JOB_HOPPER_DATABASE_URL as given"
  else
    command -v docker >/dev/null || fail "no database: set JOB_HOPPER_DATABASE_URL=postgres://user:password@host:port/database, or install docker for the bundled Postgres"
    # The bundled Postgres keeps its password in its volume from the first start; a new one would not match.
    if docker volume inspect job-hopper_postgres >/dev/null 2>&1; then
      fail "the docker volume job-hopper_postgres exists, and its password is not in $env_file: set JOB_HOPPER_DATABASE_URL with that password, or remove the volume (its data with it)"
    fi
    local password; password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
    local port="${POSTGRES_PORT:-5433}"
    step "database: the bundled Postgres on 127.0.0.1:$port (docker compose -f $src/deploy/compose.yaml up -d --wait postgres)"
    POSTGRES_PASSWORD="$password" docker compose -f "$src/deploy/compose.yaml" up -d --wait postgres
    export JOB_HOPPER_DATABASE_URL="postgres://hopper:$password@127.0.0.1:$port/hopper"
  fi

  step "bash $src/scripts/install.sh"
  JOB_HOPPER_UPDATE_BRANCH="$ref" bash "$src/scripts/install.sh"
}

main "$@"
