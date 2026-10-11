// The one update of a container install (issue #697, design.md "Self-update"): `hopper update <tool>`, run from the image
// to update to, prints this script; the person or the agent runs it in the folder that holds compose.yaml. It brings the
// stack to the compose file that image ships with — never the hopper service alone on an old compose file, which kept
// required services and settings from ever arriving. The update notice and the agent update skill give the same command.
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
const EOF = 'HOPPER_COMPOSE_EOF';

/** The command that makes the script from `image` (the update notice's first line). */
export const makeScriptCommand = (tool: ComposeTool, image: string): string =>
  `${RUNTIME[tool]} run --rm --pull=always ${image} hopper update ${tool} > ${UPDATE_SCRIPT_FILE}`;

const HEALTH = "fetch('http://127.0.0.1:'+(process.env.HOPPER_PORT||4790)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))";
const OPENFGA = "fetch((process.env.HOPPER_OPENFGA_URL||'http://openfga:8080')+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))";

/** The update script for `tool`, to `image`, which ships `shipped`. */
export function updateScript(o: { tool: ComposeTool; image: string; shipped: ShippedCompose }): string {
  if (!IMAGE_REF.test(o.image)) throw new Error(`not an image reference: ${o.image}`);
  if (o.shipped.compose.includes(EOF)) throw new Error(`the shipped compose.yaml holds ${EOF}`);
  const compose = o.shipped.compose.endsWith('\n') ? o.shipped.compose : `${o.shipped.compose}\n`;
  const version = o.shipped.branch && o.shipped.commit ? `${o.shipped.branch} ${o.shipped.commit.slice(0, 7)}` : 'unknown';
  const c = COMPOSE[o.tool];
  return `#!/bin/sh
# Update this hopper to ${version}, the image ${o.image}: made by \`hopper update ${o.tool}\` of that image
# (docs/deploy.md "Update"). Run it in the folder that holds compose.yaml and .env. In order, it: checks that .env has
# what the new compose file needs; backs up the database, compose.yaml and .env; pulls the image; moves the install's own
# settings from compose.yaml to .env; puts in the compose.yaml the image ships with; pulls and starts the whole stack; checks
# health. It stops at the first step that fails, and says how to go back.
set -eu
umask 077
image='${o.image}'
compose() { ${c} "$@"; }
runtime() { ${RUNTIME[o.tool]} "$@"; }
say() { printf 'hopper update: %s\\n' "$*"; }
fail() { say "$*" >&2; exit 1; }
has_env() { [ -f .env ] && grep -q "^$1=." .env; }

[ -f compose.yaml ] || fail "no compose.yaml here: run this in the folder that holds the hopper's compose.yaml"
stamp=$(date -u +%Y%m%dT%H%M%SZ)

say "1/7 check .env"
if ! has_env HOPPER_MASTER_KEY; then
  if status=$(compose exec -T hopper hopper master-key status 2>/dev/null); then
    if printf '%s' "$status" | grep -Eq '"source" *: *"(generated|old-token-key)"'; then
      fail "HOPPER_MASTER_KEY is not in .env, and the running hopper made its master key at this start: a recreate loses it. Open the UI, save the master key it shows, add HOPPER_MASTER_KEY=<the 64 hex digits> to .env (docs/deploy.md \\"The master key\\"), then run this again. Nothing changed."
    fi
  else
    say "note: the master key's status was not read (the hopper is stopped, or its image is older): if the UI showed a master key, stop now (Ctrl-C) and add HOPPER_MASTER_KEY to .env"
  fi
fi

say "2/7 back up"
compose exec -T postgres pg_dump -U hopper -d hopper -Fc > "hopper-backup-$stamp.dump" \\
  || fail "the database backup failed: start the stack (${c} up -d), then run this again. Nothing changed."
old=$(sed -n '1s/^${VERSION_STAMP} [^ ]* \\([0-9a-f]\\{7\\}\\).*/\\1/p' compose.yaml)
bak="compose.yaml.bak-\${old:-$stamp}"
[ ! -e "$bak" ] || bak="compose.yaml.bak-$stamp"
cp compose.yaml "$bak"
envbak=".env.bak-\${bak#compose.yaml.bak-}"
if [ -f .env ]; then cp -p .env "$envbak"; else : > .env; envbak=; fi
overbak=
overnew=
back() { fail "$1. To go back: cp $bak compose.yaml\${envbak:+ && cp $envbak .env}\${overbak:+ && cp $overbak compose.override.yaml}\${overnew:+ && rm compose.override.yaml} && ${c} up -d --force-recreate (the database backup is hopper-backup-$stamp.dump)"; }

say "3/7 pull $image"
if ! runtime pull "$image"; then
  runtime image inspect "$image" >/dev/null 2>&1 || fail "the pull of $image failed. Nothing changed but the backups."
  say "note: $image was not pulled; this computer's own copy is used (an image built here)"
fi

say "4/7 move the install's own settings from compose.yaml to .env and compose.override.yaml"
carried=$(runtime run --rm -i --network none "$image" hopper update carry < compose.yaml) || fail "the old compose.yaml was not read. Nothing changed but the backups."
[ ! -s .env ] || [ -z "$(tail -c1 .env)" ] || echo >> .env
printf '%s\\n' "$carried" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  key=\${line%%=*}
  if grep -q "^$key=" .env; then say "$key: .env has it already, kept"; else printf '%s\\n' "$line" >> .env; say "$key: moved to .env"; fi
done
{ grep -v '^HOPPER_IMAGE=' .env || true; printf 'HOPPER_IMAGE=%s\\n' "$image"; } > .env.next
cat .env.next > .env
rm -f .env.next
say "HOPPER_IMAGE=$image in .env"
if [ -f compose.override.yaml ]; then HOPPER_UPDATE_OVERRIDE=$(cat compose.override.yaml); export HOPPER_UPDATE_OVERRIDE; fi
override=$(runtime run --rm -i --network none -e HOPPER_UPDATE_OVERRIDE "$image" hopper update override < compose.yaml) \\
  || fail "the old compose.yaml or compose.override.yaml was not read. Nothing changed but the backups and .env."
unset HOPPER_UPDATE_OVERRIDE
if [ -n "$override" ]; then
  if [ -f compose.override.yaml ]; then overbak="compose.override.yaml.bak-\${bak#compose.yaml.bak-}"; cp -p compose.override.yaml "$overbak"; else overnew=1; fi
  printf '%s\\n' "$override" > compose.override.yaml.next
  diff -u "\${overbak:-/dev/null}" compose.override.yaml.next || true
  mv compose.override.yaml.next compose.override.yaml
  say "compose.override.yaml written\${overbak:+; the old one is $overbak}"
fi

say "5/7 put in the compose.yaml of ${version}; the old one is $bak"
cat > compose.yaml <<'${EOF}'
${compose}${EOF}
diff -u "$bak" compose.yaml || true

say "6/7 pull and start the whole stack"
compose pull || say "note: not every image of the stack was pulled (an image built here is not); the start uses this computer's copies"
compose up -d --force-recreate || back "the stack did not start"

say "7/7 check health"
tries=\${HOPPER_UPDATE_HEALTH_TRIES:-60}
check() { n=1; until compose exec -T hopper node -e "$1" >/dev/null 2>&1; do [ "$n" -lt "$tries" ] || return 1; n=$((n + 1)); sleep 3; done; }
check "${HEALTH}" || back "the hopper does not answer /api/health: see ${c} logs hopper"
check "${OPENFGA}" || back "OpenFGA does not answer: see ${c} logs openfga openfga-migrate"

say "done: the stack runs ${version} ($image), with every required service."
say "backups: hopper-backup-$stamp.dump, $bak\${envbak:+, $envbak}"
say "optional: remove the image it replaced: ${RUNTIME[o.tool]} image prune -f --filter label=org.opencontainers.image.title=hopper"
`;
}
