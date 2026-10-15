#!/usr/bin/env bash
# The master key sealed to this host (issue #1296, docs/deploy.md "The master key sealed to the host"): a restart, an
# update or a recreate needs no key from a person, and no file holds the key in plaintext. Every image carries this file.
# Save it beside compose.yaml, then run it in that folder:
#
#   podman run --rm <image> hopper master-key script > master-key.sh
#   bash master-key.sh seal              seal the key to this host: from HOPPER_MASTER_KEY, else asked on the terminal
#   bash master-key.sh run <command>...  unseal it, and run the command with it as HOPPER_MASTER_KEY, for that process
#                                        only: bash master-key.sh run podman compose up -d --force-recreate
#   bash master-key.sh rotate            rotate the key of the running hopper, and seal the new key in the same step
#   bash master-key.sh status            how the key is sealed here, and whether it unseals; never the key
#   bash master-key.sh unseal            write the key to a pipe, never to a terminal (the update reads it so)
#   bash master-key.sh method            write how the key is sealed: systemd-creds or kek
#
# How it is sealed, in this order (HOPPER_KEY_SEAL=systemd-creds or kek picks one):
#   systemd-creds  `systemd-creds --user encrypt` (as root: without --user): under the host's TPM2 when it has one, else
#                  under the host's own credential key. The sealed key: hopper-master-key.cred, here.
#   kek            a key-encryption key of this host, made once, mode 600, in
#                  ${XDG_CONFIG_HOME:-~/.config}/hopper/master-key.kek: never in this folder, never in a volume. The
#                  sealed key: hopper-master-key.enc, here (openssl, AES-256-CBC, PBKDF2).
# Neither file opens on another host. Keep the key in a password manager too: a new host, a new TPM or a lost key-
# encryption key opens neither, and then only the key itself brings the secrets back.
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.
set -euo pipefail

CRED=hopper-master-key.cred
ENC=hopper-master-key.enc
NAME=hopper-master-key

main() {
  local command="${1:-}"
  [ $# -eq 0 ] || shift
  case "$command" in
    seal) local key; key="$(given_key)"; seal "$key" ;;
    run) run "$@" ;;
    rotate) rotate ;;
    status) status ;;
    unseal) [ ! -t 1 ] || fail 'unseal writes the key: give it a pipe, not a terminal (KEY="$(bash master-key.sh unseal)")'; unseal ;;
    method) method ;;
    *) fail 'usage: bash master-key.sh seal | run <command>... | rotate | status | unseal | method' ;;
  esac
}

kek_file() { printf '%s/hopper/master-key.kek' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

# systemd-creds as this user can: --user unless root.
creds() {
  if [ "$(id -u)" = 0 ]; then systemd-creds "$@"; else systemd-creds --user "$@"; fi
}

# The method this host seals with now: HOPPER_KEY_SEAL, else systemd-creds when it seals here, else kek.
seal_method() {
  case "${HOPPER_KEY_SEAL:-}" in
    systemd-creds | kek) printf '%s' "$HOPPER_KEY_SEAL"; return ;;
    '') ;;
    *) fail "HOPPER_KEY_SEAL=$HOPPER_KEY_SEAL: systemd-creds or kek" ;;
  esac
  if command -v systemd-creds >/dev/null && printf 'x' | creds encrypt --name="$NAME-probe" - - >/dev/null 2>&1; then
    printf systemd-creds
  else
    printf kek
  fi
}

# How the key is sealed here: by the file this folder holds.
method() {
  if [ -f "$CRED" ]; then printf 'systemd-creds\n'
  elif [ -f "$ENC" ]; then printf 'kek\n'
  else fail "no sealed master key here ($CRED or $ENC): seal it first: bash master-key.sh seal"
  fi
}

# The key a person gives: HOPPER_MASTER_KEY, else asked on the terminal (nothing is shown).
given_key() {
  local key="${HOPPER_MASTER_KEY:-}"
  if [ -z "$key" ]; then
    local tty="${HOPPER_KEY_TTY:-/dev/tty}"
    { : <"$tty"; } 2>/dev/null || fail 'no master key: give it as HOPPER_MASTER_KEY, or run this in a terminal'
    printf 'master-key: paste the master key from your password manager (nothing is shown): ' >&2
    IFS= read -rs key <"$tty" || true
    printf '\n' >&2
  fi
  check_key "$key"
  printf '%s' "$key"
}

check_key() {
  [[ "$1" =~ ^[0-9a-fA-F]{64}$ || "$1" =~ ^[A-Za-z0-9+/_-]{43}=?$ ]] \
    || fail 'that is no master key: 32 bytes, as 64 hex digits or base64. Nothing changed'
}

# Seals the key to this host. The key goes to the sealing tool on its stdin, never as an argument. The sealed file is written next to its place and then moved there: a seal that fails leaves the old one as it was.
seal() {
  local key=$1 how; how="$(seal_method)"
  local out=$CRED other=$ENC
  [ "$how" = systemd-creds ] || { out=$ENC; other=$CRED; }
  (
    umask 077
    if [ "$how" = systemd-creds ]; then
      printf '%s' "$key" | creds encrypt --name="$NAME" - "$out.next" >/dev/null
    else
      local kek; kek="$(kek_file)"
      if [ ! -s "$kek" ]; then
        mkdir -p "$(dirname "$kek")"
        openssl rand -hex 32 >"$kek.next"
        mv "$kek.next" "$kek"
        say "made the key-encryption key of this host: $kek (mode 600). Keep it on this host only"
      fi
      printf '%s' "$key" | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -a -pass "file:$kek" -out "$out.next"
    fi
  ) || { rm -f "$out.next"; fail "the seal with $how failed (above): nothing changed"; }
  local back; back="$(unseal_from "$how" "$out.next")" || { rm -f "$out.next"; fail "the key sealed with $how does not unseal: nothing changed"; }
  [ "$back" = "$key" ] || { rm -f "$out.next"; fail "the key sealed with $how unseals to another value: nothing changed"; }
  mv "$out.next" "$out"
  rm -f "$other"
  say "sealed the master key to this host with $how: $out. Start the stack with it: bash master-key.sh run podman compose up -d --force-recreate"
}

unseal_from() {
  local how=$1 file=$2
  if [ "$how" = systemd-creds ]; then
    creds decrypt --name="$NAME" "$file" -
  else
    local kek; kek="$(kek_file)"
    [ -s "$kek" ] || { say "the key-encryption key of this host is not there: $kek"; return 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -a -pass "file:$kek" -in "$file"
  fi
}

# The key, unsealed and checked, to stdout.
unseal() {
  local how file key
  how="$(method)"
  file=$CRED; [ "$how" = systemd-creds ] || file=$ENC
  key="$(unseal_from "$how" "$file" 2>/dev/null)" || fail "the master key sealed here ($file, $how) does not unseal on this host. Seal it again from your password manager: bash master-key.sh seal"
  [[ "$key" =~ ^[0-9a-fA-F]{64}$ || "$key" =~ ^[A-Za-z0-9+/_-]{43}=?$ ]] || fail "$file unseals to no master key. Seal it again from your password manager: bash master-key.sh seal"
  printf '%s' "$key"
}

# The command, with the key as HOPPER_MASTER_KEY in its environment only, and how it was sealed as
# HOPPER_MASTER_KEY_SEALED (the hopper then rotates only with the host, which seals the new key).
run() {
  [ $# -gt 0 ] || fail 'usage: bash master-key.sh run <command>... (for example: podman compose up -d --force-recreate)'
  local key how
  how="$(method)"
  key="$(unseal)"
  HOPPER_MASTER_KEY="$key" HOPPER_MASTER_KEY_SEALED="$how" exec "$@"
}

status() {
  local how
  how="$(method)"
  if unseal >/dev/null; then
    say "sealed with $how, and it unseals on this host"
  else
    exit 1
  fi
}

# The hopper container of the stack: podman's, else docker's.
hopper_container() {
  local r id
  for r in podman docker; do
    command -v "$r" >/dev/null || continue
    id="$("$r" ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=hopper 2>/dev/null | head -n 1 || true)"
    [ -z "$id" ] || { printf '%s %s' "$r" "$id"; return; }
  done
  fail 'no hopper container runs: start the stack first (bash master-key.sh run podman compose up -d)'
}

# The rotation and the seal of the new key, in one step. The hopper seals every secret again under the new key, then this
# seals the new key to the host before it says anything. Should the seal fail, the new key is written to the terminal
# once, the one way left to keep it.
rotate() {
  local how
  how="$(method)"
  local runtime id
  read -r runtime id <<<"$(hopper_container)"
  local answer
  answer="$("$runtime" exec "$id" hopper master-key rotate --host-seals </dev/null)" || fail "the rotation was refused (above): nothing changed"
  local key; key="$(printf '%s' "$answer" | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p' | head -n 1)"
  local fingerprint; fingerprint="$(printf '%s' "$answer" | sed -n 's/.*"fingerprint": *"\([0-9a-f]*\)".*/\1/p' | head -n 1)"
  [ -n "$key" ] || fail 'the rotation answered no key: see hopper master-key status'
  if ! (HOPPER_KEY_SEAL="$how" seal "$key"); then
    if [ -t 2 ]; then
      say "the new key did not seal. The running hopper is on it: save it in your password manager now, then seal it (bash master-key.sh seal): $key"
    fi
    fail 'the new key did not seal; the hopper runs on it. Without a terminal it is not shown: see docs/deploy.md "The master key sealed to the host"'
  fi
  say "rotated: the hopper and this host now hold the new key (fingerprint $fingerprint). Recreate the hopper with it now, so a restart of its container does not start on the old key: bash master-key.sh run podman compose up -d --force-recreate --no-deps hopper"
}

say() { printf 'master-key: %s\n' "$*" >&2; }
fail() { say "$*"; exit 1; }

main "$@"
