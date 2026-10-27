// Completion reviews in the UI (issue #2846), pure: the words of a review on the job view — its stages, restarts and
// suggestion areas —, the summary of the setting in Settings, and the change a save sends.
import type { CompletionReviewSettings, Restart, RestartKind, ReviewOutcome, ReviewStage, SuggestionArea } from './wire.ts';

/** The ends a review may follow, in the daemon's order. */
export const OUTCOMES: readonly ReviewOutcome[] = ['finished', 'failed', 'cancelled'];
export const OUTCOME_NAMES: Record<ReviewOutcome, string> = { finished: 'Finished', failed: 'Failed', cancelled: 'Cancelled' };

/** The longest minimum run time, a day in minutes, as the daemon allows it. */
const MAX_MINUTES = 24 * 60;

export const STAGE_NAMES: Record<ReviewStage, string> = {
  queued: 'Waiting for a lane', running: 'Running', person: 'Waiting on a person', waiting: 'Its own waits', parked: 'Parked',
};

export const AREA_NAMES: Record<SuggestionArea, string> = { config: 'Config', routing: 'Routing', lane: 'Lanes', template: 'Template', prompt: 'Prompt' };

const RESTART_NAMES: Record<RestartKind, string> = {
  requeued: 'Queued again', preempted: 'Preempted', parked: 'Parked by the hopper', link_lost: 'Lost the link to its machine',
  oom_killed: 'A process was killed for memory', heap_retry: 'Ran again with a larger heap',
};

/** A restart in one line: what, how often, and its causes. */
export const restartLine = (r: Restart): string =>
  `${RESTART_NAMES[r.kind]} ${r.count === 1 ? 'once' : `${r.count} times`}${r.causes.length ? `: ${r.causes.join('; ')}` : ''}`;

/** Minutes and hours, as people read them. */
export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** What is on now, in one sentence. */
export function completionReviewSummary(s: CompletionReviewSettings): string {
  if (!s.on) return 'Off: no ended job is reviewed.';
  const ends = s.outcomes.map((o) => OUTCOME_NAMES[o].toLowerCase());
  const which = [...(ends.length ? [`${ends.join(', ')} jobs`] : []), ...(s.multiJob ? ['every job of a work item with more than one job'] : [])];
  if (which.length === 0) return 'On, but no end is named: no job is reviewed.';
  const min = s.minRunMinutes > 0 ? `, except a first run shorter than ${Math.round(s.minRunMinutes * 10) / 10} min` : '';
  return `On: reviews ${which.join(', and ')}${min}.`;
}

export interface CompletionReviewDraft { on: boolean; outcomes: ReviewOutcome[]; multiJob: boolean; minRunMinutes: string }
export type CompletionReviewPatch = Partial<CompletionReviewSettings>;

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function completionReviewPatch(s: CompletionReviewSettings, d: CompletionReviewDraft): { ok: true; patch: CompletionReviewPatch | undefined } | { ok: false; error: string } {
  const text = d.minRunMinutes.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n) || n < 0 || n > MAX_MINUTES) return { ok: false, error: `Minimum run time: a number from 0 to ${MAX_MINUTES}` };
  const outcomes = OUTCOMES.filter((o) => d.outcomes.includes(o));
  const patch: CompletionReviewPatch = {
    ...(d.on === s.on ? {} : { on: d.on }), ...(outcomes.join() === s.outcomes.join() ? {} : { outcomes }),
    ...(d.multiJob === s.multiJob ? {} : { multiJob: d.multiJob }), ...(n === s.minRunMinutes ? {} : { minRunMinutes: n }),
  };
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}
