// High priority in the UI (issue #535): a job at or above the threshold the queue answers is tagged and listed first;
// questions, logins and hand-offs carry their job's live priority from the API. Priority lanes as people read them.
import { longestWaitingFirst } from './questions.ts';
import type { FailuresView, Job, PriorityLaneView, QuestionView } from './wire.ts';

/** High priority: at or above the threshold. None is until the queue has answered one. */
export const isHighJob = (job: Pick<Job, 'priority'> | undefined, threshold: number | null): boolean =>
  job !== undefined && threshold !== null && job.priority >= threshold;

/** High-priority items first, then as they were: each list keeps its own order within. */
export function highFirst<T>(items: readonly T[], high: (item: T) => boolean): T[] {
  return items.map((item, i) => ({ item, i, h: high(item) })).sort((a, b) => Number(b.h) - Number(a.h) || a.i - b.i).map((x) => x.item);
}

/** The open questions' order, the API's too: high-priority ones first, then the longest waiting (issue #450). */
export const questionOrder = (qs: QuestionView[]): QuestionView[] => highFirst(longestWaitingFirst(qs), (q) => q.high);

/** The questions waiting on the owner whose job is high priority: the nav badge marks them. */
export const highQuestions = (qs: QuestionView[]): number => qs.filter((q) => q.status === 'open' && q.tier === 'human' && q.high).length;

/** The open hand-offs of high-priority jobs. */
export const highHandoffs = (f: FailuresView | null): number => f?.handoffs.filter((h) => h.status === 'open' && h.high === true).length ?? 0;

const percent = (x: number): string => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** `97% without a lane fault · 31 runs · 1 lane fault`, or `no runs`. */
export function reliabilityText(l: PriorityLaneView): string {
  if (l.runs === 0) return 'no runs';
  return `${percent(l.score)} without a lane fault · ${plural(l.runs, 'run')} · ${plural(l.laneFaults, 'lane fault')}`;
}

/** A median start time: `12 s`, `1 min 35 s`, or a dash for none. */
export function startText(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
