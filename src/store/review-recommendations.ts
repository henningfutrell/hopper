// The bug-report recommendations of the completion reviews (issue #2846 part 2, tenant migration 105): one row per signature.
// The review pass writes a new one `open`, or counts one more job on a known one; a person's Approve or Dismiss decides it,
// and a dismissed signature stays, so it is not recommended again.
import type { BugReportRecommendation, RecommendationRepository, RecommendationState } from '../domain/review-defects.ts';
import type { Row } from './db.ts';
import type { StoreContext } from './context.ts';

export const RECOMMENDATION_TABLE = `CREATE TABLE IF NOT EXISTS review_recommendations (signature TEXT PRIMARY KEY, job_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, state TEXT NOT NULL, jobs INTEGER NOT NULL, at TEXT NOT NULL, last_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
  reason TEXT, report_id TEXT)`;

const opt = <K extends string>(k: K, v: unknown): Partial<Record<K, string>> => (v === null || v === undefined ? {} : { [k]: String(v) } as Record<K, string>);
const rowOf = (r: Row): BugReportRecommendation => ({
  signature: String(r.signature), jobId: String(r.job_id), title: String(r.title), description: String(r.description),
  state: String(r.state) as RecommendationState, jobs: Number(r.jobs), at: String(r.at), lastAt: String(r.last_at),
  ...opt('decidedAt', r.decided_at), ...opt('by', r.decided_by), ...opt('reason', r.reason), ...opt('reportId', r.report_id),
});

export function createRecommendationRepository(c: StoreContext): RecommendationRepository {
  const get = (signature: string): BugReportRecommendation | undefined => {
    const row = c.db.get('SELECT * FROM review_recommendations WHERE signature = ?', signature);
    return row ? rowOf(row) : undefined;
  };
  return {
    recommend(d) {
      const added = c.db.get(`INSERT INTO review_recommendations (signature, job_id, title, description, state, jobs, at, last_at)
        VALUES (?, ?, ?, ?, 'open', 1, ?, ?) ON CONFLICT (signature) DO NOTHING RETURNING *`, d.signature, d.jobId, d.title, d.description, d.at, d.at);
      if (added) return { recommendation: rowOf(added), created: true };
      const row = c.db.get('UPDATE review_recommendations SET jobs = jobs + 1, last_at = ? WHERE signature = ? RETURNING *', d.at, d.signature);
      return { recommendation: rowOf(row!), created: false };
    },
    get,
    list(state) {
      const rows = state ? c.db.all('SELECT * FROM review_recommendations WHERE state = ? ORDER BY last_at DESC LIMIT 200', state)
        : c.db.all('SELECT * FROM review_recommendations ORDER BY last_at DESC LIMIT 200');
      return rows.map(rowOf);
    },
    decide(signature, d) {
      const row = c.db.get('UPDATE review_recommendations SET state = ?, decided_at = ?, decided_by = ?, reason = ?, report_id = ? WHERE signature = ? RETURNING *',
        d.state, d.at, d.by, d.reason ?? null, d.reportId ?? null, signature);
      if (!row) throw new Error(`no recommendation ${signature}`);
      return rowOf(row);
    },
  };
}
