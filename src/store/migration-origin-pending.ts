// Tenant migration 39 (issue #652, requirement 10): the backfill of trusted origin. A job of a GitHub source queued or
// held before origins were judged has none; it waits for its issue's origin (`originPending`), so a stranger's issue
// queued before the change never starts unless the next sync finds it of a trusted origin or a person approves its
// request card. Jobs that started, ended, have an origin, or come from another source are left. The build before
// ignores the flag.
import type { Db } from './db.ts';

/** The source kinds that judge origins: the GitHub sources, and the kind jobs of the GitHub source carried before. */
const JUDGING_KINDS = ['github', 'github-account', 'github-app'];

export function originPendingBackfill(db: Db): void {
  for (const row of db.all("SELECT id, body FROM jobs WHERE status IN ('queued', 'held')")) {
    const job = JSON.parse(String(row.body)) as { source?: { kind?: string; origin?: string }; originPending?: true };
    if (!job.source?.kind || !JUDGING_KINDS.includes(job.source.kind) || job.source.origin) continue;
    job.originPending = true;
    db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(job), String(row.id));
  }
}
