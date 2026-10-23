// Direct jobs in the UI (issue #901, design.md "Direct jobs"), pure: the submit form's draft, why it cannot be sent yet,
// the request it sends to POST /ui/api/direct-jobs, and how a direct job reads back — its state, its result, who
// submitted it and the way.
import type { DirectJobInput, DirectJobView, PushRequirement } from './wire.ts';

/**
 * What the form keeps: every field as typed. Labels split at commas and lines, authorizations at lines. Push requirements
 * (issue #2555 part 3): the job's own, as JSON — a list, or a requirements file's value `{ requirements: [...] }`.
 */
export interface DirectJobDraft { title: string; brief: string; labels: string; authorizations: string; repo: string; priority: string; promoteWhenDone: boolean; pushRequirements: string }

export const emptyDirectDraft = (): DirectJobDraft => ({ title: '', brief: '', labels: '', authorizations: '', repo: '', priority: '', promoteWhenDone: false, pushRequirements: '' });

/** The push requirements typed, as a list; undefined: none typed; null: no list of JSON. The daemon checks each one. */
function requirementsTyped(text: string): PushRequirement[] | undefined | null {
  if (text.trim() === '') return undefined;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(v) ? v : (v as { requirements?: unknown } | null)?.requirements;
  return Array.isArray(list) ? list as PushRequirement[] : null;
}

const REPO = /^[^/\s]+\/[^/\s]+$/;
const PRIORITY = /^\d{1,3}$/;

/** Why the draft cannot be sent yet; undefined: it can. The daemon checks again. */
export function directDraftProblem(d: DirectJobDraft): string | undefined {
  if (d.title.trim() === '') return 'Give it a title';
  if (d.brief.trim() === '') return 'Say what to do';
  if (d.repo.trim() !== '' && !REPO.test(d.repo.trim())) return 'Give the repository as owner/name';
  const p = d.priority.trim();
  if (p !== '' && (!PRIORITY.test(p) || Number(p) > 100)) return 'Give the priority as a whole number from 0 to 100';
  if (requirementsTyped(d.pushRequirements) === null) return 'Give the push requirements as JSON: [{ "id", "when", "checks" }]';
  return undefined;
}

const words = (text: string, at: RegExp): string[] => [...new Set(text.split(at).map((w) => w.trim()).filter((w) => w !== ''))];

/** The request a submit sends: only the fields given. */
export function directJobRequest(d: DirectJobDraft): DirectJobInput {
  const repo = d.repo.trim();
  const priority = d.priority.trim();
  const pushRequirements = requirementsTyped(d.pushRequirements);
  return {
    title: d.title.trim(), brief: d.brief.trim(), labels: words(d.labels, /[,\n]/), authorizations: words(d.authorizations, /\n/),
    ...(repo ? { repo } : {}), ...(priority ? { priority: Number(priority) } : {}), ...(d.promoteWhenDone ? { promoteWhenDone: true } : {}),
    ...(pushRequirements ? { pushRequirements } : {}),
  };
}

/** The list with each direct job offered for promotion first (issue #946): it waits on a person. Else as listed. */
export const offeredFirst = (list: readonly DirectJobView[]): DirectJobView[] => [...list.filter((d) => d.offer), ...list.filter((d) => !d.offer)];

/** The state a direct job shows: its job's status, and how many of its questions wait. */
export function directJobState(d: DirectJobView): { status: string; label: string } {
  if (!d.job) return { status: 'queued', label: 'not queued yet' };
  const n = d.job.questions.length;
  if (n > 0) return { status: d.job.status, label: `${n} ${n === 1 ? 'question waits' : 'questions wait'}` };
  return { status: d.job.status, label: d.job.status.replace('_', ' ') };
}

/** A job's result as text: a text result as it is, any other as JSON. */
export function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

const VIA: Record<DirectJobView['submittedBy']['via'], string> = { ui: 'in the UI', api: 'with an API token', cli: 'with the operator CLI' };

export const submittedLine = (d: DirectJobView): string => `Submitted by ${d.submittedBy.person} ${VIA[d.submittedBy.via]}`;
