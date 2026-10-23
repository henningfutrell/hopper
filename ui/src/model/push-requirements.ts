// The default push requirements in the UI (issue #2555), pure: the panel's summary, its note, and the check of the JSON a
// person edits. The hopper reads the requirements themselves (POST /ui/api/push-requirements says what it refuses).
import type { PushRequirement } from './wire.ts';

export const PUSH_REQUIREMENTS_NOTE = 'Checks that a job runs in its work tree before it pushes, so a CI gate that would fail, fails there first. '
  + 'A repository lists its own in .hopper/requirements.yaml. The requirements here apply to every repository, below its own file: '
  + 'a requirement of the same id in the repository replaces the one here. When one applies to a commit, the hopper takes a push '
  + 'of that commit only after the job ran the checks and they passed.';

export const pushRequirementsSummary = (requirements: readonly PushRequirement[]): string => (requirements.length === 0
  ? 'No default requirements. Only a repository\'s own requirements apply.'
  : `${requirements.length} default requirement${requirements.length === 1 ? '' : 's'}: ${requirements.map((q) => q.id).join(', ')}.`);

/** The editor's text for the saved requirements: the same shape as a requirements file, in JSON. */
export const requirementsText = (requirements: readonly PushRequirement[]): string => JSON.stringify({ requirements }, null, 2);

/** What POST /ui/api/push-requirements is sent for the editor's text, or why not. Empty text: none. */
export function requirementsDraft(text: string): { ok: true; body: { requirements: unknown[] } } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, body: { requirements: [] } };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'This is not JSON' }; }
  const requirements = (raw as { requirements?: unknown } | null)?.requirements;
  if (!Array.isArray(requirements)) return { ok: false, error: 'Write { "requirements": [ ... ] }' };
  return { ok: true, body: { requirements } };
}
