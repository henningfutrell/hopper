// The update notice (issue #44), from GET /api/update: its words, whether it shows, and when the
// page must reload because the daemon now runs another commit. What's new is plain-language
// bullets (issue #104): the words here never count commits.
import type { ClusterInstall, UpdateStatus } from '../../../src/domain/types.ts';

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
 * How the user updates a container install (issues #494, #697, #970, #1104): one command in the folder that holds compose.yaml
 * (src/update/update-commands.ts, its twin: the UI imports nothing of src/). It runs the update the selected channel's image
 * carries: the compose tool that started the stack, the master key given at launch or asked for, a backup, that image's
 * compose.yaml, the whole stack pulled and recreated — never the hopper's container alone —, and the result checked.
 */
export interface ImageUpdate {
  /** The selected channel's image: the update runs on it. */
  image: string;
  /** The command for each tool; then the optional prune of the replaced image. None for a cluster install. */
  commands: { tool: ContainerTool; command: string; prune: string }[];
  /** A cluster install's update (issue #1285): helm upgrade of its release to the target's pinned image; set in place of `commands`. */
  helm?: string;
  /** Set when the running image is another channel's than the selected one. */
  mismatch?: string;
  /** What a recreate would end now: the restart blockers, as the host updater waits on them. */
  blockers: string;
}

const cli = (tool: ContainerTool) => tool.toLowerCase();

/** The update, to `image`, with `tool`: one command (issue #1104). */
export const updateCommand = (tool: ContainerTool, image: string): string =>
  `${cli(tool)} run --rm --pull=always ${image} hopper update script | bash -s -- ${image}`;

/**
 * The update of a cluster install (issue #1285): helm upgrade of its release to `tag`, its other values kept
 * (src/update/cluster.ts, its twin).
 */
export const helmUpgradeCommand = (c: ClusterInstall, tag: string): string =>
  `helm upgrade ${c.release} ${c.chart}${c.namespace ? ` --namespace ${c.namespace}` : ''} --reuse-values --set image.tag=${tag}`;

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
  // A cluster install pins the target's own build (`sha-<commit>`): a channel tag does not change, so it would not roll out.
  const helm = s.cluster && s.target ? helmUpgradeCommand(s.cluster, `sha-${s.target.commit.slice(0, 7)}`) : undefined;
  return {
    image,
    ...(helm ? { helm } : {}),
    commands: s.cluster ? [] : CONTAINER_TOOLS.map((tool) => ({ tool, command: updateCommand(tool, image), prune: `${cli(tool)} ${PRUNE}` })),
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
      if (image) return `Update available: ${image.mismatch ?? (s.cluster ? `upgrade the Helm release to the ${imageTag(s)} image` : `pull the ${imageTag(s)} image and recreate the container`)}`;
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
