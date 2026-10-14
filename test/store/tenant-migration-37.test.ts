// Tenant migration 37 (issue #747): a comment is no change of an item's text, so a job held only because its item got
// new comments — the title and body as in the snapshot — is held no more. A hold for an edited title or body stays.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const note = (body: string) => ({ author: 'owner', at: '2026-10-10T10:00:00Z', body });
const text = (body: string, comments: ReturnType<typeof note>[] = []) => ({ title: 'Do it', body, comments });

function job(id: string, textChange?: { from: ReturnType<typeof text>; to: ReturnType<typeof text> }) {
  return {
    id, status: 'held', priority: 50, approved: true, attempts: 0, createdAt: '2026-10-10T09:00:00.000Z', updatedAt: '2026-10-10T09:00:00.000Z',
    spec: { executor: 'herdr-claude', payload: { body: 'b' }, goal: 'Do it' },
    source: { source: 'github', kind: 'github', key: `https://github.com/o/r/issues/${id}` },
    ...(textChange ? { textChange: { detectedAt: '2026-10-10T10:00:00.000Z', snapshotHash: 'a'.repeat(64), liveHash: 'b'.repeat(64), edits: [], accepted: { title: 'Do it', body: 'b', prompt: 'b', env: {} }, ...textChange } } : {}),
  };
}

describe('tenant migration 37: a comment holds no job', () => {
  it('drops a text change whose title and body are the snapshot\'s; keeps one with an edit, and jobs with none', () => {
    const raw = t.tenantAt(t.url(), 36);
    const jobs = [
      job('1', { from: text('b'), to: text('b', [note('Status ping.')]) }),
      job('2', { from: text('b', [note('Old.')]), to: text('b edited', [note('Old.'), note('New.')]) }),
      job('3'),
    ];
    for (const j of jobs) raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', j.id, j.status, j.createdAt, j.source.key, JSON.stringify(j));
    migrateTenant(raw, 37);
    const body = (id: string) => JSON.parse(String(raw.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;
    const { textChange: _drop, ...released } = jobs[0]!;
    expect(body('1')).toEqual(released);
    expect(body('2')).toEqual(jobs[1]);
    expect(body('3')).toEqual(jobs[2]);
    raw.close();
  });
});
