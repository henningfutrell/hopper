// Tenant migration 11 (issue #314): no job runs with its machine's home as its work tree. A stored work
// tree that is the home itself — `~` as an executor's `cwd`, a job source's `defaultCwd` or a
// `repoPaths` value — becomes the jobs directory `~/hopper-jobs`, so the jobs it sent to the home run
// below it instead of failing. Every other value and option stays.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at10(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 10);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 11: a work tree stored as the home becomes the jobs directory', () => {
  it('moves ~ in executor cwd, source defaultCwd and repoPaths to ~/hopper-jobs; leaves every other value', () => {
    const raw = at10({
      version: 1,
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '~', yolo: true } },
        { name: 'cursor', plugin: 'cursor-agent', options: { cwd: '~/' } },
        { name: 'kept', plugin: 'herdr-claude', options: { cwd: '/srv/jobs' } },
        { name: 'defaults', plugin: 'herdr-claude' },
        { name: 'cmd', plugin: 'command', options: { cwd: '~' } },
      ],
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { authors: ['a'], defaultCwd: '~', repoPaths: { 'o/home': '~', 'o/app': '~/code/app' } } },
        { name: 'app', plugin: 'github-app', options: { authors: ['a'], defaultCwd: '~/work' } },
      ],
    });
    migrateTenant(raw, 11);
    expect(plugins(raw)).toEqual({
      version: 1,
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '~/hopper-jobs', yolo: true } },
        { name: 'cursor', plugin: 'cursor-agent', options: { cwd: '~/hopper-jobs' } },
        { name: 'kept', plugin: 'herdr-claude', options: { cwd: '/srv/jobs' } },
        { name: 'defaults', plugin: 'herdr-claude' },
        { name: 'cmd', plugin: 'command', options: { cwd: '~' } },
      ],
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { authors: ['a'], defaultCwd: '~/hopper-jobs', repoPaths: { 'o/home': '~/hopper-jobs', 'o/app': '~/code/app' } } },
        { name: 'app', plugin: 'github-app', options: { authors: ['a'], defaultCwd: '~/work' } },
      ],
    });
    raw.close();
  });

  it('a user with no plugins config, or none naming a work tree: nothing changes', () => {
    const none = at10();
    migrateTenant(none, 11);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    const raw = at10({ version: 1, jobSources: [] });
    migrateTenant(raw, 11);
    expect(plugins(raw)).toEqual({ version: 1, jobSources: [] });
    raw.close();
  });
});
