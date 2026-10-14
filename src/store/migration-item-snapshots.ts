// Tenant migration 35 (issue #662, design.md "Item snapshots"): the approved text of each source item, and a backfill
// from each item's first job — its title (the spec's goal), its body, and the assignee comments its prompt carried, as
// far as they can be read back. A comment cut short in the prompt reads back short: that item's next job holds until a
// person decides, never runs text nobody approved. A table only: the build before runs on it.
import { textHash, type ItemComment, type ItemSnapshot } from '../domain/item-snapshots.ts';
import type { JobSpec } from '../domain/types.ts';
import type { Db } from './db.ts';

export const ITEM_SNAPSHOT_TABLE = `
  CREATE TABLE item_snapshots (
    seq BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
  )`;

const COMMENTS_HEAD = '\nrecent comments (oldest first';
const COMMENT_LINE = /^- (.+?) at (\S+): (.*)$/;

/** The assignee comments a GitHub job's prompt carried (`contextBlock`), oldest first; none when it names none. */
export function commentsInPrompt(prompt: string): ItemComment[] {
  const at = prompt.lastIndexOf(COMMENTS_HEAD);
  if (at < 0) return [];
  const comments: ItemComment[] = [];
  for (const line of prompt.slice(at + 1).split('\n').slice(1)) {
    const m = COMMENT_LINE.exec(line);
    if (m) comments.push({ author: m[1]!, at: m[2]!, body: m[3]! });
    else if (line.startsWith('  ') && comments.length > 0) comments.at(-1)!.body += `\n${line.slice(2)}`;
    else break;
  }
  return comments;
}

interface StoredJob { id: string; spec: JobSpec; createdAt: string; source?: { key?: string } }

export function itemSnapshotsBackfill(db: Db): void {
  db.exec(ITEM_SNAPSHOT_TABLE);
  const done = new Set<string>();
  for (const row of db.all('SELECT body FROM jobs ORDER BY seq')) {
    const job = JSON.parse(String(row.body)) as StoredJob;
    const key = job.source?.key;
    if (!key || done.has(key)) continue;
    done.add(key);
    const { payload, goal } = job.spec;
    if (typeof payload.body !== 'string' || typeof goal !== 'string') continue;
    const text = { title: goal, body: payload.body, comments: typeof payload.prompt === 'string' ? commentsInPrompt(payload.prompt) : [] };
    const snapshot: ItemSnapshot = { key, ...text, hash: textHash(text), recordedAt: job.createdAt, reason: 'backfill', jobId: job.id };
    db.run('INSERT INTO item_snapshots (key, body) VALUES (?, ?)', key, JSON.stringify(snapshot));
  }
}
