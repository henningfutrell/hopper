// Tenant migration 37 (issue #747): a comment is no change of an item's text. A job held only because its item got new
// comments — its title and body still the snapshot's — loses its text change, and the decider judges it as any other
// waiting job. A hold for an edited title or body stays. The build before runs on it: it holds such a job again only
// when its item is read with the comments.
import { sameAsk, type TextChange } from '../domain/item-snapshots.ts';
import type { Db } from './db.ts';

export function commentHoldsReleased(db: Db): void {
  for (const row of db.all("SELECT id, body FROM jobs WHERE body LIKE '%\"textChange\"%'")) {
    const job = JSON.parse(String(row.body)) as { textChange?: TextChange };
    if (!job.textChange || !sameAsk(job.textChange.from, job.textChange.to)) continue;
    delete job.textChange;
    db.run('UPDATE jobs SET body = ? WHERE id = ?', JSON.stringify(job), String(row.id));
  }
}
