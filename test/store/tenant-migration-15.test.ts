// Tenant migration 15 (issue #361): a work tree is set per machine. The paths that named no machine — a
// job source's `defaultCwd` and `repoPaths`, an executor's `cwd`, a routing rule's `workTree` without a
// machine — leave the plugins config: the one jobs fell back to becomes the work tree of each machine
// that has none; a repository's own path becomes a routing rule on the one machine there is. Waiting
// jobs keep only a work tree a rule pinned to its machine.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at14(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 14);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;

describe('tenant migration 15: work trees are per machine', () => {
  it('the source default becomes the work tree of each machine without one; the unscoped paths go', () => {
    const raw = at14({
      version: 1,
      machines: [
        { name: 'archbox', plugin: 'ssh', options: { ssh: 'me@host', lanes: 6 } },
        { name: 'kept', plugin: 'local', options: { lanes: 2, workTree: '~/own' } },
        { name: 'box', plugin: 'docker', options: { docker: 'c' } },
      ],
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '/home/owner/exec', trustWorkdir: true } },
        { name: 'cursor', plugin: 'cursor-agent', options: { cwd: '~/cursor', args: [] } },
        { name: 'cmd', plugin: 'command', options: { cwd: '~/cmd' } },
      ],
      jobSources: [
        { name: 'github', plugin: 'github-account', options: { defaultCwd: '/home/owner/work', repoPaths: { 'o/work': '/home/owner/work' } } },
        { name: 'gh', plugin: 'github-account', options: { authors: ['a'], defaultCwd: '/home/owner/other' } },
      ],
    });
    migrateTenant(raw, 15);
    expect(plugins(raw)).toEqual({
      version: 1,
      machines: [
        { name: 'archbox', plugin: 'ssh', options: { ssh: 'me@host', lanes: 6, workTree: '/home/owner/work' } },
        { name: 'kept', plugin: 'local', options: { lanes: 2, workTree: '~/own' } },
        { name: 'box', plugin: 'docker', options: { docker: 'c' } },
      ],
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { trustWorkdir: true } },
        { name: 'cursor', plugin: 'cursor-agent', options: { args: [] } },
        { name: 'cmd', plugin: 'command', options: { cwd: '~/cmd' } },
      ],
      jobSources: [
        { name: 'github', plugin: 'github-account', options: {} },
        { name: 'gh', plugin: 'github-account', options: { authors: ['a'] } },
      ],
    });
    raw.close();
  });

  it('no source default: the executor\'s; the jobs directory itself is no work tree to set', () => {
    const raw = at14({
      machines: [{ name: 'm', plugin: 'ssh', options: { ssh: 'h' } }, { name: 'n', plugin: 'client', options: { client: { key: 'k' } } }],
      executors: [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '~/exec' } }],
    });
    migrateTenant(raw, 15);
    expect(plugins(raw).machines).toEqual([
      { name: 'm', plugin: 'ssh', options: { ssh: 'h', workTree: '~/exec' } },
      { name: 'n', plugin: 'client', options: { client: { key: 'k' }, workTree: '~/exec' } },
    ]);
    const jobsDir = at14({ machines: [{ name: 'm', plugin: 'ssh', options: { ssh: 'h' } }], jobSources: [{ name: 'g', plugin: 'github-account', options: { defaultCwd: '~/hopper-jobs' } }] });
    migrateTenant(jobsDir, 15);
    expect(plugins(jobsDir)).toEqual({ machines: [{ name: 'm', plugin: 'ssh', options: { ssh: 'h' } }], jobSources: [{ name: 'g', plugin: 'github-account', options: {} }] });
    raw.close();
    jobsDir.close();
  });

  it('a repository\'s own path elsewhere: a routing rule pinning it to the one machine there is, after the rules there are', () => {
    const raw = at14({
      machines: [{ name: 'm', plugin: 'ssh', options: { ssh: 'h' } }],
      jobSources: [{ name: 'g', plugin: 'github-account', options: { defaultCwd: '/w', repoPaths: { 'o/app': '/code/app', 'o/w': '/w' } } }],
      routing: [{ name: 'first', match: { label: 'x' }, set: { priority: 90 } }],
    });
    migrateTenant(raw, 15);
    expect(plugins(raw).routing).toEqual([
      { name: 'first', match: { label: 'x' }, set: { priority: 90 } },
      { name: 'g o/app', match: { source: 'g', repo: 'o/app' }, set: { machine: 'm', workTree: '/code/app' } },
    ]);
    raw.close();
  });

  it('a routing rule\'s work tree without a machine: pinned to the one machine there is; with several, the work tree goes', () => {
    const one = at14({ machines: [{ name: 'm', plugin: 'local', options: {} }], routing: [{ name: 'r', match: { repo: 'o/a' }, set: { workTree: '~/a' } }] });
    migrateTenant(one, 15);
    expect(plugins(one).routing).toEqual([{ name: 'r', match: { repo: 'o/a' }, set: { workTree: '~/a', machine: 'm' } }]);
    const two = at14({
      machines: [{ name: 'm', plugin: 'local', options: {} }, { name: 'n', plugin: 'ssh', options: { ssh: 'h' } }],
      routing: [{ name: 'r', match: { repo: 'o/a' }, set: { workTree: '~/a', priority: 80 } }, { name: 'only', match: {}, set: { workTree: '~/b' } }, { name: 'kept', match: {}, set: { machine: 'n', workTree: '~/c' } }],
    });
    migrateTenant(two, 15);
    expect(plugins(two).routing).toEqual([{ name: 'r', match: { repo: 'o/a' }, set: { priority: 80 } }, { name: 'kept', match: {}, set: { machine: 'n', workTree: '~/c' } }]);
    one.close();
    two.close();
  });

  it('a job keeps only a work tree a rule pinned to its machine; a source default leaves every job', () => {
    const raw = at14();
    const spec = (payload: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ executor: 'herdr-claude', payload: { prompt: 'p', ...payload }, ...more });
    const jobs = {
      plain: spec({ cwd: '/home/owner/work', defaultCwd: '/home/owner/work' }),
      ruled: spec({ cwd: '~/a', defaultCwd: '/w' }, { machineId: 'm', routedBy: { rule: 'r', set: { machine: 'm', workTree: '~/a' } } }),
    };
    for (const [id, s] of Object.entries(jobs)) {
      raw.run("INSERT INTO jobs (id, status, created_at, body) VALUES (?, 'queued', 'x', ?)", id, JSON.stringify({ id, status: 'queued', spec: s }));
    }
    migrateTenant(raw, 15);
    const body = (id: string) => JSON.parse(String(raw.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as { spec: { payload: Record<string, unknown> } };
    expect(body('plain').spec.payload).toEqual({ prompt: 'p' });
    expect(body('ruled').spec.payload).toEqual({ prompt: 'p', cwd: '~/a' });
    raw.close();
  });

  it('a user with no plugins config: nothing changes', () => {
    const none = at14();
    migrateTenant(none, 15);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
  });
});
