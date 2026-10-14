// Tenant migration 43 (issue #425): the pointed jobs table. A table only: the jobs a store already has are left as they
// are, and show as pointed jobs through the adapter (src/domain/pointed-jobs.ts), so the build before runs on it.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('tenant migration 43: pointed jobs', () => {
  it('adds the pointed jobs table and leaves the jobs as they are', () => {
    const raw = t.tenantAt(t.url(), 42);
    const body = JSON.stringify({ id: 'j1', status: 'finished' });
    raw.run('INSERT INTO jobs (id, status, created_at, body) VALUES (?, ?, ?, ?)', 'j1', 'finished', '2026-10-11T10:00:00.000Z', body);
    migrateTenant(raw, 43);
    expect(raw.all('SELECT id, status, body FROM jobs')).toEqual([{ id: 'j1', status: 'finished', body }]);
    expect(raw.all('SELECT * FROM pointed_jobs')).toEqual([]);
    raw.run('INSERT INTO pointed_jobs (id, status, created_at, body) VALUES (?, ?, ?, ?)', 'p1', 'queued', '2026-10-11T10:00:00.000Z', '{}');
    expect(raw.get('SELECT status FROM pointed_jobs WHERE id = ?', 'p1')).toEqual({ status: 'queued' });
    raw.close();
  });
});
