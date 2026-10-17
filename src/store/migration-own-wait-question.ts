// Tenant migration 79 (issue #1780): a job on its own wait has no question, but a job that asked one before it waited kept
// its `questionId`, so the open questions and the job disagreed. Each job on its own wait loses it; any other job keeps it.
import type { Db } from './db.ts';

export function noQuestionOnOwnWait(db: Db): void {
  for (const row of db.all("SELECT id, body FROM jobs WHERE status = 'waiting_on'")) {
    const { questionId, ...kept } = JSON.parse(String(row.body)) as Record<string, unknown>;
    if (questionId !== undefined) db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(kept), String(row.id));
  }
}
