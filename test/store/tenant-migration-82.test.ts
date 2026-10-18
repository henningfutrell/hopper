// Tenant migration 82 (issue #1891): each work item keeps its owner, next check and deadline as columns, and the ledger is
// rebuilt, so an item left in PR open with no pull request — a job's end that named none — is blocked on it.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/465';
const KEY2 = 'https://github.com/o/r/issues/466';
const PR = 'https://github.com/o/r/pull/470';

describe('tenant migration 82: the item lifecycle', () => {
  it('an item in PR open with no pull request is blocked on it; one with its pull request keeps PR open, with its owner and deadline', () => {
    const raw = t.tenantAt(t.url(), 81);
    const job = (id: string, key: string, source: Record<string, unknown>) => raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)',
      id, 'finished', '2026-10-13T10:00:00.000Z', key, JSON.stringify({ id, source: { source: 'github', kind: 'github', key }, sourceState: { source } }));
    job('j1', KEY, { follow: 'open' });
    job('j2', KEY2, { follow: 'open', pullRequest: PR });
    let n = 0;
    const event = (type: string, jobId: string) => raw.run('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)', `e${n++}`, type, '2026-10-13T10:00:00.000Z', jobId, '{}');
    for (const id of ['j1', 'j2']) { event('job.queued', id); event('job.finished', id); }
    migrateTenant(raw);
    expect(raw.all('SELECT key, state, owner, next_check_at, deadline FROM work_items ORDER BY key')).toEqual([
      { key: KEY, state: 'blocked', owner: 'person', next_check_at: '2026-10-13T10:05:00.000Z', deadline: null },
      { key: KEY2, state: 'pr_open', owner: 'github_observer', next_check_at: '2026-10-13T10:05:00.000Z', deadline: '2026-10-13T11:00:00.000Z' },
    ]);
    raw.close();
  });
});
