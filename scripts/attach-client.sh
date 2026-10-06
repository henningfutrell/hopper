#!/usr/bin/env bash
# Make another machine a client target of this hopper (design.md "Client targets", issue #59), from
# the hopper's machine. Over this user's ssh to that machine: check node and herdr there, install the
# hopper's client release (design.md "Client releases", issue #70: the client files of the hopper's
# install, $HOPPER_APP_DIR/src/client, as plain files; after this the hopper keeps it current) and its units — the client, and its own herdr session —
# and give it what it proves itself with: a fresh token (256 bits) and its own ssh key, made there
# (the private half never leaves it). Here: pin the client's key in ~/.ssh/authorized_keys as
#   restrict,command="node <app>/src/client/relay.ts <workdir>/clients/<name>.sock" <key>
# so the key opens that one tunnel and nothing else — no shell, no forwarding. The client pins this
# machine's own host key, read here, never learned from a connection. Then print how to attach it
# in the UI (Plugins) and the daemon.env line. Re-running keeps the token and the key, and replaces the rest.
#   usage: attach-client.sh <name> <ssh-target> <hopper> [lanes]
#     <name>        the machine's name in Plugins (letters, digits, _ and -)
#     <ssh-target>  how this user reaches that machine now (a ~/.ssh/config alias or user@host)
#     <hopper>      how that machine reaches this one: user@host (HOPPER_CLIENT_HOPPER_PORT, default 22)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${HOPPER_APP_DIR:-$HOME/.local/lib/hopper}"
WORK="${HOPPER_WORK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/hopper}"
TOKENS="${HOPPER_CLIENT_TOKEN_DIR:-$HOME/.config/hopper/clients}"
HOST_KEY_FILE="${HOPPER_HOST_KEY_FILE:-/etc/ssh/ssh_host_ed25519_key.pub}"
AUTHORIZED="$HOME/.ssh/authorized_keys"
PORT="${HOPPER_CLIENT_HOPPER_PORT:-22}"
SESSION="${HOPPER_CLIENT_SESSION:-hopper-client}"

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
# Attached before the rename (issue #112): its config dir (the tunnel key with it) moves, and its old units go.
remote '[ ! -d ~/.config/job-hopper-client ] || [ -e ~/.config/hopper-client ] || mv ~/.config/job-hopper-client ~/.config/hopper-client'
remote 'for u in job-hopper-client job-hopper-client-herdr; do [ ! -e ~/.config/systemd/user/$u.service ] || { systemctl --user disable --now $u; rm -f ~/.config/systemd/user/$u.service; }; done; rm -rf ~/.local/lib/job-hopper-client ~/.local/lib/job-hopper-client.prev ~/.local/lib/job-hopper-client.next'
remote 'mkdir -p ~/.local/lib/hopper-client ~/.config/systemd/user && install -d -m 700 ~/.config/hopper-client'
for f in $CLIENT_FILES; do
  remote "cat > ~/.local/lib/hopper-client/$f" < "$APP/src/client/$f"
done
remote '(umask 077; cat > ~/.config/hopper-client/token)' < "$TOKENS/$NAME.token"
printf 'hopper %s\n' "$HOST_KEY" | remote 'cat > ~/.config/hopper-client/known_hosts'
remote '[ -f ~/.config/hopper-client/tunnel_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C hopper-client -f ~/.config/hopper-client/tunnel_ed25519'
PUB="$(remote 'ssh-keygen -y -f ~/.config/hopper-client/tunnel_ed25519' | awk '{ print $1, $2 }')"
[[ "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || die "no client key on $TARGET"
remote '(umask 077; cat > ~/.config/hopper-client/client.env)' <<ENV
HOPPER_CLIENT_TOKEN_FILE=%h/.config/hopper-client/token
HOPPER_CLIENT_HERDR_BIN=$HERDR_BIN
HOPPER_CLIENT_SESSION=$SESSION
HOPPER_CLIENT_HOPPER=$HOPPER
HOPPER_CLIENT_HOPPER_PORT=$PORT
HOPPER_CLIENT_KEY_FILE=%h/.config/hopper-client/tunnel_ed25519
HOPPER_CLIENT_KNOWN_HOSTS=%h/.config/hopper-client/known_hosts
ENV
# systemd does not expand %h in an EnvironmentFile: write the home there.
remote 'sed -i "s|%h|$HOME|g" ~/.config/hopper-client/client.env'

step "let the client's key open its tunnel here, and nothing else"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && touch "$AUTHORIZED" && chmod 600 "$AUTHORIZED"
install -d -m 700 "$WORK" "$WORK/clients"
MARK="hopper-client:$NAME"
LINE="restrict,command=\"$NODE $APP/src/client/relay.ts $SOCK\" $PUB $MARK"
{ grep -v " $MARK\$" "$AUTHORIZED" || true; printf '%s\n' "$LINE"; } > "$AUTHORIZED.new"
chmod 600 "$AUTHORIZED.new" && mv "$AUTHORIZED.new" "$AUTHORIZED"

step "start the client and its herdr session ($SESSION) on $TARGET"
remote 'cat > ~/.config/systemd/user/hopper-client.service' < "$SRC/systemd/hopper-client.service"
sed -e "s/--session hopper /--session $SESSION /g" -e "s/^Description=.*/Description=hopper client's herdr session ($SESSION)/" "$SRC/systemd/hopper-herdr.service" \
  | remote 'cat > ~/.config/systemd/user/hopper-client-herdr.service'
remote 'systemctl --user daemon-reload && systemctl --user enable --now hopper-client-herdr && systemctl --user enable hopper-client && systemctl --user restart hopper-client' \
  || die "systemctl on $TARGET failed"

cat <<EOF2

Add to daemon.env on this machine (then restart the daemon), so it holds the client's token:
${TOKEN_ENV}_FILE=$TOKENS/$NAME.token

Attach it in the UI: Plugins → Machine sources, add a client instance named $NAME, then set its options:
  tokenEnv: $TOKEN_ENV
  lanes: $LANES
EOF2
