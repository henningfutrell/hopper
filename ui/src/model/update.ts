// The update notice (issue #44), from GET /api/update: its words, whether it shows, and when the
// page must reload because the daemon now runs another commit. What's new is plain-language
// bullets (issue #104): the words here never count commits.
import type { UpdateStatus } from '../../../src/domain/types.ts';

/** The update channels, least stable first, and what each one pulls (issues #282, #423). */
export const CHANNELS: { channel: UpdateStatus['channel']; hint: string }[] = [
  { channel: 'dev', hint: 'Every change as soon as it is merged: newest first, and the first to break.' },
  { channel: 'beta', hint: 'Changes once they have run on dev: a preview of the next stable version.' },
  { channel: 'stable', hint: 'Changes once they have run on beta: the stable version.' },
];

/** The published image: one tag per channel, `latest` following `stable` (issue #423; docs/deploy.md "In containers, with Podman"). */
export const IMAGE = 'ghcr.io/henningfutrell/hopper';
const PRUNE = 'image prune -f --filter label=org.opencontainers.image.title=hopper';

/** The container tools a container install's commands are given for (issue #494). */
export const CONTAINER_TOOLS = ['Podman', 'Docker'] as const;
export type ContainerTool = (typeof CONTAINER_TOOLS)[number];

/** The container tool a browser remembers (issue #521): Podman, the one the docs lead with, until Docker is chosen. */
export const parseContainerTool = (text: string | null): ContainerTool => (text === 'Docker' ? 'Docker' : 'Podman');

/**
 * How the user updates a container install (issues #494, #697, #970): plain compose commands in the folder that holds
 * compose.yaml (src/update/update-commands.ts, its twin: the UI imports nothing of src/). The selected channel's image makes
 * the new compose.yaml (`hopper update carry`); the whole stack is pulled and started on it — never the hopper's container
 * alone —, and the last command stops before compose runs when the master key is not given at launch.
 */
export interface ImageUpdate {
  /** The selected channel's image: the commands give it as HOPPER_IMAGE. */
  image: string;
  /** The commands for each tool, in order; then the optional prune of the replaced image. */
  commands: ({ tool: ContainerTool } & UpdateCommands)[];
  /** Set when the running image is another channel's than the selected one. */
  mismatch?: string;
  /** What a recreate would end now: the restart blockers, as the host updater waits on them. */
  blockers: string;
}

export interface UpdateCommands {
  give: string;
  check: string;
  backup: string;
  carry: string;
  diff: string;
  swap: string;
  up: string;
  prune: string;
}

/** Give the master key at launch: nothing is shown, nothing is written to a file. */
export const GIVE_MASTER_KEY = 'read -rs HOPPER_MASTER_KEY && export HOPPER_MASTER_KEY';
/** Stops the command line when the master key is not given: compose never runs without it. */
const REQUIRE_MASTER_KEY = `: "\${HOPPER_MASTER_KEY:?is not given: the update stops. Give it first: ${GIVE_MASTER_KEY}}"`;
/** For `podman compose` when the stack answers to podman-compose (issues #924, #1063). */
export const PODMAN_PROVIDER_HINT = 'export PODMAN_COMPOSE_PROVIDER=podman-compose';
/** Stops the command line when a hopper stack runs but `compose` sees none of it: its `up` would make a second stack on the same volumes (issue #1063). */
const composeCheck = (runtime: string, compose: string, hint: string) =>
  `[ -z "$(${runtime} ps -q --filter label=com.docker.compose.project=hopper)" ] || ${compose} ps -q 2>/dev/null | grep -Eq '^[0-9a-f]{12,}$' || { echo 'hopper: ${compose} does not see the hopper stack that runs. It would start a second stack on the same data: the update stops. Use the compose tool that started the stack.${hint}' >&2; false; }`;

const cli = (tool: ContainerTool) => tool.toLowerCase();

/** The update's commands for `tool`, to `image`, in order. */
export function updateCommands(tool: ContainerTool, image: string): UpdateCommands {
  const r = cli(tool);
  const c = `${r} compose`;
  const check = composeCheck(r, c, tool === 'Podman' ? ` When podman-compose started it: ${PODMAN_PROVIDER_HINT}` : '');
  return {
    give: GIVE_MASTER_KEY,
    check,
    backup: `${c} exec -T postgres pg_dump -U hopper -d hopper -Fc > hopper-backup.dump`,
    carry: `${r} run --rm -i --pull=always ${image} hopper update carry --image ${image} < compose.yaml > compose.yaml.next`,
    diff: 'diff -u compose.yaml compose.yaml.next',
    swap: 'cp compose.yaml compose.yaml.bak && mv compose.yaml.next compose.yaml',
    up: `${REQUIRE_MASTER_KEY} && ${check} && HOPPER_IMAGE=${image} ${c} pull && HOPPER_IMAGE=${image} ${c} up -d`,
    prune: `${r} ${PRUNE}`,
  };
}

/** The commands as lines to run, in order (the prune aside). */
export const updateLines = (u: UpdateCommands): string[] => [u.give, u.check, u.backup, u.carry, u.diff, u.swap, u.up];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The channel the running build came from, when it is not the selected one (issue #497): the branch in `install.json`
 * against the selected channel. A branch older than the channel names (issue #423) is no channel, so never a mismatch.
 */
function channelMismatch(s: UpdateStatus): { running: UpdateStatus['channel']; selected: UpdateStatus['channel'] } | undefined {
  const running = CHANNELS.find((c) => c.channel === s.installed?.branch)?.channel;
  return running && running !== s.channel ? { running, selected: s.channel } : undefined;
}

/** The running build and the selected channel, in the words the update notice and the header badge share (issues #494, #497). */
const runsWords = (s: UpdateStatus, m: NonNullable<ReturnType<typeof channelMismatch>>) =>
  `runs the ${m.running} ${s.installed?.kind === 'image' ? 'image' : 'build'}; the selected channel is ${m.selected}`;

/** The header version badge's channel (issue #497): a tag on dev and beta, none on stable; both channels, marked, when the running build is another channel's. `label` names it for the badge's title and aria-label. */
export function channelBadge(s: UpdateStatus): { tag?: string; mismatch: boolean; label: string } {
  const m = channelMismatch(s);
  if (m) return { tag: `${m.running} → ${m.selected}`, mismatch: true, label: runsWords(s, m) };
  return { tag: s.channel === 'stable' ? undefined : s.channel, mismatch: false, label: `${s.channel} channel` };
}

/** The image tag an update pulls: the channel's, or the candidate's for a stable install in the canary subset (issue #1073 part 5). */
const imageTag = (s: UpdateStatus): string => (s.target?.ref === 'canary' ? 'canary' : s.channel);

/** The update of an image install with an update available; none otherwise. An image is never updated in place (issues #51, #409). */
export function imageUpdate(s: UpdateStatus): ImageUpdate | undefined {
  if (s.state !== 'available' || s.installed?.kind !== 'image') return undefined;
  const n = s.restartBlockers;
  const mismatch = channelMismatch(s);
  const image = `${IMAGE}:${imageTag(s)}`;
  return {
    image,
    commands: CONTAINER_TOOLS.map((tool) => ({ tool, ...updateCommands(tool, image) })),
    mismatch: mismatch && `this container ${runsWords(s, mismatch)}: switch the image tag`,
    blockers: n > 0
      ? `${plural(n, 'running job', 'running jobs')} would be lost by recreating the container: wait until none runs.`
      : 'No running job would be lost: jobs that reattach keep running across the recreate.',
  };
}

export function headline(s: UpdateStatus): string {
  switch (s.state) {
    case 'available': {
      // An image is updated by its user pulling the channel's tag, never in place (issues #409, #494).
      const image = imageUpdate(s);
      if (image) return `Update available: ${image.mismatch ?? `pull the ${imageTag(s)} image and recreate the container`}`;
      // Installed from another channel's branch: applying moves to this channel (issue #282).
      return s.installed && s.installed.branch !== s.channel ? `Update available: move to the ${s.channel} channel` : 'Update available';
    }
    // Not the merge of a pull request whose checks passed (issue #652): not offered, and why.
    case 'held': return `Update held: ${s.reason ?? 'unknown'}`;
    case 'applying': return `Updating: ${s.apply?.detail ?? 'starting'}`;
    case 'error': return `Update problem: ${s.reason ?? 'unknown'}`;
    case 'unavailable': return `Self-update unavailable: ${s.reason ?? 'unknown'}`;
    default: return 'Up to date';
  }
}

export const showNotice = (s: UpdateStatus | null): boolean => s !== null && (s.state === 'available' || s.state === 'held' || s.state === 'applying' || s.state === 'error');

/**
 * The commit the notice is about (issue #652): the channel and the short commit, and for an offered update the pull
 * request it is the merge of, whose checks passed. None with no update or held one.
 */
export function targetLine(s: UpdateStatus): string | undefined {
  if ((s.state !== 'available' && s.state !== 'held') || !s.target) return undefined;
  const commit = `${s.target.ref} ${s.target.commit.slice(0, 7)}`;
  return s.target.pullRequest ? `${commit} · pull request #${s.target.pullRequest.number}, checks passed` : commit;
}

export const reloadNeeded = (loadedCommit: string | undefined, s: UpdateStatus): boolean =>
  loadedCommit !== undefined && s.installed !== undefined && s.installed.commit !== loadedCommit;
