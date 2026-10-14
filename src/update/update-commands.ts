// The update of a container install (issues #697, #970, design.md "Self-update"): plain compose commands, run in the
// folder that holds compose.yaml. No generated script and no .env: back up the database; make the new compose.yaml from
// the image to update to (`hopper update carry`, the install's settings as its variables' defaults), read the change, put
// it in; then pull and start the whole stack — never the hopper service alone — with the master key given at launch. The
// last command refuses before compose runs when HOPPER_MASTER_KEY is not given: a recreate without it starts the hopper
// limited. The update notice (ui/src/model/update.ts, its own copy: the UI imports nothing of src/) and the agent update
// skill give the same commands.

/** The compose tools the commands are given for: Podman's `podman compose`, podman-compose itself, and Docker's `docker compose`. */
export const COMPOSE_TOOLS = ['podman', 'podman-compose', 'docker'] as const;
export type ComposeTool = (typeof COMPOSE_TOOLS)[number];

/** The published image, one tag per update channel (docs/deploy.md "Update channels and promotion"). */
export const PUBLISHED_IMAGE = 'ghcr.io/henningfutrell/hopper';
/** An image reference: nothing a shell reads. */
export const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

const RUNTIME: Record<ComposeTool, string> = { podman: 'podman', 'podman-compose': 'podman', docker: 'docker' };
const COMPOSE: Record<ComposeTool, string> = { podman: 'podman compose', 'podman-compose': 'podman-compose', docker: 'docker compose' };

/** Give the master key at launch, from the password manager: nothing is shown, nothing is written to a file. */
export const GIVE_MASTER_KEY = 'read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY';
/** Stops the command line when the master key is not given (sh, bash and zsh): compose never runs without it. */
export const REQUIRE_MASTER_KEY = `: "\${HOPPER_MASTER_KEY:?is not given: the update stops. Give it first: ${GIVE_MASTER_KEY}}"`;
/**
 * `podman compose` runs docker-compose when it finds it, and docker-compose sees no stack while Podman's socket is off
 * (issue #924), nor one podman-compose started (issue #1063): then podman-compose is the provider.
 */
export const PODMAN_PROVIDER_HINT = 'export PODMAN_COMPOSE_PROVIDER=podman-compose';

/**
 * Stops the command line when a hopper stack runs but `compose` sees none of it (issue #1063): `podman compose` runs
 * docker-compose when it finds it, and docker-compose does not see a stack podman-compose started, nor podman-compose one
 * docker-compose started. Its `up` would make a second stack on the same named volumes, a second Postgres on the live data.
 * Both tools label their containers with the project (`com.docker.compose.project`); `ps -q` of the tool lists the ones it
 * sees (only container ids count: an older podman-compose writes other lines there too).
 */
export function composeCheck(runtime: string, compose: string, hint = ''): string {
  return `[ -z "$(${runtime} ps -q --filter label=com.docker.compose.project=hopper)" ] || ${compose} ps -q 2>/dev/null | grep -Eq '^[0-9a-f]{12,}$' || { echo 'hopper: ${compose} does not see the hopper stack that runs. It would start a second stack on the same data: the update stops. Use the compose tool that started the stack.${hint}' >&2; false; }`;
}

/** The update's commands, in order, for `tool`, to `image`. */
export interface UpdateCommands {
  /** Give the master key at launch. */
  give: string;
  /** Stop when the compose tool does not see the stack that runs (issue #1063). */
  check: string;
  /** Back up the database. */
  backup: string;
  /** Make the new compose.yaml from the image: compose.yaml.next. */
  carry: string;
  /** Show the change. */
  diff: string;
  /** Keep the old compose.yaml as compose.yaml.bak, put the new one in. */
  swap: string;
  /** Refuse without the master key; else pull and start the whole stack on the image. */
  up: string;
  /** Optional: remove the image the update replaced. */
  prune: string;
}

export function updateCommands(tool: ComposeTool, image: string): UpdateCommands {
  const r = RUNTIME[tool];
  const c = COMPOSE[tool];
  const check = composeCheck(r, c, tool === 'podman' ? ` When podman-compose started it: ${PODMAN_PROVIDER_HINT}` : '');
  return {
    give: GIVE_MASTER_KEY,
    check,
    backup: `${c} exec -T postgres pg_dump -U hopper -d hopper -Fc > hopper-backup.dump`,
    carry: `${r} run --rm -i --pull=always ${image} hopper update carry --image ${image} < compose.yaml > compose.yaml.next`,
    diff: 'diff -u compose.yaml compose.yaml.next',
    swap: 'cp compose.yaml compose.yaml.bak && mv compose.yaml.next compose.yaml',
    up: `${REQUIRE_MASTER_KEY} && ${check} && HOPPER_IMAGE=${image} ${c} pull && HOPPER_IMAGE=${image} ${c} up -d`,
    prune: `${r} image prune -f --filter label=org.opencontainers.image.title=hopper`,
  };
}

/** The commands as lines to run, in order: what the drift fix and the log line give. */
export const updateLines = (u: UpdateCommands): string[] => [u.give, u.check, u.backup, u.carry, u.diff, u.swap, u.up];
