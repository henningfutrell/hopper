// Phase 5 slice 7 (issue #6): every plugin instance has its own options, editable from the UI
// through POST /ui/api/plugins — its command-bearing options too (issue #198). One edit touches one
// instance's section of the plugins config and nothing else (design.md "UI and mutation").
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';

/** A POST /ui/api/plugins answer: the new report, or `{ error }`. */
type Reply = PluginsReport & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(plugins?: object, before?: (dataDir: string) => void): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (plugins !== undefined) writePlugins(db.dbPath, plugins);
  before?.(dirname(db.dbPath));
  t = await startTestApp({ dbPath: db.dbPath, realRouter: true });
  return { a: t, token: await t.login() };
}

const report = async (a: TestApp) => (await a.api('GET', '/api/plugins')).body;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON
const read = (a: TestApp) => readConfig(a.dbPath, 'plugins') as any;

/** An unavailable router plugin, so selecting it can be refused whatever this machine has. */
const UNAVAILABLE_ROUTER = `export default {
  id: 'never-here', role: 'router', describe: 'never available',
  async detect() { return { status: 'unavailable', reason: 'not on this machine' }; },
  create() { throw new Error('unreachable'); },
};
`;
/** An unavailable executor plugin, so adding one can be refused whatever this machine has. */
const UNAVAILABLE_EXECUTOR = `export default {
  id: 'never-here-exec', role: 'executor', describe: 'never available',
  async detect() { return { status: 'unavailable', reason: 'not on this machine' }; },
  create() { throw new Error('unreachable'); },
};
`;
const writePlugin = (dataDir: string, id: string, text: string) => {
  mkdirSync(join(dataDir, 'plugins', id), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'plugins', id, 'index.js'), text);
};

const TWO_EXECUTORS = { version: 1, escalationLevels: [{ name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'local' } }], executors: [{ name: 'herdr-a', plugin: 'herdr-claude', options: { session: 'hopper-a', pollMs: 1000 } }, { name: 'herdr-b', plugin: 'herdr-claude', options: { session: 'hopper-b', pollMs: 1000 } }, { name: 'test', plugin: 'test' }] };

describe('GET /api/plugins: what the UI edits', () => {
  it('carries the config version and every configured instance by role', async () => {
    const { a } = await start(TWO_EXECUTORS);
    const body = await report(a);
    expect(body.config.version).toMatch(/^[0-9a-f]{64}$/);
    const names = body.instances.map((i: { role: string; instance: { name: string } }) => `${i.role}:${i.instance.name}`);
    expect(names).toEqual(expect.arrayContaining(['escalation-level:level-2', 'executor:herdr-a', 'executor:herdr-b', 'executor:test']));
    expect(names.some((n: string) => n.startsWith('router:'))).toBe(true);
    const herdr = body.plugins.find((p: { id: string }) => p.id === 'herdr-claude');
    expect(herdr.options.properties.cwd.commandBearing).toBe(true);
    expect(herdr.options.properties.pollMs.commandBearing).toBeUndefined();
  });

  it('the version is the sha-256 of the plugins config the boot keeps or writes', async () => {
    const { a } = await start();
    expect((await report(a)).config.version).toBe(createHash('sha256').update(JSON.stringify(read(a))).digest('hex'));
  });
});

describe('POST /ui/api/plugins — one instance\'s options', () => {
  it('without a UI session: 403, the plugins config unchanged', async () => {
    const { a } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'level-2', options: { model: 'sonnet', machine: 'local' }, version });
    expect(r.status).toBe(403);
    expect(read(a)).toEqual(TWO_EXECUTORS);
  });

  it('a live role: the escalation level swaps to the new options; other sections stay', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'level-2', options: { model: 'sonnet', machine: 'local' }, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.escalationLevels[0]!.instance).toEqual({ name: 'level-2', plugin: 'claude-cli', options: { model: 'sonnet', machine: 'local' } });
    expect(r.body.config.version).not.toBe(version);
    const doc = read(a);
    expect(doc.escalationLevels[0].options).toEqual({ model: 'sonnet', machine: 'local' });
    expect(doc.executors).toEqual(TWO_EXECUTORS.executors);
  });

  it('one executor instance: only its own entry changes; applied without a restart (issue #142)', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-b', options: { session: 'hopper-b', pollMs: 250 }, version,
    }, { token });
    expect(r.status).toBe(200);
    const doc = read(a);
    expect(doc.executors).toHaveLength(3);
    expect(doc.executors[0]).toEqual({ name: 'herdr-a', plugin: 'herdr-claude', options: { session: 'hopper-a', pollMs: 1000 } });
    expect(doc.executors[1]).toEqual({ name: 'herdr-b', plugin: 'herdr-claude', options: { session: 'hopper-b', pollMs: 250 } });
    expect(doc.executors[2]).toEqual({ name: 'test', plugin: 'test' });
    expect(r.body.executors).not.toHaveProperty('pending');
  });

  it('a machine instance: its lane count is edited in place and applies live (issue #18)', async () => {
    const { a, token } = await start({ ...TWO_EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 4 } }] });
    const body = await report(a);
    expect(body.instances).toEqual(expect.arrayContaining([{ role: 'machine-source', instance: { name: 'local', plugin: 'local', options: { lanes: 4 } } }]));
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'machine-source', name: 'local', options: { lanes: 2 }, version: body.config.version }, { token });
    expect(r.status).toBe(200);
    const doc = read(a);
    expect(doc.machines).toEqual([{ name: 'local', plugin: 'local', options: { lanes: 2 } }]);
    expect(doc.executors).toHaveLength(3);
    const local = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'local');
    expect(local.maxLanes).toBe(2);
  });

  it('a command-bearing option is edited from the UI like any other (issue #198)', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-a', options: { session: 'hopper-a', pollMs: 1000, cwd: '/tmp/elsewhere' }, version,
    }, { token });
    expect(r.status).toBe(200);
    expect(read(a).executors[0]).toEqual({ name: 'herdr-a', plugin: 'herdr-claude', options: { session: 'hopper-a', pollMs: 1000, cwd: '/tmp/elsewhere' } });
  });

  it('an escalation level\'s command-bearing options (bin, sshBin) are edited from the UI (issue #198)', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const options = { model: 'fable', machine: 'local', bin: '/opt/claude/bin/claude', sshBin: '/usr/local/bin/ssh' };
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'level-2', options, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.escalationLevels[0]!.instance).toEqual({ name: 'level-2', plugin: 'claude-cli', options });
    expect(read(a).escalationLevels[0]).toEqual({ name: 'level-2', plugin: 'claude-cli', options });
  });

  it('a command-bearing option sent unchanged (or its default) is accepted', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-a', options: { session: 'hopper-a', pollMs: 500, bin: 'herdr' }, version,
    }, { token });
    expect(r.status).toBe(200);
  });

  it('options the plugin\'s schema refuses: 400 with the issues, nothing written', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'executor', name: 'herdr-a', options: { session: 'default' }, version }, { token });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/session/);
    expect(read(a)).toEqual(TWO_EXECUTORS);
  });

  it('a stale version (the plugins config changed since the form was read): 409, nothing written', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const edited = structuredClone(TWO_EXECUTORS);
    edited.escalationLevels[0]!.options.model = 'opus';
    writePlugins(a.dbPath, edited);
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: 'level-2', options: { model: 'sonnet', machine: 'local' }, version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed/);
    expect(read(a)).toEqual(edited);
  });

  it('an instance that is not configured: 404', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'executor', name: 'nope', options: {}, version }, { token });
    expect(r.status).toBe(404);
  });

  it('an invalid plugins config: an edit that leaves it invalid is refused (400 naming the field), nothing written', async () => {
    const broken = { version: 1, router: 'broken' };
    const { a, token } = await start(broken);
    const body = await report(a);
    const level = body.instances.find((i: { role: string }) => i.role === 'escalation-level').instance;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'escalation-level', name: level.name, options: level.options, version: body.config.version }, { token });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/router/);
    expect(read(a)).toEqual(broken);
  });

  it('an invalid plugins config: an edit that mends it is accepted', async () => {
    const { a, token } = await start({ version: 1, router: 'broken' });
    const body = await report(a);
    const router = body.instances.find((i: { role: string }) => i.role === 'router').instance;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'router', name: router.name, options: {}, version: body.config.version }, { token });
    expect(r.status).toBe(200);
    expect(read(a)).toEqual({ version: 1, router: { name: router.name, plugin: router.plugin } });
  });
});

describe('POST /ui/api/plugins — select a plugin for a one-instance role', () => {
  it('the queue sorter: an available plugin takes the slot under its own name; other sections stay', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'select', role: 'queue-sorter', plugin: 'oldest-first', version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.queueSorter).toMatchObject({ instance: { name: 'oldest-first', plugin: 'oldest-first' }, active: 'oldest-first', fallback: false });
    expect(read(a).executors).toEqual(TWO_EXECUTORS.executors);
  });

  it('refused: a plugin that is not available here (409), of another role (409), unknown (404); none (400); a list role (400)', async () => {
    const { a, token } = await start(TWO_EXECUTORS, (d) => writePlugin(d, 'never-here', UNAVAILABLE_ROUTER));
    const version = (await report(a)).config.version;
    const sel = (role: string, plugin: string | null) => a.ui<Reply>('/ui/api/plugins', { action: 'select', role, plugin, version }, { token });
    expect((await sel('router', 'never-here')).status).toBe(409);
    expect((await sel('router', 'claude-cli')).status).toBe(409);
    expect((await sel('router', 'no-such-plugin')).status).toBe(404);
    expect((await sel('queue-sorter', null)).status).toBe(400);
    expect((await sel('escalation-level', 'claude-cli')).status).toBe(400);
    expect(read(a)).toEqual(TWO_EXECUTORS);
  });
});

describe('POST /ui/api/plugins — rescan', () => {
  it('a custom plugin added after start appears in the catalogue', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    expect((await report(a)).plugins.some((p: { id: string }) => p.id === 'never-here')).toBe(false);
    writePlugin(a.dataDir, 'never-here', UNAVAILABLE_ROUTER);
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'rescan' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.plugins.find((p: { id: string }) => p.id === 'never-here')).toMatchObject({ role: 'router', detection: { status: 'unavailable' } });
  });
});

// Issue #4: an instance of a many-instance role (executor, job source, usage source, notifier) is
// added or removed from the UI. Executors are a restart role: the change waits for a restart.
describe('POST /ui/api/plugins — add an instance', () => {
  it('an executor: appended under its name with the plugin\'s defaults; other entries stay; it runs at once (issue #142)', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'executor', plugin: 'test', name: 'test-2', version }, { token });
    expect(r.status).toBe(200);
    expect(read(a)).toEqual({ ...TWO_EXECUTORS, executors: [...TWO_EXECUTORS.executors, { name: 'test-2', plugin: 'test' }] });
    expect(r.body.instances).toEqual(expect.arrayContaining([{ role: 'executor', instance: { name: 'test-2', plugin: 'test', options: {} } }]));
    expect(r.body.executors).not.toHaveProperty('pending');
    expect((await a.api('GET', '/api/health')).body.executors).toContain('test-2');
  });

  it('a role with no section: the instances that fill it now are written, then the new one', async () => {
    const { a, token } = await start({ version: 1 });
    const body = await report(a);
    const before = body.instances.filter((i: { role: string }) => i.role === 'executor').map((i: { instance: { name: string } }) => i.instance.name);
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'executor', plugin: 'test', name: 'test-2', version: body.config.version }, { token });
    expect(r.status).toBe(200);
    expect(read(a).executors.map((e: { name: string }) => e.name)).toEqual([...before, 'test-2']);
  });

  it('refused, nothing written: a name taken (409), a plugin of another role (409), unknown (404), not available here (409), a one-instance role (400)', async () => {
    const { a, token } = await start(TWO_EXECUTORS, (d) => writePlugin(d, 'never-here', UNAVAILABLE_EXECUTOR));
    const version = (await report(a)).config.version;
    const add = (role: string, plugin: string, name: string) => a.ui<Reply>('/ui/api/plugins', { action: 'add', role, plugin, name, version }, { token });
    const taken = await add('executor', 'test', 'herdr-a');
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/herdr-a/);
    expect((await add('executor', 'claude-cli', 'x')).status).toBe(409);
    expect((await add('executor', 'no-such-plugin', 'x')).status).toBe(404);
    expect((await add('executor', 'never-here-exec', 'x')).status).toBe(409);
    expect((await add('router', 'pass-through', 'x')).status).toBe(400);
    expect(read(a)).toEqual(TWO_EXECUTORS);
  });
});

describe('POST /ui/api/plugins — remove an instance', () => {
  it('an executor: its entry goes, everything else stays; gone at once (issue #142)', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'executor', name: 'herdr-b', version }, { token });
    expect(r.status).toBe(200);
    expect(read(a)).toEqual({ ...TWO_EXECUTORS, executors: TWO_EXECUTORS.executors.filter((e) => e.name !== 'herdr-b') });
    expect(r.body.instances.some((i: { instance: { name: string } }) => i.instance.name === 'herdr-b')).toBe(false);
    expect(r.body.executors).not.toHaveProperty('pending');
  });

  it('the last job source: the section stays, empty (no jobs come in), never the built-in ones', async () => {
    const { a, token } = await start({ ...TWO_EXECUTORS, jobSources: [{ name: 'gh', plugin: 'github-gh', options: { enabled: false, executor: 'test' } }] });
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'job-source', name: 'gh', version }, { token });
    expect(r.status).toBe(200);
    expect(read(a).jobSources).toEqual([]);
  });

  it('refused, nothing written: an executor a job source, routing rule or attached machine names (409), the last executor (400), not configured (404)', async () => {
    const plugins = {
      ...TWO_EXECUTORS,
      jobSources: [{ name: 'gh', plugin: 'github-gh', options: { enabled: false, executor: 'test' } }],
      routing: [{ name: 'to-a', match: { label: 'a' }, set: { executor: 'herdr-a' } }],
      machines: [{ name: 'local', plugin: 'local' }, { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1, executors: ['herdr-b'] } }],
    };
    const { a, token } = await start(plugins);
    const version = (await report(a)).config.version;
    const remove = (role: string, name: string) => a.ui<Reply>('/ui/api/plugins', { action: 'remove', role, name, version }, { token });
    for (const [name, by] of [['test', /gh/], ['herdr-a', /to-a/], ['herdr-b', /laptop/]] as const) {
      const r = await remove('executor', name);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(by);
    }
    expect((await remove('executor', 'nope')).status).toBe(404);
    expect(read(a)).toEqual(plugins);

    const one = { version: 1, executors: [{ name: 'test', plugin: 'test' }] };
    writePlugins(a.dbPath, one);
    const v = (await report(a)).config.version;
    const last = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'executor', name: 'test', version: v }, { token });
    expect(last.status).toBe(400);
    expect(read(a)).toEqual(one);
  });
});
