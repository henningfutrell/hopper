// Tenant migration 30 (issue #579): done is always a pull request ready for review, so the GitHub sources'
// `completion` option goes from every github-account and github-app instance. Yolo mode is not set from it.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at29(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 29);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 30: no completion option', () => {
  it('drops completion from every GitHub source instance; other options, other plugins and the settings stay', () => {
    const raw = at29({
      version: 1,
      jobSources: [
        { name: 'github-account', plugin: 'github-account', options: { label: 'work', completion: 'merge' } },
        { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's', completion: 'pull-request' } },
        { name: 'other', plugin: 'custom', options: { completion: 'kept' } },
      ],
    });
    migrateTenant(raw, 30);
    expect(plugins(raw)).toEqual({
      version: 1,
      jobSources: [
        { name: 'github-account', plugin: 'github-account', options: { label: 'work' } },
        { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's' } },
        { name: 'other', plugin: 'custom', options: { completion: 'kept' } },
      ],
    });
    expect(raw.get("SELECT value FROM settings WHERE key = 'yoloMode'")).toBeUndefined();
    raw.close();
  });

  it('a config with no completion, or none at all: nothing changes', () => {
    const doc = { version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account' }] };
    const raw = at29(doc);
    migrateTenant(raw, 30);
    expect(plugins(raw)).toEqual(doc);
    raw.close();
    const none = at29();
    migrateTenant(none, 30);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
  });
});
