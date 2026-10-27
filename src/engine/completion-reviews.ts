// The completion review pass (issue #2846, design.md "Completion reviews"): every COMPLETION_REVIEWS_EVERY_MS, on the host
// that holds its lease, each job that ended in the last REVIEW_WINDOW_MS — at least REVIEW_SETTLE_MS ago, so its run's last
// token read is in — and has no review yet is judged by the user's settings, and reviewed when they say so: from its events,
// its token ledger and its work item's jobs (`completionReviewOf`). The review is kept in the database, so a stop loses none:
// the next pass, on any host, reviews what it left. A job the settings skip is not judged again by this host. A review that
// names a hopper defect (issue #2846 part 2) makes a bug-report recommendation of its signature, in the same transaction: a
// new signature waits for a person (`completion_review.recommended`), a known one — open, approved or dismissed — counts the
// job, and is never recommended again.
import { completionReviewOf, completionReviewSettingsOf, shouldReview, type CompletionReview } from '../domain/completion-review.ts';
import type { UserStore } from '../domain/store.ts';
import { jobTokenView } from '../domain/token-usage.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';

export const COMPLETION_REVIEWS_EVERY_MS = 60_000;
/** How far back the pass looks for ended jobs. */
export const REVIEW_WINDOW_MS = 2 * 86_400_000;
/** How long after its end a job is reviewed. */
export const REVIEW_SETTLE_MS = 60_000;
/** At most this many of a job's events are read. */
const EVENTS = 5000;
const ENDS = ['job.finished', 'job.failed', 'job.cancelled'] as const;

/** The jobs of a job's work item, itself too; with no item, its chain of runs (at least itself). */
const jobsOf = (store: UserStore, job: Job): number => (job.source?.key ? Math.max(1, store.jobs.idsOfItem(job.source.key).length) : job.rerunOf ? 2 : 1);

/** The review of one ended job, from what the store keeps. */
export function reviewJob(store: UserStore, job: Job, jobs: number, at: Date): CompletionReview {
  const events = store.events.recent(EVENTS, undefined, job.id).reverse().map((e) => ({ type: e.type, at: e.at, data: e.data }));
  const view = jobTokenView(job.id, store.tokenLedger.list({ jobId: job.id }));
  const causeId = store.failures.forJob(job.id)?.causeId;
  return completionReviewOf({
    job: { ...job, commits: job.checkpoint?.commits.length ?? 0 }, events, ...(view.sessions > 0 ? { tokens: view.total } : {}), jobs,
    ...(job.status === 'failed' ? { failure: causeId ? { causeId } : {} } : {}), at: at.toISOString(),
  });
}

export interface CompletionReviewPass { (now: Date): CompletionReview[] }

/** The pass, with the jobs it judged and skipped kept in memory. Answers the reviews it kept. */
export function createCompletionReviews(store: UserStore): CompletionReviewPass {
  const skipped = new Set<string>();
  return (now) => {
    const settings = completionReviewSettingsOf(store.settings.getCompletionReview());
    if (!settings.on) return [];
    const settled = now.getTime() - REVIEW_SETTLE_MS;
    const ids = [...new Set(store.events.between(ENDS, new Date(now.getTime() - REVIEW_WINDOW_MS).toISOString())
      .filter((e) => e.jobId && Date.parse(e.at) <= settled && !skipped.has(e.jobId)).map((e) => e.jobId!))];
    const done = store.completionReviews.reviewed(ids);
    const kept: CompletionReview[] = [];
    for (const job of store.jobs.getMany(ids.filter((id) => !done.has(id))).values()) {
      if (!TERMINAL_STATUSES.includes(job.status)) continue;
      const jobs = jobsOf(store, job);
      if (!shouldReview(settings, job, jobs)) { skipped.add(job.id); continue; }
      const review = reviewJob(store, job, jobs, now);
      store.tx(() => {
        store.completionReviews.keep(review);
        if (!review.defect) return;
        const { created } = store.reviewRecommendations.recommend({ ...review.defect, jobId: job.id, at: review.reviewedAt });
        if (created) store.events.append({ type: 'completion_review.recommended', jobId: job.id, data: { signature: review.defect.signature, title: review.defect.title } });
      });
      kept.push(review);
    }
    return kept;
  };
}
