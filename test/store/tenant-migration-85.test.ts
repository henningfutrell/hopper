// Tenant migration 85 (issue #1974): a job of a GitHub source with no origin that had started when migration 39 ran was
// left by it; the backfill then stamped it `untrusted`, and once it waits again nothing lets it go on. It waits for its
// issue's origin now (`originPending`), whatever its status, so the next sync judges it and stamps it again, or opens its
// request card in Intake. A job with an origin, a job a job made, a job of another source and an ended job are left.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function job(id: string, status: string, kind: string, o: { origin?: string; forkOf?: boolean; pending?: boolean } = {}) {
  return {
    id, status, priority: 50, approved: false, attempts: 1, createdAt: '2026-10-10T09:00:00.000Z', updatedAt: '2026-10-10T09:00:00.000Z',
    spec: { executor: 'herdr-claude', payload: { body: 'b' }, goal: 'Do it' },
    source: { source: kind, kind, key: `https://github.com/o/r/issues/${id}`, ...(o.origin ? { origin: o.origin } : {}) },
    ...(o.forkOf ? { forkOf: { jobId: 'p' } } : {}), ...(o.pending ? { originPending: true } : {}),
  };
}

describe('tenant migration 85: every waiting or started job with no origin waits for it', () => {
  it('marks the jobs of a GitHub source with no origin that have not ended; leaves every other job', () => {
    const raw = t.tenantAt(t.url(), 84);
    const jobs = [
      job('1', 'held', 'github-account'),
      job('2', 'running', 'github-app'),
      job('3', 'waiting_on', 'github'),
      job('4', 'held', 'github-account', { origin: 'trusted' }),
      job('5', 'held', 'github-account', { forkOf: true }),
      job('6', 'failed', 'github-account'),
      job('7', 'held', 'manual'),
      job('8', 'queued', 'github-account', { pending: true }),
    ];
    for (const j of jobs) raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', j.id, j.status, j.createdAt, j.source.key, JSON.stringify(j));
    migrateTenant(raw, 85);
    const body = (id: string) => JSON.parse(String(raw.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;
    for (const id of ['1', '2', '3']) expect(body(id)).toEqual({ ...jobs[Number(id) - 1], originPending: true });
    for (const id of ['4', '5', '6', '7', '8']) expect(body(id)).toEqual(jobs[Number(id) - 1]);
    raw.close();
  });
});
