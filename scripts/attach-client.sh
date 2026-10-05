#!/usr/bin/env bash
# Make another machine a client target of this hopper (design.md "Client targets", issue #59), from
# the hopper's machine. Over this user's ssh to that machine: check node and herdr there, install the
# hopper's client release (design.md "Client releases", issue #70: the client files of the hopper's
# install, $JOB_HOPPER_APP_DIR/src/client, as plain files; after this the hopper keeps it current) and its units — the client, and its own herdr session —
# and give it what it proves itself with: a fresh token (256 bits) and its own ssh key, made there
# (the private half never leaves it). Here: pin the client's key in ~/.ssh/authorized_keys as
#   restrict,command="node <app>/src/client/relay.ts <workdir>/clients/<name>.sock" <key>
# so the key opens that one tunnel and nothing else — no shell, no forwarding. The client pins this
# machine's own host key, read here, never learned from a connection. Then print the plugins.yaml entry
# and the daemon.env line. Re-running keeps the token and the key, and replaces the rest.
#   usage: attach-client.sh <name> <ssh-target> <hopper> [lanes]
#     <name>        the machine's name in plugins.yaml (letters, digits, _ and -)
#     <ssh-target>  how this user reaches that machine now (a ~/.ssh/config alias or user@host)
#     <hopper>      how that machine reaches this one: user@host (JOB_HOPPER_CLIENT_HOPPER_PORT, default 22)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${JOB_HOPPER_APP_DIR:-$HOME/.local/lib/job-hopper}"
WORK="${JOB_HOPPER_WORK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/job-hopper}"
TOKENS="${JOB_HOPPER_CLIENT_TOKEN_DIR:-$HOME/.config/job-hopper/clients}"
HOST_KEY_FILE="${JOB_HOPPER_HOST_KEY_FILE:-/etc/ssh/ssh_host_ed25519_key.pub}"
AUTHORIZED="$HOME/.ssh/authorized_keys"
PORT="${JOB_HOPPER_CLIENT_HOPPER_PORT:-22}"
SESSION="${JOB_HOPPER_CLIENT_SESSION:-job-hopper-client}"

usage() { echo "usage: $0 <name> <ssh-target> <user@hopper-host> [lanes]" >&2; exit 2; }
[ $# -ge 3 ] || usage
NAME="$1"; TARGET="$2"; HOPPER="$3"; LANES="${4:-1}"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || usage
case "$TARGET" in -*|'') usage ;; esac
[[ "$HOPPER" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] || usage
case "$LANES" in ''|*[!0-9]*|0) usage ;; esac
case "$PORT" in ''|*[!0-9]*) usage ;; esac

step() { printf '==> %s\n' "$*" >&2; }
die() { printf 'attach-client: %s\n' "$*" >&2; exit 1; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$TARGET" "$1"; }
TOKEN_ENV="CLIENT_TOKEN_$(printf '%s' "$NAME" | tr 'a-z-' 'A-Z_')"
SOCK="$WORK/clients/$NAME.sock"
NODE="$(command -v node)" || die "node not found here"

step "reach $TARGET over ssh"
remote true || die "cannot reach $TARGET over ssh (ssh -o BatchMode=yes $TARGET true failed)"

step "check node and herdr on $TARGET"
remote 'command -v node >/dev/null' || die "node not found on $TARGET"
remote 'node -e "process.exit(Number(process.versions.node.split(\".\")[0]) >= 24 ? 0 : 1)"' || die "node on $TARGET is older than 24"
HERDR_BIN="$(remote 'command -v herdr' | tr -d '\r')"
HERDR_BIN="${HERDR_BIN//\/\//\/}"
case "$HERDR_BIN" in /*) ;; *) die "herdr not found on $TARGET" ;; esac

step "the client's token ($TOKENS/$NAME.token, only this user)"
install -d -m 700 "$TOKENS"
if [ ! -s "$TOKENS/$NAME.token" ]; then
  ( umask 077; node --input-type=module -e 'const { mintToken } = await import(process.argv[1]); console.log(mintToken());' "$SRC/src/client/signature.ts" > "$TOKENS/$NAME.token" )
fi
chmod 600 "$TOKENS/$NAME.token"

step "this machine's host key, for the client to pin"
HOST_KEY="$(awk '{ print $1, $2 }' "$HOST_KEY_FILE")"
[ -n "$HOST_KEY" ] || die "cannot read $HOST_KEY_FILE"

RELEASE="$(node --input-type=module -e 'const { readRelease } = await import(process.argv[1]); const r = readRelease(process.argv[2]); console.log(r.id, ...Object.keys(r.files));' "$APP/src/client/release.ts" "$APP/src/client")" \
  || die "no client release in the hopper's install ($APP/src/client): install the hopper first (scripts/install.sh)"
read -r RELEASE_ID CLIENT_FILES <<<"$RELEASE"
step "install the hopper's client release $RELEASE_ID on $TARGET"
remote 'mkdir -p ~/.local/lib/job-hopper-client ~/.config/systemd/user && install -d -m 700 ~/.config/job-hopper-client'
for f in $CLIENT_FILES; do
  remote "cat > ~/.local/lib/job-hopper-client/$f" < "$APP/src/client/$f"
done
remote '(umask 077; cat > ~/.config/job-hopper-client/token)' < "$TOKENS/$NAME.token"
printf 'job-hopper %s\n' "$HOST_KEY" | remote 'cat > ~/.config/job-hopper-client/known_hosts'
remote '[ -f ~/.config/job-hopper-client/tunnel_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C job-hopper-client -f ~/.config/job-hopper-client/tunnel_ed25519'
PUB="$(remote 'ssh-keygen -y -f ~/.config/job-hopper-client/tunnel_ed25519' | awk '{ print $1, $2 }')"
[[ "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || die "no client key on $TARGET"
remote '(umask 077; cat > ~/.config/job-hopper-client/client.env)' <<ENV
JOB_HOPPER_CLIENT_TOKEN_FILE=%h/.config/job-hopper-client/token
JOB_HOPPER_CLIENT_HERDR_BIN=$HERDR_BIN
JOB_HOPPER_CLIENT_SESSION=$SESSION
JOB_HOPPER_CLIENT_HOPPER=$HOPPER
JOB_HOPPER_CLIENT_HOPPER_PORT=$PORT
JOB_HOPPER_CLIENT_KEY_FILE=%h/.config/job-hopper-client/tunnel_ed25519
JOB_HOPPER_CLIENT_KNOWN_HOSTS=%h/.config/job-hopper-client/known_hosts
ENV
# systemd does not expand %h in an EnvironmentFile: write the home there.
remote 'sed -i "s|%h|$HOME|g" ~/.config/job-hopper-client/client.env'

step "let the client's key open its tunnel here, and nothing else"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && touch "$AUTHORIZED" && chmod 600 "$AUTHORIZED"
install -d -m 700 "$WORK" "$WORK/clients"
MARK="job-hopper-client:$NAME"
LINE="restrict,command=\"$NODE $APP/src/client/relay.ts $SOCK\" $PUB $MARK"
{ grep -v " $MARK\$" "$AUTHORIZED" || true; printf '%s\n' "$LINE"; } > "$AUTHORIZED.new"
chmod 600 "$AUTHORIZED.new" && mv "$AUTHORIZED.new" "$AUTHORIZED"

step "start the client and its herdr session ($SESSION) on $TARGET"
remote 'cat > ~/.config/systemd/user/job-hopper-client.service' < "$SRC/systemd/job-hopper-client.service"
sed -e "s/--session job-hopper /--session $SESSION /g" -e "s/^Description=.*/Description=job-hopper client's herdr session ($SESSION)/" "$SRC/systemd/job-hopper-herdr.service" \
  | remote 'cat > ~/.config/systemd/user/job-hopper-client-herdr.service'
remote 'systemctl --user daemon-reload && systemctl --user enable --now job-hopper-client-herdr && systemctl --user enable job-hopper-client && systemctl --user restart job-hopper-client' \
  || die "systemctl on $TARGET failed"

cat <<EOF2

Add to daemon.env on this machine (then restart the daemon), so it holds the client's token:
${TOKEN_ENV}_FILE=$TOKENS/$NAME.token

Add to plugins.yaml (job-hopper config edit plugins.yaml):
attachedMachines:
  - { name: $NAME, client: { tokenEnv: $TOKEN_ENV }, lanes: $LANES }
EOF2
