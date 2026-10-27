// The model review of a completion review (issue #2846 part 3, design.md "Completion reviews"): after the rules reviewed an
// ended job's run, a model the user picked reads that review and the job's short timeline, and writes its own review beside
// it — a summary, what went well, where it stalled, the changes that would have helped and whether the run hit a hopper
// defect. One locked-down print turn of the `claude` CLI (src/completion-reviews/model.ts); the rule review stays the source
// of the bug-report recommendations. The model reviews only while its cost of the last day is below the daily cost cap. Pure.
import { z } from 'zod';
import { SUGGESTION_AREAS, durationText, restartWords, type CompletionReview, type Suggestion } from './completion-review.ts';

/** What the model wrote. `hopperDefect`: why it thinks the run hit a defect of the hopper itself, not only a hard task. */
export interface ModelReviewAnswer { summary: string; went: string[]; stalls: string[]; suggestions: Suggestion[]; hopperDefect?: string }

/** A model review as kept with its completion review: the model that ran, its cost when the CLI said it, and when. */
export type ModelReview = ModelReviewAnswer & { model?: string; costUsd?: number; at: string };

/** A model review that failed: why, and when. It is not asked again. */
export interface ModelReviewFailure { error: string; at: string }

/** The model's answer: one call with a review prompt, to the model named. */
export type ModelReviewWriter = (prompt: string, model: string, signal: AbortSignal) => Promise<(ModelReviewAnswer & { model?: string; costUsd?: number }) | { error: string }>;

const MAX_LINES = 6;
const MAX_TEXT = 500;

/** The literal draft-07 JSON Schema the CLI binds the answer to (`claude-print.ts`). */
export const MODEL_REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    went: { type: 'array', items: { type: 'string' } },
    stalls: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'object', properties: { area: { type: 'string', enum: [...SUGGESTION_AREAS] }, text: { type: 'string' } }, required: ['area', 'text'], additionalProperties: false } },
    hopperDefect: { type: 'string' },
  },
  required: ['summary', 'went', 'stalls', 'suggestions'],
  additionalProperties: false,
};

const text = z.string().transform((s) => s.trim().slice(0, MAX_TEXT));
const lines = z.array(text).transform((xs) => xs.filter((x) => x !== '').slice(0, MAX_LINES));

/** The answer as kept: each text at most 500 characters, at most 6 lines each, an empty defect left out. */
export const modelReviewAnswer = z.object({
  summary: text, went: lines, stalls: lines,
  suggestions: z.array(z.object({ area: z.enum(SUGGESTION_AREAS), text })).transform((xs) => xs.filter((x) => x.text !== '').slice(0, MAX_LINES)),
  hopperDefect: text.optional(),
}).transform(({ hopperDefect, ...a }): ModelReviewAnswer => ({ ...a, ...(hopperDefect ? { hopperDefect } : {}) }));

/** What the prompt says of the job, beside its rule review. */
export interface ModelReviewJob { title: string; executor: string; failure?: string }

/** An event of the job's timeline, as the prompt lists it: its type and its minutes from the job's creation. */
export interface TimelineEvent { type: string; at: string }

/** At most this many events of the timeline go into the prompt: the first and the last. */
export const TIMELINE_EVENTS = 60;

/** The prompt: the job, its rule review and its timeline, and what to write. Names no machine, person or path of its own. */
export function modelReviewPrompt(job: ModelReviewJob, review: CompletionReview, createdAt: string, timeline: readonly TimelineEvent[]): string {
  const from = Date.parse(createdAt);
  const kept = timeline.length <= TIMELINE_EVENTS ? timeline : [...timeline.slice(0, TIMELINE_EVENTS / 2), ...timeline.slice(-TIMELINE_EVENTS / 2)];
  const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');
  return [
    'You review the run of one job of a job-queue daemon (the hopper) after it ended. An agent did the job\'s work.',
    'Say what went well, where the run stalled and why, and which changes would have helped: config, routing, lane, template or prompt.',
    'Set hopperDefect only when the run shows a defect of the hopper itself (the daemon queued, stopped, lost or broke the job), not a hard task or a fault of the agent\'s work; say why in one sentence.',
    'Write short plain sentences. Do not repeat the facts below one by one.',
    '',
    `Job: ${job.title}`,
    `Executor: ${job.executor}`,
    `Outcome: ${review.outcome}, after ${durationText(review.durationMs)}; ${review.jobs} job(s) of its work item; ${review.questions} question(s).`,
    ...(job.failure ? [`Failure: ${job.failure}`] : []),
    `Time per stage: ${review.stages.map((s) => `${s.stage} ${durationText(s.ms)}`).join(', ') || 'none'}`,
    'Restarts:', list(review.restarts.map((r) => `${restartWords(r)}${r.causes.length ? `: ${r.causes.join('; ')}` : ''}`)),
    'Waste signals:', list(review.waste.map((w) => w.kind)),
    'The rule review found, went well:', list(review.went),
    'Stalls:', list(review.stalls),
    'Suggestions:', list(review.suggestions.map((s) => `${s.area}: ${s.text}`)),
    `Timeline (minutes from creation, ${timeline.length} events${kept.length < timeline.length ? `, the first and last ${kept.length}` : ''}):`,
    list(kept.map((e) => `${Math.max(0, Math.round((Date.parse(e.at) - from) / 60_000))} ${e.type}`)),
  ].join('\n');
}

const DAY = 86_400_000;

/** What the model reviews cost in the day before `now`, from the kept reviews. */
export function modelCostOfDay(reviews: readonly CompletionReview[], now: Date): number {
  const since = now.getTime() - DAY;
  return reviews.reduce((n, r) => n + (r.modelReview && Date.parse(r.modelReview.at) > since ? r.modelReview.costUsd ?? 0 : 0), 0);
}

/** The kept reviews the model has not reviewed or failed on, oldest first. */
export const awaitingModel = (reviews: readonly CompletionReview[]): CompletionReview[] =>
  reviews.filter((r) => !r.modelReview && !r.modelFailed).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
