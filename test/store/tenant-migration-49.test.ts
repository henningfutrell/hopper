// Tenant migration 49 (issue #901): the direct jobs table, one row per submission. A table only: the jobs a store already
// has are left as they are, so the build before runs on it.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('tenant migration 49: direct jobs', () => {
  it('adds the direct jobs table and leaves the jobs as they are', () => {
    const raw = t.tenantAt(t.url(), 48);
    const body = JSON.stringify({ id: 'j1', status: 'finished' });
    raw.run('INSERT INTO jobs (id, status, created_at, body) VALUES (?, ?, ?, ?)', 'j1', 'finished', '2026-10-12T10:00:00.000Z', body);
    migrateTenant(raw, 49);
    expect(raw.all('SELECT id, status, body FROM jobs')).toEqual([{ id: 'j1', status: 'finished', body }]);
    expect(raw.all('SELECT * FROM direct_jobs')).toEqual([]);
    raw.run('INSERT INTO direct_jobs (id, submitted_at, body) VALUES (?, ?, ?)', 'd1', '2026-10-12T10:00:00.000Z', '{}');
    expect(() => raw.run('INSERT INTO direct_jobs (id, submitted_at, body) VALUES (?, ?, ?)', 'd1', '2026-10-12T10:00:00.000Z', '{}')).toThrow();
    raw.close();
  });
});
