// A stack drifted from the compose file of its version (issue #697), pure: the fix — the update's compose commands with the
// image the hopper runs, for one container tool (issue #970) — and whether OpenFGA is one of the gaps, so its own banner (#696) gives way.
import type { StackDrift } from './wire.ts';
import { updateCommands, updateLines, type ContainerTool } from './update.ts';

/** The update's commands with `image`, in order: in the folder that holds compose.yaml. */
export const driftFix = (image: string, tool: ContainerTool): string[] => updateLines(updateCommands(tool, image));

/** Whether a drift names a missing OpenFGA: then the drift banner says it once, with the fix for the whole stack. */
export const driftNamesOpenFga = (d: StackDrift | null): boolean => !!d?.gaps.some((g) => g.kind === 'service' && g.name === 'openfga');

/** A body GET /api/update/drift answered, when it is a drift; null otherwise (a daemon from before it answers no such route). */
export const asDrift = (body: unknown): StackDrift | null =>
  body && typeof body === 'object' && Array.isArray((body as { gaps?: unknown }).gaps) ? (body as StackDrift) : null;
