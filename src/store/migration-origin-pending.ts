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

/**
 * Tenant migration 85 (issue #1974): a job of a GitHub source with no origin that had started when migration 39 ran was
 * left by it; the stamps' backfill then stamped it `untrusted` (`origin:none`), and once it waited again no request card
 * and no approval let it go on. It waits for its issue's origin too, whatever its status: the next sync judges the issue,
 * stamps the job again by the rules, or opens its request card in Intake. A job a job made keeps its parent's level.
 * Rows only: the build before reads the flag as migration 39's.
 */
export function originPendingStarted(db: Db): void {
  for (const row of db.all("SELECT id, body FROM jobs WHERE status NOT IN ('finished', 'failed', 'cancelled', 'rejected')")) {
    const job = JSON.parse(String(row.body)) as { source?: { kind?: string; origin?: string }; originPending?: true; forkOf?: unknown; followOn?: unknown };
    if (!job.source?.kind || !JUDGING_KINDS.includes(job.source.kind) || job.source.origin || job.originPending || job.forkOf || job.followOn) continue;
    job.originPending = true;
    db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(job), String(row.id));
  }
}

/**
 * Tenant migration 86 (issue #2113): a job made after 85 from an item offered with no origin (its issue's job had not ended
 * when the sync judged it) was stamped `untrusted` (`origin:none`) with no `originPending`, so no request card and no
 * approval let it go on. 85's mark again: such a job that has not ended waits for its issue's origin. Rows only.
 */
export const originPendingOffered = (db: Db): void => originPendingStarted(db);
