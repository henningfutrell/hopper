// The Failures view's model (issue #509), pure: how a decision and an outcome read, their tone, which actions
// show — only what the daemon says it takes now (`actions`) and the session's role allows — and the nav badge.
import type { Allowed, FailureDecision, FailureRecordView, FailuresView, HandoffReason, HandoffView } from './wire';

export const DECISION_LABEL: Record<FailureDecision, string> = { retry: 'retry', hold: 'held', redirect: 'redirected', person: 'needs a person' };
export const DECISION_TONE: Record<FailureDecision, 'warn' | 'bad' | 'busy' | 'question'> = { retry: 'busy', hold: 'warn', redirect: 'warn', person: 'question' };

const OUTCOME_LABEL: Record<NonNullable<FailureRecordView['outcome']>, string> = {
  retried: 'ran again', redirected: 'ran again elsewhere', released: 'released', held: 'waits on its problem', surfaced: 'waits on a person', not_retried: 'not run again',
  superseded: 'its item ran again', item_closed: 'its item is closed',
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

/** How a closed hand-off ended: by a person, or found stale (issue #529). */
const HANDOFF_END_LABEL: Record<NonNullable<HandoffView['end']>, string> = {
  run_again: 'ran again', cleared: 'cleared', finished: 'its job finished',
  superseded: 'a newer job of its item', item_closed: 'its item is closed', job_gone: 'its job is gone',
};

export function handoffEndText(h: HandoffView): string {
  return h.end ? HANDOFF_END_LABEL[h.end] : 'closed';
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
