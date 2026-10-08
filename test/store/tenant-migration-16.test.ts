// Tenant migration 16 (issue #387): intake is by label and assignee, so the GitHub sources' `authors`
// option goes from every github-account and github-app instance. Nothing else changes.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at15(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 15);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 16: no authors option', () => {
  it('drops authors from every GitHub source instance; other options and other plugins stay', () => {
    const raw = at15({
      version: 1,
      jobSources: [
        { name: 'github-account', plugin: 'github-account', options: { label: 'work', authors: ['someone'] } },
        { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's', authors: ['someone'] } },
        { name: 'other', plugin: 'custom', options: { authors: ['kept'] } },
      ],
    });
    migrateTenant(raw, 16);
    expect(plugins(raw)).toEqual({
      version: 1,
      jobSources: [
        { name: 'github-account', plugin: 'github-account', options: { label: 'work' } },
        { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's' } },
        { name: 'other', plugin: 'custom', options: { authors: ['kept'] } },
      ],
    });
    raw.close();
  });

  it('a config with no authors, or none at all: nothing changes', () => {
    const doc = { version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account' }] };
    const raw = at15(doc);
    migrateTenant(raw, 16);
    expect(plugins(raw)).toEqual(doc);
    raw.close();
    const none = at15();
    migrateTenant(none, 16);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
  });
});
