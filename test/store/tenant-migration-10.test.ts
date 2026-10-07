// Tenant migration 10 (issue #321): a connected account's job repositories are the user's setting, read
// at each sync, no longer its job source's options (which apply only at a restart). Repos a github-account
// instance named become the job repositories; `repos` and `owners` leave its options, every other option
// stays. Owners named no repository, so they choose none.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at9(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 9);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;
const chosen = (raw: Db) => raw.get("SELECT value FROM settings WHERE key = 'jobRepositories:github'")?.value;

describe('tenant migration 10: job repositories are the user\'s setting', () => {
  it('moves the repos a github-account instance named into the setting, and drops repos and owners from its options', () => {
    const raw = at9({
      version: 1,
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { authors: ['someone'], repos: ['someone/gh-repo'], owners: ['someone'] } },
        { name: 'github-account', plugin: 'github-account', options: { repos: ['octo/a', 'octo/b'], owners: ['octo'], label: 'work' } },
      ],
    });
    migrateTenant(raw, 10);
    expect(plugins(raw)).toEqual({
      version: 1,
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { authors: ['someone'], repos: ['someone/gh-repo'], owners: ['someone'] } },
        { name: 'github-account', plugin: 'github-account', options: { label: 'work' } },
      ],
    });
    expect(JSON.parse(String(chosen(raw)))).toEqual(['octo/a', 'octo/b']);
    raw.close();
  });

  it('an instance that named no repos chooses none; no plugins config: nothing changes', () => {
    const raw = at9({ version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account', options: { owners: ['octo'] } }, { name: 'plain', plugin: 'github-account' }] });
    migrateTenant(raw, 10);
    expect(plugins(raw)).toEqual({ version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account', options: {} }, { name: 'plain', plugin: 'github-account' }] });
    expect(chosen(raw)).toBeUndefined();
    raw.close();
    const none = at9();
    migrateTenant(none, 10);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    expect(chosen(none)).toBeUndefined();
    none.close();
  });
});
