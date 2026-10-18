// Tenant migration 83 (issue #1891): the ledger is rebuilt, so an item whose pull request was closed without a merge on
// GitHub, and whose issue is still open, is blocked on it (`pr_closed`) in place of dropped. A person's Close PR still drops it.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/828';
const KEY2 = 'https://github.com/o/r/issues/829';
const PR = 'https://github.com/o/r/pull/830';
const PR2 = 'https://github.com/o/r/pull/831';

describe('tenant migration 83: a pull request closed without a merge blocks its item', () => {
  it('blocks the item of a pull request closed on GitHub; a person\'s Close PR still drops its item', () => {
    const raw = t.tenantAt(t.url(), 82);
    const job = (id: string, key: string, pullRequest: string) => raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)',
      id, 'finished', '2026-10-13T10:00:00.000Z', key, JSON.stringify({ id, source: { source: 'github', kind: 'github', key }, sourceState: { source: { follow: 'closed', pullRequest } } }));
    job('j1', KEY, PR);
    job('j2', KEY2, PR2);
    let n = 0;
    const event = (type: string, jobId: string, data: Record<string, unknown> = {}) =>
      raw.run('INSERT INTO events (id, type, at, job_id, data) VALUES (?, ?, ?, ?, ?)', `e${n++}`, type, '2026-10-13T10:00:00.000Z', jobId, JSON.stringify(data));
    event('job.queued', 'j1'); event('job.finished', 'j1'); event('job.pull_request_closed', 'j1', { pullRequest: PR, part: false });
    event('job.queued', 'j2'); event('job.finished', 'j2'); event('job.pull_request_closed', 'j2', { pullRequest: PR2, part: false, person: 'owner', via: 'ui' });
    migrateTenant(raw);
    expect(raw.all('SELECT key, state, owner FROM work_items ORDER BY key')).toEqual([
      { key: KEY, state: 'blocked', owner: 'person' },
      { key: KEY2, state: 'dropped', owner: null },
    ]);
    const body = JSON.parse(String(raw.all('SELECT body FROM work_items WHERE key = ?', KEY)[0]!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ blockedCause: 'pr_closed', closedWithoutMerge: 1, pullRequestState: 'closed' });
    raw.close();
  });
});
