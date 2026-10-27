// The completion reviews (issue #2846, tenant migration 102): one row per ended job, the review as JSON. The completion
// review pass writes it once, after the job ended, and the model review pass adds the model's review to it (issue #2846 part
// 3); the job page reads it.
import type { CompletionReview, CompletionReviewRepository } from '../domain/completion-review.ts';
import type { StoreContext } from './context.ts';

export const COMPLETION_REVIEW_TABLE = 'CREATE TABLE IF NOT EXISTS completion_reviews (job_id TEXT PRIMARY KEY, reviewed_at TEXT NOT NULL, review TEXT NOT NULL)';

export function createCompletionReviewRepository(c: StoreContext): CompletionReviewRepository {
  return {
    keep(r) {
      c.db.run(`INSERT INTO completion_reviews (job_id, reviewed_at, review) VALUES (?, ?, ?)
        ON CONFLICT (job_id) DO UPDATE SET reviewed_at = excluded.reviewed_at, review = excluded.review`, r.jobId, r.reviewedAt, JSON.stringify(r));
    },
    get(jobId) {
      const row = c.db.get('SELECT review FROM completion_reviews WHERE job_id = ?', jobId);
      return row ? JSON.parse(String(row.review)) as CompletionReview : undefined;
    },
    reviewed(jobIds) {
      if (jobIds.length === 0) return new Set();
      return new Set(c.db.all(`SELECT job_id FROM completion_reviews WHERE job_id IN (${jobIds.map(() => '?').join(', ')})`, ...jobIds).map((r) => String(r.job_id)));
    },
    since(since, limit) {
      return c.db.all('SELECT review FROM completion_reviews WHERE reviewed_at >= ? ORDER BY reviewed_at, job_id LIMIT ?', since, limit)
        .map((r) => JSON.parse(String(r.review)) as CompletionReview);
    },
  };
}
