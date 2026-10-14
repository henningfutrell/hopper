// The update of a container install (issues #697, #970, #1104, design.md "Self-update"): one command, run in the folder
// that holds compose.yaml. It runs scripts/update.sh from the image to update to (`hopper update script`), which uses the
// compose tool and project that started the stack, refuses without the master key, backs up the database, puts in the
// image's compose.yaml (`hopper update carry`), pulls and recreates the whole stack — never the hopper service alone —, and
// checks the image, the health, the master key and the drift. No .env and no generated script. The update notice
// (ui/src/model/update.ts, its own copy: the UI imports nothing of src/) and the agent update skill give the same command.

/** The compose tools a container install runs with: Podman's `podman compose`, podman-compose itself, and Docker's `docker compose`. */
export const COMPOSE_TOOLS = ['podman', 'podman-compose', 'docker'] as const;
export type ComposeTool = (typeof COMPOSE_TOOLS)[number];

/** The container runtimes the update command is given for: the update finds the compose tool itself. */
export const RUNTIMES = ['podman', 'docker'] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** The published image, one tag per update channel (docs/deploy.md "Update channels and promotion"). */
export const PUBLISHED_IMAGE = 'ghcr.io/henningfutrell/hopper';
/** An image reference: nothing a shell reads. */
export const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/** The runtime of a compose tool: podman-compose runs on Podman. */
export const runtimeOf = (tool: ComposeTool): Runtime => (tool === 'docker' ? 'docker' : 'podman');

/** The update, to `image`, with `runtime`: one command in the folder that holds compose.yaml (issue #1104). */
export const updateCommand = (runtime: Runtime, image: string): string =>
  `${runtime} run --rm --pull=always ${image} hopper update script | bash -s -- ${image}`;

/** Optional, after the update: remove the image it replaced. */
export const pruneCommand = (runtime: Runtime): string => `${runtime} image prune -f --filter label=org.opencontainers.image.title=hopper`;
