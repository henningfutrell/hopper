// Tenant migration 35 (issue #662): the item snapshots table, backfilled from each item's first job — its title (the
// spec's goal), its body and the assignee comments its prompt carried. A job of no source item, or one whose spec lacks
// them, gives none. Only a table is added: the build before still runs on the store.
import { describe, expect, it } from 'vitest';
import { textHash, type ItemSnapshot } from '../../src/domain/item-snapshots.ts';
import { contextBlock, issuePrompt } from '../../src/sources/github/context.ts';
import { commentsInPrompt } from '../../src/store/migration-item-snapshots.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const URL_A = 'https://github.com/o/r/issues/1';
const URL_B = 'https://github.com/o/r/issues/2';
const issue = { repo: 'o/r', number: 1, url: URL_A, title: 'Do it', body: 'The body.\nTwo lines.', author: 'owner', assignees: ['owner'], labels: ['hopper'], state: 'open' as const, updatedAt: '' };
const comments = [
  { id: 1, author: 'owner', body: 'First note.', createdAt: '2026-10-01T10:00:00Z', url: '' },
  { id: 2, author: 'owner', body: 'Second note,\nover two lines.', createdAt: '2026-10-01T11:00:00Z', url: '' },
];
const prompt = issuePrompt(issue, contextBlock(issue, { priority: 50, reason: 'default', projectItem: 'none' }, false, comments, 10));

function job(id: string, o: { key?: string; goal?: string; body?: string; prompt?: string; createdAt?: string }) {
  return JSON.stringify({
    id, status: 'failed', priority: 50, approved: false, attempts: 1, createdAt: o.createdAt ?? '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
    spec: { executor: 'herdr-claude', payload: { ...(o.body !== undefined ? { body: o.body } : {}), ...(o.prompt !== undefined ? { prompt: o.prompt } : {}) }, ...(o.goal !== undefined ? { goal: o.goal } : {}) },
    ...(o.key ? { source: { source: 'github', kind: 'github', key: o.key } } : {}),
  });
}

const insert = (raw: ReturnType<typeof t.tenantAt>, id: string, body: string) => {
  const j = JSON.parse(body) as { status: string; createdAt: string; source?: { key: string } };
  raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', id, j.status, j.createdAt, j.source?.key ?? null, body);
};

describe('tenant migration 35: item snapshots', () => {
  it('reads the comments a GitHub prompt carried back as they were', () => {
    expect(commentsInPrompt(prompt)).toEqual([
      { author: 'owner', at: '2026-10-01T10:00:00Z', body: 'First note.' },
      { author: 'owner', at: '2026-10-01T11:00:00Z', body: 'Second note,\nover two lines.' },
    ]);
    expect(commentsInPrompt('a body\n\n[hopper issue context]\nrecent comments: none')).toEqual([]);
  });

  it('backfills each item\'s snapshot from its first job; a job of no item or without its text gives none', () => {
    const raw = t.tenantAt(t.url(), 34);
    insert(raw, 'j1', job('j1', { key: URL_A, goal: 'Do it', body: issue.body, prompt, createdAt: '2026-10-01T12:00:00.000Z' }));
    insert(raw, 'j2', job('j2', { key: URL_A, goal: 'Do it, edited', body: 'Edited.', prompt: 'Edited.' }));
    insert(raw, 'j3', job('j3', { body: 'pushed by hand', goal: 'no item' }));
    insert(raw, 'j4', job('j4', { key: URL_B }));
    migrateTenant(raw, 35);
    const rows = raw.all('SELECT key, body FROM item_snapshots ORDER BY seq').map((r) => ({ column: r.key, ...JSON.parse(String(r.body)) as ItemSnapshot }));
    expect(rows).toHaveLength(1);
    const text = { title: 'Do it', body: issue.body, comments: commentsInPrompt(prompt) };
    expect(rows[0]).toEqual({ column: URL_A, key: URL_A, ...text, hash: textHash(text), recordedAt: '2026-10-01T12:00:00.000Z', reason: 'backfill', jobId: 'j1' });
    raw.close();
  });

  it('the build before runs its jobs on the migrated store as it did', () => {
    const raw = t.tenantAt(t.url(), 34);
    migrateTenant(raw, 35);
    insert(raw, 'j9', job('j9', { key: URL_A, goal: 'Do it', body: 'b' }));
    expect(raw.get("SELECT id FROM jobs WHERE id = 'j9'")).toEqual({ id: 'j9' });
    raw.close();
  });
});
