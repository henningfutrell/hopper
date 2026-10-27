// Completion reviews in the UI (issue #2846), pure: the words of a review on the job view — its stages, restarts and
// suggestion areas —, the summary of the setting in Settings, and the change a save sends. The bug-report recommendations
// (issue #2846 part 2): what became of one, and Needs you's line of each that waits. The model review (issue #2846 part 3):
// its settings in the same form, and how the job view names its model and cost.
import type { BugReportRecommendation, CompletionReviewSettings, Restart, RestartKind, ReviewOutcome, ReviewStage, SuggestionArea } from './wire.ts';

/** The ends a review may follow, in the daemon's order. */
export const OUTCOMES: readonly ReviewOutcome[] = ['finished', 'failed', 'cancelled'];
export const OUTCOME_NAMES: Record<ReviewOutcome, string> = { finished: 'Finished', failed: 'Failed', cancelled: 'Cancelled' };

/** The longest minimum run time, a day in minutes, as the daemon allows it. */
const MAX_MINUTES = 24 * 60;
/** The highest daily cost cap of the model review, as the daemon allows it. */
const MAX_DAILY_USD = 100;
/** A model name as the daemon takes it. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

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

/** The model review's setting in one sentence. */
export function modelReviewSummary(s: CompletionReviewSettings): string {
  if (!s.modelReview.on) return 'Model review off: only the rules review a run.';
  return `Model review on: ${s.modelReview.model} reviews each kept review too, while the model reviews of the last day cost less than $${s.modelReview.dailyCostUsd}.`;
}

export interface CompletionReviewDraft {
  on: boolean; outcomes: ReviewOutcome[]; multiJob: boolean; minRunMinutes: string;
  modelOn: boolean; model: string; dailyCostUsd: string;
}
export type CompletionReviewPatch = Partial<Omit<CompletionReviewSettings, 'modelReview'>> & { modelReview?: Partial<CompletionReviewSettings['modelReview']> };

/** The draft of the saved settings. */
export const draftOf = (s: CompletionReviewSettings): CompletionReviewDraft => ({
  on: s.on, outcomes: s.outcomes, multiJob: s.multiJob, minRunMinutes: String(s.minRunMinutes),
  modelOn: s.modelReview.on, model: s.modelReview.model, dailyCostUsd: String(s.modelReview.dailyCostUsd),
});

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function completionReviewPatch(s: CompletionReviewSettings, d: CompletionReviewDraft): { ok: true; patch: CompletionReviewPatch | undefined } | { ok: false; error: string } {
  const text = d.minRunMinutes.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n) || n < 0 || n > MAX_MINUTES) return { ok: false, error: `Minimum run time: a number from 0 to ${MAX_MINUTES}` };
  const model = d.model.trim();
  if (!MODEL_NAME.test(model)) return { ok: false, error: 'Model: a model name, such as haiku or sonnet' };
  const costText = d.dailyCostUsd.trim();
  const cost = Number(costText);
  if (costText === '' || !Number.isFinite(cost) || cost < 0 || cost > MAX_DAILY_USD) return { ok: false, error: `Daily cost cap: a number of dollars from 0 to ${MAX_DAILY_USD}` };
  const outcomes = OUTCOMES.filter((o) => d.outcomes.includes(o));
  const m = s.modelReview;
  const modelReview = {
    ...(d.modelOn === m.on ? {} : { on: d.modelOn }), ...(model === m.model ? {} : { model }), ...(cost === m.dailyCostUsd ? {} : { dailyCostUsd: cost }),
  };
  const patch: CompletionReviewPatch = {
    ...(d.on === s.on ? {} : { on: d.on }), ...(outcomes.join() === s.outcomes.join() ? {} : { outcomes }),
    ...(d.multiJob === s.multiJob ? {} : { multiJob: d.multiJob }), ...(n === s.minRunMinutes ? {} : { minRunMinutes: n }),
    ...(Object.keys(modelReview).length > 0 ? { modelReview } : {}),
  };
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}

/** Which model wrote a model review, and what it cost, when the CLI said it. */
export const modelReviewBy = (r: { model?: string; costUsd?: number }): string =>
  `By ${r.model ?? 'the model'}${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(3)}` : ''}`;

/** What became of a recommendation, in one sentence. */
export function recommendationState(r: BugReportRecommendation): string {
  if (r.state === 'approved') return `Approved${r.by ? ` by ${r.by}` : ''}: it went to Your reports.`;
  if (r.state === 'dismissed') return `Dismissed${r.by ? ` by ${r.by}` : ''}${r.reason ? `: ${r.reason}` : ''}. It is not recommended again.`;
  return 'Waits for your approval in Your reports. Nothing is filed before you approve it.';
}

/** How many reviewed jobs found it, when more than one. */
export const recommendationJobs = (r: BugReportRecommendation): string => (r.jobs > 1 ? ` · found in ${r.jobs} jobs` : '');

/** Needs you's line of each recommendation that waits: its title, and how many jobs found it. */
export const openRecommendationLines = (v: { recommendations?: readonly BugReportRecommendation[] } | undefined): string[] =>
  (Array.isArray(v?.recommendations) ? v.recommendations : []).filter((r) => r.state === 'open').map((r) => `${r.title}${recommendationJobs(r)}`);
