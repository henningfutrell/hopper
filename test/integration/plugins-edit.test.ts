// Phase 5 slice 7 (issue #6): every plugin instance has its own options, editable from the UI
// through POST /ui/api/plugins — except its command-bearing options, which stay in the document (edited by
// hand: `hopper config edit plugins.yaml`). One
// edit touches one instance's section of plugins.yaml and nothing else (design.md "UI and mutation").
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePluginsYaml, type TestApp } from '../support/app.ts';
import { readDocument } from '../support/files.ts';

/** A POST /ui/api/plugins answer: the new report, or `{ error }`. */
type Reply = PluginsReport & { error: string };

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(pluginsYaml?: string, before?: (dataDir: string) => void): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (pluginsYaml !== undefined) writePluginsYaml(db.dbPath, pluginsYaml);
  before?.(dirname(db.dbPath));
  t = await startTestApp({ dbPath: db.dbPath, realRouter: true });
  return { a: t, token: await t.login() };
}

const report = async (a: TestApp) => (await a.api('GET', '/api/plugins')).body;
const read = (a: TestApp) => readDocument(a.dbPath, 'plugins.yaml')!;

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

const TWO_EXECUTORS = `version: 1
# The owner's note: kept across UI edits
assessor: { name: fable, plugin: claude-cli-assessor, options: { model: fable } }
executors:
  - { name: herdr-a, plugin: herdr-claude, options: { session: hopper-a, pollMs: 1000 } }
  - { name: herdr-b, plugin: herdr-claude, options: { session: hopper-b, pollMs: 1000 } }
  - { name: test, plugin: test }
`;

describe('GET /api/plugins: what the UI edits', () => {
  it('carries the document version and every configured instance by role', async () => {
    const { a } = await start(TWO_EXECUTORS);
    const body = await report(a);
    expect(body.config.version).toMatch(/^[0-9a-f]{64}$/);
    const names = body.instances.map((i: { role: string; instance: { name: string } }) => `${i.role}:${i.instance.name}`);
    expect(names).toEqual(expect.arrayContaining(['assessor:fable', 'executor:herdr-a', 'executor:herdr-b', 'executor:test']));
    expect(names.some((n: string) => n.startsWith('router:'))).toBe(true);
    const herdr = body.plugins.find((p: { id: string }) => p.id === 'herdr-claude');
    expect(herdr.options.properties.cwd.commandBearing).toBe(true);
    expect(herdr.options.properties.pollMs.commandBearing).toBeUndefined();
  });

  it('the version is the sha-256 of the document the boot keeps or writes', async () => {
    const { a } = await start();
    expect((await report(a)).config.version).toBe(createHash('sha256').update(read(a)).digest('hex'));
  });
});

describe('POST /ui/api/plugins — one instance\'s options', () => {
  it('without a UI session: 403, document unchanged', async () => {
    const { a } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version });
    expect(r.status).toBe(403);
    expect(read(a)).toBe(TWO_EXECUTORS);
  });

  it('a live role: the assessor swaps to the new options; other sections and comments stay', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.assessor.instance).toEqual({ name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'sonnet' } });
    expect(r.body.config.version).not.toBe(version);
    const text = read(a);
    expect(text).toContain("# The owner's note: kept across UI edits");
    const doc = parse(text);
    expect(doc.assessor.options).toEqual({ model: 'sonnet' });
    expect(doc.executors).toEqual(parse(TWO_EXECUTORS).executors);
  });

  it('one executor instance: only its own entry changes; restart pending', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-b', options: { session: 'hopper-b', pollMs: 250 }, version,
    }, { token });
    expect(r.status).toBe(200);
    const text = read(a);
    expect(text).toContain('  - { name: herdr-a, plugin: herdr-claude, options: { session: hopper-a, pollMs: 1000 } }\n');
    expect(text).toContain('  - { name: test, plugin: test }\n');
    const doc = parse(text);
    expect(doc.executors[0]).toEqual({ name: 'herdr-a', plugin: 'herdr-claude', options: { session: 'hopper-a', pollMs: 1000 } });
    expect(doc.executors[1]).toEqual({ name: 'herdr-b', plugin: 'herdr-claude', options: { session: 'hopper-b', pollMs: 250 } });
    expect(doc.executors[2]).toEqual({ name: 'test', plugin: 'test' });
    expect(r.body.executors.pending?.status).toBe('changed — restart pending');
  });

  it('a machine instance: its lane count is edited in place and applies live (issue #18)', async () => {
    const { a, token } = await start(`${TWO_EXECUTORS}machines: [ { name: local, plugin: local, options: { lanes: 4 } } ]\n`);
    const body = await report(a);
    expect(body.instances).toEqual(expect.arrayContaining([{ role: 'machine-source', instance: { name: 'local', plugin: 'local', options: { lanes: 4 } } }]));
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'machine-source', name: 'local', options: { lanes: 2 }, version: body.config.version }, { token });
    expect(r.status).toBe(200);
    const doc = parse(read(a));
    expect(doc.machines).toEqual([{ name: 'local', plugin: 'local', options: { lanes: 2 } }]);
    expect(doc.executors).toHaveLength(3);
    expect(r.body.machines.pending).toBeUndefined();
    const local = (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'local');
    expect(local.maxLanes).toBe(2);
  });

  it('a command-bearing option that differs: 409 naming it, nothing written', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-a', options: { session: 'hopper-a', pollMs: 1000, cwd: '/tmp/elsewhere' }, version,
    }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cwd/);
    expect(r.body.error).toMatch(/plugins\.yaml/);
    expect(r.body.error).toMatch(/hopper config edit plugins\.yaml/);
    expect(read(a)).toBe(TWO_EXECUTORS);
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
    expect(read(a)).toBe(TWO_EXECUTORS);
  });

  it('a stale version (the document changed since the form was read): 409, nothing written', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const edited = TWO_EXECUTORS.replace('model: fable', 'model: opus');
    writePluginsYaml(a.dbPath, edited);
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed/);
    expect(read(a)).toBe(edited);
  });

  it('an instance that is not configured: 404', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'executor', name: 'nope', options: {}, version }, { token });
    expect(r.status).toBe(404);
  });

  it('an invalid plugins.yaml is not edited from the UI: 409', async () => {
    const { a, token } = await start('version: 1\nrouter: [nonsense\n');
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version }, { token });
    expect(r.status).toBe(409);
    expect(read(a)).toBe('version: 1\nrouter: [nonsense\n');
  });
});

describe('POST /ui/api/plugins — select a plugin for a one-instance role', () => {
  it('the assessor: an available plugin takes the slot under its own name; the answerer: none', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    let version = (await report(a)).config.version;
    let r = await a.ui<Reply>('/ui/api/plugins', { action: 'select', role: 'assessor', plugin: 'always-escalate', version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.assessor).toMatchObject({ instance: { name: 'always-escalate', plugin: 'always-escalate' }, active: 'always-escalate', fallback: false });
    expect(parse(read(a)).executors).toEqual(parse(TWO_EXECUTORS).executors);

    version = r.body.config.version;
    r = await a.ui<Reply>('/ui/api/plugins', { action: 'select', role: 'answerer', plugin: null, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.answerer).toMatchObject({ instance: null, active: null });
    expect(parse(read(a)).answerer).toBeNull();
  });

  it('refused: a plugin that is not available here (409), of another role (409), unknown (404); none for the assessor (400)', async () => {
    const { a, token } = await start(TWO_EXECUTORS, (d) => writePlugin(d, 'never-here', UNAVAILABLE_ROUTER));
    const version = (await report(a)).config.version;
    const sel = (role: string, plugin: string | null) => a.ui<Reply>('/ui/api/plugins', { action: 'select', role, plugin, version }, { token });
    expect((await sel('router', 'never-here')).status).toBe(409);
    expect((await sel('router', 'always-escalate')).status).toBe(409);
    expect((await sel('router', 'no-such-plugin')).status).toBe(404);
    expect((await sel('assessor', null)).status).toBe(400);
    expect(read(a)).toBe(TWO_EXECUTORS);
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
  it('an executor: appended under its name with the plugin\'s defaults; other entries and comments stay; restart pending', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'executor', plugin: 'test', name: 'test-2', version }, { token });
    expect(r.status).toBe(200);
    const text = read(a);
    expect(text.startsWith(TWO_EXECUTORS)).toBe(true);
    expect(parse(text).executors).toEqual([...parse(TWO_EXECUTORS).executors, { name: 'test-2', plugin: 'test' }]);
    expect(r.body.instances).toEqual(expect.arrayContaining([{ role: 'executor', instance: { name: 'test-2', plugin: 'test', options: {} } }]));
    expect(r.body.executors.pending?.status).toBe('changed — restart pending');
  });

  it('a role with no section: the instances that fill it now are written, then the new one', async () => {
    const { a, token } = await start('version: 1\n');
    const body = await report(a);
    const before = body.instances.filter((i: { role: string }) => i.role === 'executor').map((i: { instance: { name: string } }) => i.instance.name);
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'add', role: 'executor', plugin: 'test', name: 'test-2', version: body.config.version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(a)).executors.map((e: { name: string }) => e.name)).toEqual([...before, 'test-2']);
  });

  it('refused, nothing written: a name taken (409), a plugin of another role (409), unknown (404), not available here (409), a one-instance role (400)', async () => {
    const { a, token } = await start(TWO_EXECUTORS, (d) => writePlugin(d, 'never-here', UNAVAILABLE_EXECUTOR));
    const version = (await report(a)).config.version;
    const add = (role: string, plugin: string, name: string) => a.ui<Reply>('/ui/api/plugins', { action: 'add', role, plugin, name, version }, { token });
    const taken = await add('executor', 'test', 'herdr-a');
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatch(/herdr-a/);
    expect((await add('executor', 'always-escalate', 'x')).status).toBe(409);
    expect((await add('executor', 'no-such-plugin', 'x')).status).toBe(404);
    expect((await add('executor', 'never-here-exec', 'x')).status).toBe(409);
    expect((await add('assessor', 'always-escalate', 'x')).status).toBe(400);
    expect(read(a)).toBe(TWO_EXECUTORS);
  });
});

describe('POST /ui/api/plugins — remove an instance', () => {
  it('an executor: its entry goes, every other line stays; restart pending', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'executor', name: 'herdr-b', version }, { token });
    expect(r.status).toBe(200);
    expect(read(a)).toBe(TWO_EXECUTORS.replace('  - { name: herdr-b, plugin: herdr-claude, options: { session: hopper-b, pollMs: 1000 } }\n', ''));
    expect(r.body.instances.some((i: { instance: { name: string } }) => i.instance.name === 'herdr-b')).toBe(false);
    expect(r.body.executors.pending?.status).toBe('changed — restart pending');
  });

  it('the last job source: the section stays, empty (no jobs come in), never the built-in ones', async () => {
    const { a, token } = await start(`${TWO_EXECUTORS}jobSources:\n  - { name: gh, plugin: github-gh, options: { enabled: false, executor: test } }\n`);
    const version = (await report(a)).config.version;
    const r = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'job-source', name: 'gh', version }, { token });
    expect(r.status).toBe(200);
    expect(parse(read(a)).jobSources).toEqual([]);
  });

  it('refused, nothing written: an executor a job source, routing rule or attached machine names (409), the last executor (400), not configured (404)', async () => {
    const yaml = `${TWO_EXECUTORS}jobSources:
  - { name: gh, plugin: github-gh, options: { enabled: false, executor: test } }
routing:
  - { name: to-a, match: { label: a }, set: { executor: herdr-a } }
machines:
  - { name: local, plugin: local }
  - { name: laptop, plugin: ssh, options: { ssh: laptop, lanes: 1, executors: [herdr-b] } }
`;
    const { a, token } = await start(yaml);
    const version = (await report(a)).config.version;
    const remove = (role: string, name: string) => a.ui<Reply>('/ui/api/plugins', { action: 'remove', role, name, version }, { token });
    for (const [name, by] of [['test', /gh/], ['herdr-a', /to-a/], ['herdr-b', /laptop/]] as const) {
      const r = await remove('executor', name);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(by);
    }
    expect((await remove('executor', 'nope')).status).toBe(404);
    expect(read(a)).toBe(yaml);

    const one = 'version: 1\nexecutors:\n  - { name: test, plugin: test }\n';
    writePluginsYaml(a.dbPath, one);
    const v = (await report(a)).config.version;
    const last = await a.ui<Reply>('/ui/api/plugins', { action: 'remove', role: 'executor', name: 'test', version: v }, { token });
    expect(last.status).toBe(400);
    expect(read(a)).toBe(one);
  });
});
