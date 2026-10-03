#!/usr/bin/env bash
# Open the job-hopper UI logged in (docs/design.md "UI session and mutations").
#
# Reads the one-time login code the daemon wrote to <dataDir>/ui-login-code, writes
# <dataDir>/ui-login.html (mode 0600) — a page that POSTs the code to /ui/login — and opens that
# FILE. Only the file path ever appears on a command line (/proc is readable by every user); the
# code is handled by bash builtins only.
#
#   bash ~/.local/lib/job-hopper/scripts/open-ui.sh
#
# dataDir: the directory of $JOB_HOPPER_DB if set, else ~/.local/share/job-hopper.
# port:    $JOB_HOPPER_PORT, else 4790.
set -euo pipefail

if [[ -n "${JOB_HOPPER_DB:-}" ]]; then
  data_dir="${JOB_HOPPER_DB%/*}"
  [[ "$data_dir" == "$JOB_HOPPER_DB" ]] && data_dir=.
else
  data_dir="$HOME/.local/share/job-hopper"
fi
port="${JOB_HOPPER_PORT:-4790}"
code_file="$data_dir/ui-login-code"
page="$data_dir/ui-login.html"

if [[ ! -r "$code_file" ]]; then
  echo "open-ui: no login code at $code_file — is job-hopper running? (systemctl --user status job-hopper)" >&2
  exit 1
fi
code="$(<"$code_file")"
code="${code//[[:space:]]/}"
if [[ ! "$code" =~ ^[0-9a-f]{64}$ ]]; then
  echo "open-ui: $code_file does not hold a login code" >&2
  exit 1
fi

umask 077
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
