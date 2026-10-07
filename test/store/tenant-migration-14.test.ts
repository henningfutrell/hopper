// Tenant migration 14 (issue #359): the gh CLI job source is gone; the hopper reads GitHub as the user only
// through their connected account. Every github-gh instance leaves `jobSources`; the repos the first one
// named become the job repositories when none are chosen yet; a config left with no github-account
// instance gets one. Every other instance stays.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at13(plugins?: unknown, repositories?: string[]): Db {
  const raw = t.tenantAt(t.url(), 13);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  if (repositories) raw.run("INSERT INTO settings (key, value) VALUES ('jobRepositories:github', ?)", JSON.stringify(repositories));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;
const chosen = (raw: Db) => {
  const v = raw.get("SELECT value FROM settings WHERE key = 'jobRepositories:github'")?.value;
  return v === undefined ? undefined : JSON.parse(String(v)) as string[];
};

describe('tenant migration 14: no gh job source', () => {
  it('drops every github-gh instance; its repos become the job repositories when none are chosen', () => {
    const raw = at13({
      version: 1,
      jobSources: [
        { name: 'github-account', plugin: 'github-account', options: { label: 'work' } },
        { name: 'github', plugin: 'github-gh', options: { enabled: 'auto', authors: ['someone'], repos: ['someone/a', 'someone/b'] } },
        { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's', authors: ['someone'] } },
      ],
    });
    migrateTenant(raw, 14);
    expect(plugins(raw)).toEqual({
      version: 1,
      jobSources: [
        { name: 'github-account', plugin: 'github-account', options: { label: 'work' } },
        { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's', authors: ['someone'] } },
      ],
    });
    expect(chosen(raw)).toEqual(['someone/a', 'someone/b']);
    raw.close();
  });

  it('job repositories already chosen stay; a config left with no github-account instance gets one', () => {
    const raw = at13({ version: 1, jobSources: [{ name: 'github', plugin: 'github-gh', options: { repos: ['someone/a'] } }] }, ['octo/kept']);
    migrateTenant(raw, 14);
    expect(plugins(raw)).toEqual({ version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account' }] });
    expect(chosen(raw)).toEqual(['octo/kept']);
    raw.close();
  });

  it('a config with no github-gh instance, or none at all: nothing changes', () => {
    const doc = { version: 1, jobSources: [{ name: 'plain', plugin: 'github-app' }] };
    const raw = at13(doc);
    migrateTenant(raw, 14);
    expect(plugins(raw)).toEqual(doc);
    expect(chosen(raw)).toBeUndefined();
    raw.close();
    const none = at13();
    migrateTenant(none, 14);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
  });
});
