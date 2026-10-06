// Tenant migration 8 (issue #214): a user's connected accounts get their table, and every user's
// plugins config runs a job source for it: `github-account` is added to `jobSources`, paused until the
// user connects that account. Everything else stays; a config that
// already has them, or names no job sources (the built-in ones apply), is left as it is.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at7(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 7);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;
const ACCOUNTS = [{ name: 'github-account', plugin: 'github-account' }];

describe('tenant migration 8: connected accounts, and a job source for each', () => {
  it('adds the github-account job source after the ones there; the rest stays', () => {
    const raw = at7({
      version: 1,
      jobSources: [{ name: 'github', plugin: 'github-gh', options: { enabled: 'auto', authors: ['someone'] } }],
      executors: [{ name: 'test', plugin: 'test' }],
    });
    migrateTenant(raw, 8);
    expect(plugins(raw)).toEqual({
      version: 1,
      jobSources: [{ name: 'github', plugin: 'github-gh', options: { enabled: 'auto', authors: ['someone'] } }, ...ACCOUNTS],
      executors: [{ name: 'test', plugin: 'test' }],
    });
    expect(raw.all('SELECT * FROM connected_accounts')).toEqual([]);
    raw.close();
  });

  it('adds it only when missing; a name taken by another plugin is not reused', () => {
    const kept = at7({ version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account', options: { label: 'x' } }] });
    migrateTenant(kept, 8);
    expect(plugins(kept).jobSources).toEqual([{ name: 'github-account', plugin: 'github-account', options: { label: 'x' } }]);
    kept.close();
    const taken = at7({ version: 1, jobSources: [{ name: 'github-account', plugin: 'github-gh' }] });
    migrateTenant(taken, 8);
    expect(plugins(taken).jobSources).toEqual([{ name: 'github-account', plugin: 'github-gh' }]);
    taken.close();
  });

  it('leaves a config without job sources, and a store without a config, as they are', () => {
    const none = at7({ version: 1, executors: [] });
    migrateTenant(none, 8);
    expect(plugins(none)).toEqual({ version: 1, executors: [] });
    none.close();
    const empty = at7();
    migrateTenant(empty, 8);
    expect(empty.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    empty.close();
  });
});
