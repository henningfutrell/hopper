#!/usr/bin/env bash
# Open the job-hopper UI logged in (docs/design.md "UI session and mutations").
#
# Mints a one-time login code with `job-hopper login-code` into the daemon's database, writes a page
# that POSTs it to /ui/login (mode 0600, in a 0700 dir under $XDG_RUNTIME_DIR), and opens that FILE.
# Only the file path ever appears on a command line (/proc is readable by every user); the code
# passes through a command substitution and bash builtins only. The code works once, for 10 minutes.
#
#   bash ~/.local/lib/job-hopper/scripts/open-ui.sh
#
# database: $JOB_HOPPER_DATABASE_URL, else its line in $JOB_HOPPER_ENV_FILE
#           (default ~/.config/job-hopper/daemon.env, the unit's EnvironmentFile).
# port:     $JOB_HOPPER_PORT, else 4790.
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
cli="$here/../src/cli.ts"
port="${JOB_HOPPER_PORT:-4790}"

if [[ -z "${JOB_HOPPER_DATABASE_URL:-}" ]]; then
  env_file="${JOB_HOPPER_ENV_FILE:-$HOME/.config/job-hopper/daemon.env}"
  if [[ -r "$env_file" ]]; then
    JOB_HOPPER_DATABASE_URL="$(grep -m1 '^JOB_HOPPER_DATABASE_URL=' "$env_file" | cut -d= -f2- || true)"
  fi
fi
if [[ -z "${JOB_HOPPER_DATABASE_URL:-}" ]]; then
  echo "open-ui: JOB_HOPPER_DATABASE_URL is not set and not in ${env_file:-the env file}: which database does the daemon use?" >&2
  exit 1
fi
export JOB_HOPPER_DATABASE_URL

code="$(node "$cli" login-code)"
if [[ ! "$code" =~ ^[0-9a-f]{64}$ ]]; then
  echo "open-ui: job-hopper login-code did not print a login code" >&2
  exit 1
fi

umask 077
dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/job-hopper"
mkdir -p "$dir"
chmod 700 "$dir"
page="$dir/ui-login.html"
rm -f "$page"
printf '%s\n' \
  '<!doctype html><meta charset="utf-8"><title>job-hopper login</title>' \
  "<form id=\"login\" method=\"post\" action=\"http://127.0.0.1:${port}/ui/login\">" \
  "<input type=\"hidden\" name=\"code\" value=\"${code}\">" \
  '<noscript><button>Log in to job-hopper</button></noscript></form>' \
  "<script>document.getElementById('login').submit()</script>" > "$page"
chmod 600 "$page"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$page" >/dev/null 2>&1 &
  echo "open-ui: opened $page"
else
  echo "open-ui: xdg-open not found; open this file in your browser: $page"
fi
