// A timed-out job (issue #630), pure: its liveness decides. Active — its pane output changed within the active window
// before its timeout, it pushed commits, or a pull request of its own is open —: it goes on (Continue), at most
// `MAX_ACTIVE_TIMEOUTS - 1` times in a row, then a person: an agent that keeps producing output is not continued for
// ever. Silent — none of them —: it runs again once; silent again after that retry, a person. A fact not known (a pull
// request lookup that failed) counts for nothing: the others decide.
import type { FailureDecision, FailureSettings } from '../domain/types.ts';

/** How a timed-out run of a chain ended: still at work, or silent. */
export type TimeoutKind = 'active' | 'silent';

/** The third active timeout in a row goes to a person. */
export const MAX_ACTIVE_TIMEOUTS = 3;

/** The liveness the rules read: `outputAgoMs`, how long before its timeout its pane output last changed. */
export interface LivenessFacts { outputAgoMs?: number; pushed?: boolean; pullRequest?: boolean }

export interface TimeoutJudgement { kind: TimeoutKind; decision: Extract<FailureDecision, 'continue' | 'retry' | 'person'>; reasons: string[] }

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)} min`;

/** Active or silent, and why. */
export function timeoutKind(l: LivenessFacts, s: Pick<FailureSettings, 'activeWindowMin'>): { kind: TimeoutKind; reasons: string[] } {
  const active: string[] = [];
  if (l.outputAgoMs !== undefined && l.outputAgoMs <= s.activeWindowMin * 60_000) active.push(`pane output changed ${minutes(l.outputAgoMs)} before the timeout`);
  if (l.pushed === true) active.push('commits pushed');
  if (l.pullRequest === true) active.push('a pull request of its own is open');
  if (active.length) return { kind: 'active', reasons: [`at work: ${active.join(', ')}`] };
  const silent = [
    l.outputAgoMs === undefined ? 'no pane output' : `no pane output for ${minutes(l.outputAgoMs)}`,
    l.pushed === false ? 'no commits pushed' : 'commits pushed not known',
    l.pullRequest === false ? 'no pull request' : 'pull request not known',
  ];
  return { kind: 'silent', reasons: [`silent: ${silent.join(', ')}`] };
}

/** Its decision, from its liveness and the timed-out runs of its chain just before it, newest first. */
export function judgeTimeout(l: LivenessFacts, earlier: readonly TimeoutKind[], s: Pick<FailureSettings, 'activeWindowMin'>): TimeoutJudgement {
  const { kind, reasons } = timeoutKind(l, s);
  if (kind === 'silent') {
    if (earlier[0] === 'silent') return { kind, decision: 'person', reasons: [...reasons, 'silent again after its retry: it needs a person'] };
    return { kind, decision: 'retry', reasons: [...reasons, 'retried once'] };
  }
  const inRow = 1 + (earlier.findIndex((k) => k !== 'active') === -1 ? earlier.length : earlier.findIndex((k) => k !== 'active'));
  if (inRow >= MAX_ACTIVE_TIMEOUTS) return { kind, decision: 'person', reasons: [...reasons, `${inRow} timeouts in a row while at work: it needs a person`] };
  return { kind, decision: 'continue', reasons: [...reasons, `it goes on: timeout ${inRow} of ${MAX_ACTIVE_TIMEOUTS} in a row while at work`] };
}
