// The one update of a container install (issue #697, design.md "Self-update"): `hopper update <tool>`, run from the image
// to update to, prints this script; the person or the agent runs it in the folder that holds compose.yaml. It brings the
// stack to the compose file that image ships with — never the hopper service alone on an old compose file, which kept
// required services and settings from ever arriving. The update notice and the agent update skill give the same command.
// It stops the old stack and starts the new one (issue #894: podman-compose cannot force-recreate a service that has no
// container yet), and puts the old stack back when a step after the stop fails. It writes no .env and puts no secret in a file.
import type { ShippedCompose } from '../domain/types.ts';
import { VERSION_STAMP } from './shipped-compose.ts';

/** The compose tools the script speaks: Podman's `podman compose`, podman-compose itself, and Docker's `docker compose`. */
export const COMPOSE_TOOLS = ['podman', 'podman-compose', 'docker'] as const;
export type ComposeTool = (typeof COMPOSE_TOOLS)[number];
export const isComposeTool = (s: string): s is ComposeTool => (COMPOSE_TOOLS as readonly string[]).includes(s);

/** The published image, one tag per update channel (docs/deploy.md "Update channels and promotion"). */
export const PUBLISHED_IMAGE = 'ghcr.io/henningfutrell/hopper';
/** The file the update notice and the skill save the script as. */
export const UPDATE_SCRIPT_FILE = 'hopper-update.sh';
/** An image reference the script names in single quotes: nothing a shell reads. */
export const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

const RUNTIME: Record<ComposeTool, string> = { podman: 'podman', 'podman-compose': 'podman', docker: 'docker' };
const COMPOSE: Record<ComposeTool, string> = { podman: 'podman compose', 'podman-compose': 'podman-compose', docker: 'docker compose' };

/** The command that makes the script from `image` (the update notice's first line). */
export const makeScriptCommand = (tool: ComposeTool, image: string): string =>
  `${RUNTIME[tool]} run --rm --pull=always ${image} hopper update ${tool} > ${UPDATE_SCRIPT_FILE}`;

const HEALTH = "fetch('http://127.0.0.1:'+(process.env.HOPPER_PORT||4790)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))";
const OPENFGA = "fetch((process.env.HOPPER_OPENFGA_URL||'http://openfga:8080')+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))";

/** The update script for `tool`, to `image`, which ships `shipped`. */
export function updateScript(o: { tool: ComposeTool; image: string; shipped: ShippedCompose }): string {
  if (!IMAGE_REF.test(o.image)) throw new Error(`not an image reference: ${o.image}`);
  const version = o.shipped.branch && o.shipped.commit ? `${o.shipped.branch} ${o.shipped.commit.slice(0, 7)}` : 'unknown';
  const c = COMPOSE[o.tool];
  return `#!/bin/sh
# Update this hopper to ${version}, the image ${o.image}: made by \`hopper update ${o.tool}\` of that image
# (docs/deploy.md "Update"). Run it in the folder that holds compose.yaml. In order, it: reads the launch settings — the
# master key and the other secrets — from this shell, an old .env, or the running hopper, and stops when the running hopper
# made its master key at this start; backs up the database, compose.yaml, compose.override.yaml and an old .env; pulls the
# image; makes the new compose.yaml — the one the image ships with, the install's own settings as the defaults of its
# variables — and compose.override.yaml; pulls the stack's images; stops the old stack; puts the new files in, removes the old
# .env (issue #894: compose reads no .env, and no secret is put in a file), and starts the whole stack; checks health. When
# a step after the stop fails, it puts the old files back and starts the old stack again.
set -eu
umask 077
image='${o.image}'
compose() { ${c} "$@"; }
runtime() { ${RUNTIME[o.tool]} "$@"; }
say() { printf 'hopper update: %s\\n' "$*"; }
fail() { say "$*" >&2; exit 1; }
# A setting of the running hopper's container, when it runs.
running() { compose exec -T hopper printenv "$1" 2>/dev/null; }

[ -f compose.yaml ] || fail "no compose.yaml here: run this in the folder that holds the hopper's compose.yaml"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# The image is the one this script names: compose.yaml names it after the update.
unset HOPPER_IMAGE

say "1/8 read the launch settings"
if [ -f .env ]; then
  # An old install's .env (issue #894), read once to move it; this shell's own settings win, as they did in compose.
  while IFS= read -r line || [ -n "$line" ]; do
    line=\${line#export }
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    key=\${line%%=*}
    case "$key" in *[!A-Za-z0-9_]*|HOPPER_IMAGE) continue ;; esac
    if printenv "$key" >/dev/null; then continue; fi
    value=\${line#*=}
    case "$value" in \\"*\\") value=\${value#\\"}; value=\${value%\\"} ;; \\'*\\') value=\${value#\\'}; value=\${value%\\'} ;; esac
    export "$key=$value"
  done < .env
  say "the old .env read: its settings move to compose.yaml and compose.override.yaml, its secrets are given at launch"
fi
if [ -z "\${HOPPER_MASTER_KEY:-}" ] && key=$(running HOPPER_MASTER_KEY) && [ -n "$key" ]; then
  HOPPER_MASTER_KEY=$key; export HOPPER_MASTER_KEY; say "HOPPER_MASTER_KEY: taken from the running hopper"
fi
unset key
if [ -z "\${HOPPER_MASTER_KEY:-}" ]; then
  if status=$(compose exec -T hopper hopper master-key status 2>/dev/null); then
    if printf '%s' "$status" | grep -Eq '"source" *: *"(generated|old-token-key)"'; then
      fail "the running hopper made its master key at this start, and it is given nowhere: a recreate loses it. Open the UI, save the master key it shows, then run this again with it given: read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY && sh ${UPDATE_SCRIPT_FILE} (docs/deploy.md \\"The master key\\"). Nothing changed."
    fi
  else
    say "note: the master key's status was not read (the hopper is stopped, or its image is older): if the UI showed a master key, stop now (Ctrl-C) and run this again with HOPPER_MASTER_KEY given (docs/deploy.md \\"The master key\\")"
  fi
fi

say "2/8 back up"
compose exec -T postgres pg_dump -U hopper -d hopper -Fc > "hopper-backup-$stamp.dump" \\
  || fail "the database backup failed: start the stack (${c} up -d), then run this again. Nothing changed."
old=$(sed -n '1s/^${VERSION_STAMP} [^ ]* \\([0-9a-f]\\{7\\}\\).*/\\1/p' compose.yaml)
bak="compose.yaml.bak-\${old:-$stamp}"
[ ! -e "$bak" ] || bak="compose.yaml.bak-$stamp"
cp compose.yaml "$bak"
suffix=\${bak#compose.yaml.bak-}
envbak=
if [ -f .env ]; then envbak=".env.bak-$suffix"; cp -p .env "$envbak"; fi
overbak=
if [ -f compose.override.yaml ]; then overbak="compose.override.yaml.bak-$suffix"; cp -p compose.override.yaml "$overbak"; fi
clean() { rm -f compose.yaml.next compose.override.yaml.next; }

say "3/8 pull $image"
if ! runtime pull "$image"; then
  runtime image inspect "$image" >/dev/null 2>&1 || fail "the pull of $image failed. Nothing changed but the backups."
  say "note: $image was not pulled; this computer's own copy is used (an image built here)"
fi

say "4/8 make the compose.yaml of ${version}, with this install's own settings, and compose.override.yaml"
HOPPER_UPDATE_ENV=$(cat .env 2>/dev/null || true)
HOPPER_UPDATE_OVERRIDE=$(cat compose.override.yaml 2>/dev/null || true)
# The settings given at launch (this shell's), but secrets: they become compose.yaml's defaults, so they last.
HOPPER_UPDATE_LAUNCH=$(env | grep -E '^(HOPPER_[A-Za-z0-9_]*|COMPOSE_PROFILES)=' | grep -v -E '^(HOPPER_UPDATE_[A-Za-z0-9_]*|[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=' || true)
export HOPPER_UPDATE_ENV HOPPER_UPDATE_OVERRIDE HOPPER_UPDATE_LAUNCH
runtime run --rm -i --network none -e HOPPER_UPDATE_ENV -e HOPPER_UPDATE_LAUNCH "$image" hopper update carry --image "$image" < compose.yaml > compose.yaml.next \\
  || { clean; fail "the old compose.yaml or .env was not read. Nothing changed but the backups."; }
override=$(runtime run --rm -i --network none -e HOPPER_UPDATE_ENV -e HOPPER_UPDATE_LAUNCH -e HOPPER_UPDATE_OVERRIDE "$image" hopper update override --image "$image" < compose.yaml) \\
  || { clean; fail "the old compose.yaml or compose.override.yaml was not read. Nothing changed but the backups."; }
unset HOPPER_UPDATE_ENV HOPPER_UPDATE_OVERRIDE HOPPER_UPDATE_LAUNCH
[ -s compose.yaml.next ] || { clean; fail "the new compose.yaml is empty. Nothing changed but the backups."; }
diff -u "$bak" compose.yaml.next || true
if [ -n "$override" ]; then
  printf '%s\\n' "$override" > compose.override.yaml.next
  diff -u "\${overbak:-/dev/null}" compose.override.yaml.next || true
fi
# The secrets the new files name, given at launch: from this shell, else from the running hopper (issue #894).
for name in $(cat compose.yaml.next compose.override.yaml.next 2>/dev/null | sed -n 's/.*[^$]\\$[{]\\([A-Za-z0-9_]*\\):-}.*/\\1/p' | sort -u); do
  if printenv "$name" >/dev/null; then continue; fi
  if value=$(running "$name") && [ -n "$value" ]; then export "$name=$value"; say "$name: taken from the running hopper"; fi
done
unset value

say "5/8 pull the images of the whole stack"
next="-f compose.yaml.next"
if [ -f compose.override.yaml.next ]; then next="$next -f compose.override.yaml.next"; elif [ -f compose.override.yaml ]; then next="$next -f compose.override.yaml"; fi
# shellcheck disable=SC2086
compose $next pull || say "note: not every image of the stack was pulled (an image built here is not); the start uses this computer's copies"

say "6/8 stop the old stack"
# A box still on the hopper's network keeps the network: the start reuses it.
compose down || say "note: the stop did not remove everything (a box on the hopper's network keeps it); the start goes on"

# From here a failure puts the old files back and starts the old stack again.
back() {
  say "$1: the old stack is put back"
  compose down >/dev/null 2>&1 || true
  cp "$bak" compose.yaml
  if [ -n "$overbak" ]; then cp -p "$overbak" compose.override.yaml; else rm -f compose.override.yaml; fi
  if [ -n "$envbak" ]; then cp -p "$envbak" .env; fi
  if compose up -d; then fail "$1. The old stack runs again, on its old files. The database backup is hopper-backup-$stamp.dump."; fi
  fail "$1, and the old stack did not start again either: see ${c} logs. Its files are back in place; the database backup is hopper-backup-$stamp.dump."
}

say "7/8 put in the new files and start the whole stack"
mv compose.yaml.next compose.yaml
if [ -f compose.override.yaml.next ]; then mv compose.override.yaml.next compose.override.yaml; fi
rm -f .env
compose up -d || back "the stack did not start"

say "8/8 check health"
tries=\${HOPPER_UPDATE_HEALTH_TRIES:-60}
check() { n=1; until compose exec -T hopper node -e "$1" >/dev/null 2>&1; do [ "$n" -lt "$tries" ] || return 1; n=$((n + 1)); sleep 3; done; }
check "${HEALTH}" || back "the hopper does not answer /api/health (see ${c} logs hopper)"
check "${OPENFGA}" || back "OpenFGA does not answer (see ${c} logs openfga openfga-migrate)"

say "done: the stack runs ${version} ($image), with every required service."
say "backups: hopper-backup-$stamp.dump, $bak\${envbak:+, $envbak}\${overbak:+, $overbak}"
if [ -n "$envbak" ]; then
  say "the old .env is gone: compose reads none. Its backup $envbak holds the master key: save the key in a password manager, then delete the backup."
fi
say "from now on, give the master key at launch for each ${c} up that recreates the hopper: read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY. The next update takes it from the running hopper."
say "optional: remove the image it replaced: ${RUNTIME[o.tool]} image prune -f --filter label=org.opencontainers.image.title=hopper"
`;
}
