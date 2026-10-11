// Tenant migration 39 (issue #652, the backfill): a job of a GitHub source queued before origins were judged has no
// origin; it waits for its issue's origin (`originPending`), and the next sync judges it. A job with an origin, a job of
// another source, and a job that started or ended are left as they are.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function job(id: string, status: string, kind: string, o: { origin?: string } = {}) {
  return {
    id, status, priority: 50, approved: false, attempts: 0, createdAt: '2026-10-10T09:00:00.000Z', updatedAt: '2026-10-10T09:00:00.000Z',
    spec: { executor: 'herdr-claude', payload: { body: 'b' }, goal: 'Do it' },
    source: { source: kind, kind, key: `https://github.com/o/r/issues/${id}`, ...(o.origin ? { origin: o.origin } : {}) },
  };
}

describe('tenant migration 39: queued jobs wait for their origin', () => {
  it('marks the queued and held jobs of a GitHub source with no origin; leaves every other job', () => {
    const raw = t.tenantAt(t.url(), 38);
    const jobs = [
      job('1', 'queued', 'github-account'),
      job('2', 'held', 'github-app'),
      job('3', 'queued', 'github'),
      job('4', 'queued', 'github-account', { origin: 'trusted' }),
      job('5', 'running', 'github-account'),
      job('6', 'failed', 'github-account'),
      job('7', 'queued', 'manual'),
    ];
    for (const j of jobs) raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)', j.id, j.status, j.createdAt, j.source.key, JSON.stringify(j));
    migrateTenant(raw, 39);
    const body = (id: string) => JSON.parse(String(raw.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as Record<string, unknown>;
    for (const id of ['1', '2', '3']) expect(body(id)).toEqual({ ...jobs[Number(id) - 1], originPending: true });
    for (const id of ['4', '5', '6', '7']) expect(body(id)).toEqual(jobs[Number(id) - 1]);
    raw.close();
  });
});
