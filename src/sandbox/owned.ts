// What the hopper may stop or remove (issue #1371, design.md "Sandboxes are fresh and leave nothing"): only a resource
// that carries a sandbox label — a sandbox box's (BOX_LABEL), a need box's (NEED_LABEL), a check box's (CHECK_LABEL) or a playground sandbox's (PLAYGROUND_LABEL, issue #1410),
// each a container and its home volume; on Kubernetes the runtime's pod label on its pods and claims. A hopper stack
// container, a volume of someone else's, the hopper's own pod: none carries one, so a stop or remove of it is refused.
// The adapters check before each stop and remove, whoever asks: a wrong id in a caller never reaches the stack.
// A home whose remove failed, or one a hopper that stopped left with no box, the sweeps remove (sweepHomes).
import type { ContainerRuntime } from '../domain/sandboxes.ts';

/** The label on every box an older build launched (issue #1349: none is launched now): its value is the hopper's instance id. */
export const BOX_LABEL = 'io.hopper.box';
/** The label naming the user whose box it is. */
export const USER_LABEL = 'io.hopper.user';
/** The label on every need box: its value is the hopper's instance id. The step removes it; the sweep burns one it left. */
export const NEED_LABEL = 'io.hopper.need';
/** The label on every check box: its value is the hopper's instance id. */
export const CHECK_LABEL = 'io.hopper.check';
/** The label on every playground sandbox (issue #1410): its value is the hopper's instance id. */
export const PLAYGROUND_LABEL = 'io.hopper.playground';

const SANDBOX_LABELS = [BOX_LABEL, NEED_LABEL, CHECK_LABEL, PLAYGROUND_LABEL] as const;

/** Whether these labels make a container or volume a sandbox's. */
export const sandboxLabelled = (labels: Record<string, string> | null | undefined): boolean =>
  SANDBOX_LABELS.some((k) => typeof labels?.[k] === 'string');

/** The refusal of a stop or remove of a resource with no sandbox label. */
export const notASandbox = (what: string): Error => new Error(`the hopper leaves the ${what}: it carries no sandbox label`);

/**
 * A home volume of the box's name that is there already (issue #1371): an earlier box's, or someone else's. A sandbox
 * starts only on a home it made, so nothing of an earlier step reaches it; the volume is left as it is.
 */
export const staleHome = (volume: string): Error => new Error(`its home volume ${volume} is there already: a sandbox starts only on a fresh home`);

/** A box's home volume is named for its box: `<box name>-home`. */
const HOME_SUFFIX = '-home';

/**
 * Removes each home volume with these labels whose box is not in `held` (issue #1371): a home whose remove failed, or one
 * a hopper that stopped mid-step left. On a client target too: its client lists the volumes (issue #1371).
 */
export async function sweepHomes(runtime: ContainerRuntime, labels: Record<string, string>, held: ReadonlySet<string>): Promise<void> {
  for (const name of await runtime.listVolumes(labels)) {
    if (!name.endsWith(HOME_SUFFIX) || held.has(name.slice(0, -HOME_SUFFIX.length))) continue;
    await runtime.removeVolume(name).catch(() => {});
  }
}
