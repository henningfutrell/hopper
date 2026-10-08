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

/** How the user updates a container install (issue #494): run from the folder that holds compose.yaml, with `env` in `.env` beside it. */
export interface ImageUpdate {
  /** The `.env` line that names the selected channel's tag. */
  env: string;
  /** Pull, then recreate the hopper's container alone (never Postgres, never a volume); then the optional prune of the replaced image. */
  commands: { tool: 'Podman' | 'Docker'; update: string; prune: string }[];
  /** Set when the running image is another channel's than the selected one. */
  mismatch?: string;
  /** What a recreate would end now: the restart blockers, as the host updater waits on them. */
  blockers: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The update of an image install with an update available; none otherwise. An image is never updated in place (issues #51, #409). */
export function imageUpdate(s: UpdateStatus): ImageUpdate | undefined {
  if (s.state !== 'available' || s.installed?.kind !== 'image') return undefined;
  const n = s.restartBlockers;
  return {
    env: `HOPPER_IMAGE=${IMAGE}:${s.channel}`,
    // --force-recreate: podman-compose keeps the old container on a newly pulled image without it.
    commands: (['podman', 'docker'] as const).map((cli) => ({
      tool: cli === 'podman' ? 'Podman' : 'Docker',
      update: `${cli} compose pull hopper && ${cli} compose up -d --force-recreate --no-deps hopper`,
      prune: `${cli} ${PRUNE}`,
    })),
    mismatch: s.installed.branch !== s.channel ? `this container runs the ${s.installed.branch} image; the selected channel is ${s.channel}: switch the image tag` : undefined,
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
      if (image) return `Update available: ${image.mismatch ?? `pull the ${s.channel} image and recreate the container`}`;
      // Installed from another channel's branch: applying moves to this channel (issue #282).
      return s.installed && s.installed.branch !== s.channel ? `Update available: move to the ${s.channel} channel` : 'Update available';
    }
    case 'applying': return `Updating: ${s.apply?.detail ?? 'starting'}`;
    case 'error': return `Update problem: ${s.reason ?? 'unknown'}`;
    case 'unavailable': return `Self-update unavailable: ${s.reason ?? 'unknown'}`;
    default: return 'Up to date';
  }
}

export const showNotice = (s: UpdateStatus | null): boolean => s !== null && (s.state === 'available' || s.state === 'applying' || s.state === 'error');

export const reloadNeeded = (loadedCommit: string | undefined, s: UpdateStatus): boolean =>
  loadedCommit !== undefined && s.installed !== undefined && s.installed.commit !== loadedCommit;
