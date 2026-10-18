// Sandboxes before the start (issue #1471, design.md "Sandboxes before the start"): a job whose prompt names a sandbox
// template of its user's — `box <name>`, `template <name>` — has its sandbox runs of that template asked for before it
// starts, and is held until each request is approved or declined and each approved template is ready. All of its asks
// show on Access requests at once, so a person approves them together, and the job never learns mid-run that a box
// step of a template it was told to use has no approval. Pure.
import { checkWait } from './read-only-check.ts';
import type { SandboxRequestView } from './sandbox-approvals.ts';
import type { TemplateView } from './vault.ts';

/** The start of the hold reason of a job whose named sandboxes are not approved and ready yet. */
export const SANDBOXES_HOLD = 'awaiting its sandboxes';

/** Whether a step may run in a box of the template now: approved, its image approved, every profile approved, its check passed. */
export const templateReady = (t: TemplateView): boolean => t.approval !== undefined && !t.pending.image && t.pending.egress.length === 0 && t.pending.profiles.length === 0 && checkWait(t) === undefined;

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The user's templates `text` names, in the order of `names`: each a whole name right after `template` or `box` (`box
 * of template`, quoted or not). A name that is only a word of the text is not named: "the web page" names no template web.
 */
export function namedTemplates(text: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`\\b(?:template|box)\\s+(?:of\\s+template\\s+)?[\`'"]?${escaped(name)}(?![a-z0-9_-]|\\.[a-z0-9])`, 'i').test(text));
}

/**
 * Why the job's sandbox requests hold it, or undefined: a request that waits for a person or for Jev's check (issue #655
 * part 13), or an approved one whose template is not ready. A declined request holds nothing: a person said no, and the
 * job is told so when it asks.
 */
export function sandboxesHold(requests: readonly SandboxRequestView[], templates: readonly TemplateView[]): string | undefined {
  const waiting = requests.filter((r) => r.state === 'waiting' && r.jev?.state !== 'checking').map((r) => r.template);
  const checking = requests.filter((r) => r.state === 'waiting' && r.jev?.state === 'checking').map((r) => r.template);
  const notReady = requests.filter((r) => r.state === 'approved' && !templates.some((t) => t.name === r.template && templateReady(t))).map((r) => r.template);
  const why = [
    ...(waiting.length ? [`the sandbox runs of template ${waiting.join(', ')} wait for a person on Access requests`] : []),
    ...(checking.length ? [`Jev checks the sandbox runs of template ${checking.join(', ')}`] : []),
    ...(notReady.length ? [`template ${notReady.join(', ')} ${notReady.length > 1 ? 'wait' : 'waits'} for a person or for its read-only check on Access requests`] : []),
  ];
  return why.length ? `${SANDBOXES_HOLD}: ${why.join('; ')}` : undefined;
}
