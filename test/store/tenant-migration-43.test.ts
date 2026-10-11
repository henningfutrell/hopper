// Tenant migration 43 (issue #427): the GitHub watches table, one row per pointed job, written again at each poll. A
// table only, so the build before runs on it.
import { describe, expect, it } from 'vitest';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

describe('tenant migration 43: GitHub watches', () => {
  it('adds the GitHub watches table, one row per pointed job', () => {
    const raw = t.tenantAt(t.url(), 42);
    migrateTenant(raw, 43);
    expect(raw.all('SELECT * FROM github_watches')).toEqual([]);
    raw.run('INSERT INTO github_watches (pointed_job, body) VALUES (?, ?)', 'p1', '{}');
    expect(() => raw.run('INSERT INTO github_watches (pointed_job, body) VALUES (?, ?)', 'p1', '{}')).toThrow();
    raw.close();
  });
});
