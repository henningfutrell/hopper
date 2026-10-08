#!/bin/sh
# The hopper client's install (design.md "Joining a machine", issue #308), served by the hopper at
# /client/install, so the one line Add machine shows is all a computer needs:
#
#   curl -fsSL '<hopper URL>/client/install' | sh -s -- '<hopper URL>#<join code>' [name]
#
# Checks node >= 24 and herdr, installs the hopper's own client release to ~/.local/lib/hopper-client,
# joins the hopper with the code (the machine's link key stays in ~/.config/hopper-client, mode 600),
# and runs the client and its herdr session as the user units hopper-client and hopper-client-herdr.
# Nothing inbound: the client dials in to the hopper's URL. Re-running installs the release again and
# keeps the machine's link key, so it stays the same machine.
set -eu

die() { printf 'hopper-client install: %s\n' "$*" >&2; exit 1; }

line="${1:-}"
case "$line" in
  http://*'#'*|https://*'#'*) ;;
  *) die "usage: curl -fsSL '<hopper URL>/client/install' | sh -s -- '<hopper URL>#<join code>' [name] (copy the line from Add machine)" ;;
esac
url="${line%%#*}"
name="${2:-}"

command -v node >/dev/null 2>&1 || die 'node is not installed: install Node.js 24 or later (https://nodejs.org)'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
  || die "node $(node --version) is too old: install Node.js 24 or later (https://nodejs.org)"
herdr=$(command -v herdr 2>/dev/null) || die 'herdr is not on PATH: install it (curl -fsSL https://herdr.dev/install.sh | sh)'
node=$(command -v node)

lib="$HOME/.local/lib/hopper-client"
# The hopper's client release, written whole beside the install, then swapped in.
node --input-type=module -e '
  import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
  const [url, lib] = process.argv.slice(1);
  const res = await fetch(new URL("/client/release", url));
  if (!res.ok) { console.error(`hopper-client install: ${url} answered ${res.status} for its client release`); process.exit(1); }
  const { id, files } = await res.json();
  rmSync(`${lib}.next`, { recursive: true, force: true });
  mkdirSync(`${lib}.next`, { recursive: true, mode: 0o755 });
  for (const [name, text] of Object.entries(files)) writeFileSync(`${lib}.next/${name}`, text, { mode: 0o644 });
  rmSync(lib, { recursive: true, force: true });
  renameSync(`${lib}.next`, lib);
  console.log(`hopper-client install: client release ${id} in ${lib}`);
' "$url" "$lib"

if [ -n "$name" ]; then node "$lib/main.ts" join "$line" "$name"; else node "$lib/main.ts" join "$line"; fi

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  # The client exits 75 after the hopper loads a new release into it: whatever runs it starts it again.
  printf '%s\n' 'hopper-client install: no systemd user session here; run the client yourself (restarted after a release load, exit 75):' \
    "  $herdr --session hopper-client server &" "  cd && while :; do $node $lib/main.ts; [ \$? -eq 75 ] || break; done"
  exit 0
fi
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
path="$(dirname "$herdr"):$(dirname "$node"):/usr/local/bin:/usr/bin:/bin"
cat > "$units/hopper-client-herdr.service" <<UNIT
[Unit]
Description=hopper client's herdr session: where a hopper's jobs on this machine run (design.md "Joining a machine")

[Service]
Type=simple
ExecStart=$herdr --session hopper-client server
Environment=PATH=$path
# The panes herdr opens must not inherit a Claude child-session marker.
UnsetEnvironment=CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT CLAUDE_CODE_CHILD_SESSION
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
cat > "$units/hopper-client.service" <<UNIT
[Unit]
Description=hopper client: this machine dialled in to a hopper (design.md "Joining a machine")
Wants=hopper-client-herdr.service
After=network-online.target hopper-client-herdr.service

[Service]
Type=simple
ExecStart=$node $lib/main.ts
Environment=PATH=$path
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=10
NoNewPrivileges=true

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now hopper-client-herdr.service
systemctl --user enable hopper-client.service
systemctl --user restart hopper-client.service
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
  echo 'hopper-client install: lingering is off, so the client stops when you log out: loginctl enable-linger'
fi
echo 'hopper-client install: done; it shows in the hopper'"'"'s Machines view, online, in a few seconds'
