// The Failures view's model (issue #509), pure: how a decision and an outcome read, their tone, which actions
// show — only what the daemon says it takes now (`actions`) and the session's role allows — and the nav badge.
import type { Allowed, FailureDecision, FailureRecordView, FailuresView, HandoffReason, HandoffResolution, HandoffResolutionAction, HandoffView } from './wire';

export const DECISION_LABEL: Record<FailureDecision, string> = { retry: 'retry', hold: 'held', redirect: 'redirected', person: 'needs a person' };
export const DECISION_TONE: Record<FailureDecision, 'warn' | 'bad' | 'busy' | 'question'> = { retry: 'busy', hold: 'warn', redirect: 'warn', person: 'question' };

const OUTCOME_LABEL: Record<NonNullable<FailureRecordView['outcome']>, string> = {
  retried: 'ran again', redirected: 'ran again elsewhere', released: 'released', held: 'waits on its problem', surfaced: 'waits on a person', not_retried: 'not run again',
  superseded: 'its item ran again', item_closed: 'its item is closed', resolved: 'resolved by a person',
};

/** What became of the decision, in a few words; a pending run again says when. */
export function outcomeText(r: FailureRecordView): string {
  if (r.pending === 'retry' && r.pendingAt) return `runs again at ${new Date(r.pendingAt).toLocaleTimeString()}`;
  if (r.pending) return 'runs again now';
  return r.outcome ? OUTCOME_LABEL[r.outcome] : '';
}

/** Shown only when the daemon takes it now and the role may act. */
export const offered = (a: Allowed | undefined, canAct: boolean): boolean => canAct && a?.ok === true;

/** The nav badge: open problems. */
export const openProblems = (f: FailuresView | null): number => f?.problems.filter((p) => p.status === 'open').length ?? 0;

/** Needs a person (issue #516): the open hand-offs. Still open means still counted. */
export const openHandoffs = (f: FailuresView | null): number => f?.handoffs.filter((h) => h.status === 'open').length ?? 0;

/** Why a job was handed off to a person, in a few words. */
export const HANDOFF_REASON_LABEL: Record<HandoffReason, string> = {
  retry_limit: 'retries used up', person: 'job-specific', auto_off: 'automatic action off', not_retried: 'run again refused', dismissed: 'dismissed from the queue',
};

/** How a closed hand-off ended: by a person (issue #551), or found stale (issue #529). */
const HANDOFF_END_LABEL: Record<NonNullable<HandoffView['end']>, string> = {
  run_again: 'ran again', continued: 'continued', done_by_hand: 'done by hand', wont_do: 'won\'t do', cleared: 'cleared', finished: 'its job finished',
  superseded: 'a newer job of its item', item_closed: 'its item is closed', job_gone: 'its job is gone',
};

export function handoffEndText(h: HandoffView): string {
  if (h.resolution) return RESOLUTION_DONE[h.resolution.action](h.resolution);
  return h.end ? HANDOFF_END_LABEL[h.end] : 'closed';
}

/**
 * What to do about a hand-off, by why it was handed off (issue #551): the plain next step the card says first.
 */
export const HANDOFF_NEXT_STEP: Record<HandoffReason, string> = {
  person: 'The job hit a problem of its own: its code, its tests, or the task as written. Read the error and the assessment, then Continue with a note that tells it what to do differently — or do it yourself and mark it Done by hand.',
  retry_limit: 'It failed the same way every time it ran again, so the cause is likely outside the job: a machine, a credential, a service or the repository. Fix that, then say I fixed it — or Continue with a note if the job should work around it.',
  auto_off: 'Automatic handling is switched off for this kind of failure (Failures settings), so it waits for you. Run it again when the cause is gone (I fixed it), Continue with a note, or close it.',
  not_retried: 'The hopper tried to run it again and was refused (the assessment says why). Remove what refused it, then I fixed it — or close it as Done by hand or Won\'t do.',
  dismissed: 'It was dismissed from the queue with its failure unresolved. Close it as Done by hand or Won\'t do, or run it again.',
};

/** The resolutions in the order the card offers them, with their button labels. */
export const RESOLUTIONS: { action: HandoffResolutionAction; key: keyof HandoffView['actions']; label: string }[] = [
  { action: 'continue', key: 'continue', label: 'Continue' },
  { action: 'fixed', key: 'fixed', label: 'I fixed it' },
  { action: 'done_by_hand', key: 'doneByHand', label: 'Done by hand' },
  { action: 'wont_do', key: 'wontDo', label: 'Won\'t do' },
];

/** What each resolution will lead to, for this hand-off: Continue resumes its own session, or runs a new job. */
export function resolutionLeadsTo(action: HandoffResolutionAction, h: Pick<HandoffView, 'continueResumes'>): string {
  switch (action) {
    case 'continue': return h.continueResumes
      ? 'Its own session goes on in its work tree, told the error and your note.'
      : 'Its session cannot resume, so a new job of its item runs, told the error, the assessment and your note.';
    case 'fixed': return 'You fixed the cause (environment, credentials, repository): a new job of its item runs, told your note.';
    case 'done_by_hand': return 'You did the work: the job ends finished, with your note and link.';
    case 'wont_do': return 'Not to be done, or not a real failure: closed with your reason (required); it is not taken again.';
  }
}

/** A resolution as done, in a few words. */
const RESOLUTION_DONE: Record<HandoffResolutionAction, (r: HandoffResolution) => string> = {
  continue: (r) => (r.resumed === false ? 'continued in a new job' : 'continued in its session'),
  fixed: () => 'fixed, ran again',
  done_by_hand: () => 'done by hand',
  wont_do: () => 'won\'t do',
};

/** Whether the resolution reached its item's source: told, waiting to be told (with why), refused, or nothing to tell. */
export function writeBackText(r: HandoffResolution): string | undefined {
  if (r.writeBack === 'written') return 'told its issue';
  if (r.writeBack === 'pending') return r.writeBackError ? `not told its issue yet: ${r.writeBackError}` : 'telling its issue';
  if (r.writeBack === 'failed') return `its issue refused it: ${r.writeBackError ?? 'no reason given'}`;
  return undefined;
}

/** A count as `n thing(s)`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What is left to process (issue #517), in words: nothing, or how many are not assessed and need a person. */
export function countsText(c: FailuresView['counts']): string {
  if (c.unassessed === 0 && c.needsPerson === 0) return 'Every failed job is assessed, and none needs a person.';
  const parts = [
    ...(c.unassessed ? [`${plural(c.unassessed, 'failed job')} not assessed yet`] : []),
    ...(c.needsPerson ? [`${plural(c.needsPerson, 'failed job')} ${c.needsPerson === 1 ? 'needs' : 'need'} a person`] : []),
  ];
  return `${parts.join(' · ')}.`;
}
