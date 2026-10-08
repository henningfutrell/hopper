// The Failures view's model (issue #509), pure: how a decision and an outcome read, their tone, which actions
// show — only what the daemon says it takes now (`actions`) and the session's role allows — and the nav badge.
import type { Allowed, FailureDecision, FailureRecordView, FailuresView } from './wire';

export const DECISION_LABEL: Record<FailureDecision, string> = { retry: 'retry', hold: 'held', redirect: 'redirected', person: 'needs a person' };
export const DECISION_TONE: Record<FailureDecision, 'warn' | 'bad' | 'busy' | 'question'> = { retry: 'busy', hold: 'warn', redirect: 'warn', person: 'question' };

const OUTCOME_LABEL: Record<NonNullable<FailureRecordView['outcome']>, string> = {
  retried: 'ran again', redirected: 'ran again elsewhere', released: 'released', held: 'waits on its problem', surfaced: 'waits on a person', not_retried: 'not run again',
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

/** A count as `n thing(s)`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
