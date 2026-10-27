// Bug-report recommendations (issue #2846 part 2, design.md "Bug-report recommendations"): a completion review that finds the
// run hit a hopper defect — not only a hard task — names it, by fixed rules, with a signature: the same defect on many jobs is
// one signature, so it is recommended once, and a dismissed signature is not recommended again. The text names no job,
// person, machine or path: it is a report on the hopper, and it still goes through the bug-report pipeline's scrub. Pure.
import type { Restart } from './completion-review.ts';

/** What the review reads of the job's failure record: its known cause, when the assessor matched one. */
export interface ReviewFailure { causeId?: string }

/** A hopper defect the review found: its signature, and the report's title and description. */
export interface ReviewDefect { signature: string; title: string; description: string }

/** The causes that are the hopper's own act or fault (src/failures/causes.ts `SWEPT`, `NO_WAY_TO_HOPPER`), by their id. */
const HOPPER_CAUSES: Readonly<Record<string, Omit<ReviewDefect, 'signature'>>> = {
  swept: {
    title: 'The sweep stopped the processes of a job that was at work',
    description: 'A completion review found a job that failed because the hopper\'s sweep stopped its processes. The sweep read the job as not running (queued, held or parked) while its agent was still at work. This is the hopper\'s own act, not a fault of the job\'s work.',
  },
  'no-way-to-hopper': {
    title: 'A job\'s session lost its way to the hopper',
    description: 'A completion review found a job that failed because its session had no way to the hopper: its hopper URL, its GitHub helper, its token file or its credentials were missing. The job could not push or ask the hopper. The hopper places these for each job, so this is a fault of the hopper, not of the job\'s work.',
  },
};

/** A job queued again this many times by the hopper before its end is in a requeue loop. */
export const REQUEUE_LOOP = 3;

/** A cause as a signature part: lower case, its numbers and ids out, words joined by `-`; at most 60 characters. */
export const causeSlug = (cause: string): string =>
  cause.toLowerCase().replace(/\b[0-9a-f]*\d[0-9a-f]*\b/g, ' ').replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

/** The hopper defect of a run, the first rule that holds; undefined: the run shows none. */
export function defectOf(i: { failure?: ReviewFailure; restarts: readonly Restart[] }): ReviewDefect | undefined {
  const known = i.failure?.causeId ? HOPPER_CAUSES[i.failure.causeId] : undefined;
  if (known) return { signature: `cause:${i.failure!.causeId}`, ...known };
  const requeued = i.restarts.find((r) => r.kind === 'requeued');
  if (requeued && requeued.count >= REQUEUE_LOOP) {
    const first = requeued.causes[0];
    const slug = first ? causeSlug(first) : '';
    return {
      signature: `requeue-loop${slug ? `:${slug}` : ''}`,
      title: 'The hopper queued one job again and again',
      description: `A completion review found a job that the hopper queued again ${requeued.count} times before it ended.${first ? ` The first cause: ${first}.` : ''} Each requeue loses the run's place and time. A loop of them is a fault of the hopper, not of the job's work.`,
    };
  }
  return undefined;
}

/** What became of a recommendation: it waits for a person (`open`), a person approved it and it went to Report a bug, or a person dismissed it. */
export const RECOMMENDATION_STATES = ['open', 'approved', 'dismissed'] as const;
export type RecommendationState = (typeof RECOMMENDATION_STATES)[number];

/** A bug-report recommendation (table `review_recommendations`): one per signature, made by the first review that found it. */
export interface BugReportRecommendation extends ReviewDefect {
  /** The job whose review found it first. */
  jobId: string;
  state: RecommendationState;
  /** How many reviewed jobs found it. */
  jobs: number;
  at: string;
  /** When a review found it last. */
  lastAt: string;
  decidedAt?: string;
  /** Who approved or dismissed it. */
  by?: string;
  /** Why it was dismissed. */
  reason?: string;
  /** The bug report it made, once approved. */
  reportId?: string;
}

export interface RecommendationRepository {
  /** A new signature is kept `open`; a known one counts the job. `created`: it was new. */
  recommend(d: ReviewDefect & { jobId: string; at: string }): { recommendation: BugReportRecommendation; created: boolean };
  get(signature: string): BugReportRecommendation | undefined;
  /** Newest first, of `state` when it names one; at most 200. */
  list(state?: RecommendationState): BugReportRecommendation[];
  decide(signature: string, d: { state: Exclude<RecommendationState, 'open'>; at: string; by: string; reason?: string; reportId?: string }): BugReportRecommendation;
}
