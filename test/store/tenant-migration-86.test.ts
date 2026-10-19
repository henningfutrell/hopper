// Tenant migration 86 (issue #2113): a job of a GitHub source made with no origin after migration 85 ran — its item was
// offered with none, as for an issue whose job had not ended when the sync judged origins — was stamped `untrusted`
// (`origin:none`), and no request card and no approval let it go on. It waits for its issue's origin now
// (`originPending`), so the next sync judges it and stamps it again, or opens its request card in Intake. A job with an
// origin, a job a job made, a job of another source and an ended job are left.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function job(id: string, status: string, kind: string, o: { origin?: string; followOn?: boolean; pending?: boolean } = {}) {
  return {
    id, status, priority: 50, approved: false, attempts: 0, createdAt: '2026-10-19T09:00:00.000Z', updatedAt: '2026-10-19T09:00:00.000Z',
    spec: { executor: 'herdr-claude', payload: { body: 'b' }, goal: 'Do it' },
    source: { source: kind, kind, key: `https://github.com/o/r/issues/${id}`, ...(o.origin ? { origin: o.origin } : {}) },
    stamp: { level: 'untrusted', reasons: ['origin:none'], by: 'intake', at: '2026-10-19T09:00:00.000Z', mac: 'm' },
    ...(o.followOn ? { followOn: { jobId: 'p' } } : {}), ...(o.pending ? { originPending: true } : {}),
  };
}

describe('tenant migration 86: a job made with no origin after 85 waits for it', () => {
  it('marks the jobs of a GitHub source with no origin that have not ended; leaves every other job', () => {
    const raw = t.tenantAt(t.url(), 85);
    const jobs = [
      job('1', 'held', 'github-account'),
      job('2', 'queued', 'github-account'),
      job('3', 'held', 'github-account', { origin: 'approved' }),
      job('4', 'held', 'github-account', { followOn: true }),
      job('5', 'cancelled', 'github-account'),
      job('6', 'held', 'gitlab-account'),
      job('7', 'held', 'github-account', { pending: true }),
    ];
    for (const j of jobs) raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', j.id, j.status, j.createdAt, j.source.key, JSON.stringify(j));
    migrateTenant(raw, 86);
    const body = (id: string) => JSON.parse(String(raw.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;
    for (const id of ['1', '2']) expect(body(id)).toEqual({ ...jobs[Number(id) - 1], originPending: true });
    for (const id of ['3', '4', '5', '6', '7']) expect(body(id)).toEqual(jobs[Number(id) - 1]);
    raw.close();
  });
});
