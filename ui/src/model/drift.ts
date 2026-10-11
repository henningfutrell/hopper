// A stack drifted from the compose file of its version (issue #697), pure: the fix — the update script made from the image
// the hopper runs, for one container tool — and whether OpenFGA is one of the gaps, so its own banner (#696) gives way.
import type { StackDrift } from './wire.ts';
import type { ContainerTool } from './update.ts';

/** The file the update script is saved as (src/update/update-script.ts UPDATE_SCRIPT_FILE). */
const SCRIPT = 'hopper-update.sh';

/** Make the update script from `image`, then run it: in the folder that holds compose.yaml. */
export function driftFix(image: string, tool: ContainerTool): [string, string] {
  const cli = tool.toLowerCase();
  return [`${cli} run --rm --pull=always ${image} hopper update ${cli} > ${SCRIPT}`, `sh ${SCRIPT}`];
}

/** Whether a drift names a missing OpenFGA: then the drift banner says it once, with the fix for the whole stack. */
export const driftNamesOpenFga = (d: StackDrift | null): boolean => !!d?.gaps.some((g) => g.kind === 'service' && g.name === 'openfga');

/** A body GET /api/update/drift answered, when it is a drift; null otherwise (a daemon from before it answers no such route). */
export const asDrift = (body: unknown): StackDrift | null =>
  body && typeof body === 'object' && Array.isArray((body as { gaps?: unknown }).gaps) ? (body as StackDrift) : null;
