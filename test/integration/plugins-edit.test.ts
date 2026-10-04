// Phase 5 slice 7 (issue #6): every plugin instance has its own options, editable from the UI
// through POST /ui/api/plugins — except its command-bearing options, which stay file-only. One
// edit touches one instance's section of plugins.yaml and nothing else (design.md "UI and mutation").
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(pluginsYaml?: string, before?: (dataDir: string) => void): Promise<{ a: TestApp; token: string; file: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const dataDir = dirname(db.dbPath);
  const file = join(dataDir, 'plugins.yaml');
  if (pluginsYaml !== undefined) writeFileSync(file, pluginsYaml, { mode: 0o600 });
  before?.(dataDir);
  t = await startTestApp({ dbPath: db.dbPath, realRouter: true });
  return { a: t, token: await t.login(), file };
}

const report = async (a: TestApp) => (await a.api('GET', '/api/plugins')).body;
const read = (file: string) => readFileSync(file, 'utf8');

/** An unavailable router plugin, so selecting it can be refused whatever this machine has. */
const UNAVAILABLE_ROUTER = `export default {
  id: 'never-here', role: 'router', describe: 'never available',
  async detect() { return { status: 'unavailable', reason: 'not on this machine' }; },
  create() { throw new Error('unreachable'); },
};
`;
const writePlugin = (dataDir: string, id: string, text: string) => {
  mkdirSync(join(dataDir, 'plugins', id), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'plugins', id, 'index.js'), text);
};

const TWO_EXECUTORS = `version: 1
# the owner's note: kept across UI edits
assessor: { name: fable, plugin: claude-cli-assessor, options: { model: fable } }
executors:
  - { name: herdr-a, plugin: herdr-claude, options: { session: hopper-a, pollMs: 1000 } }
  - { name: herdr-b, plugin: herdr-claude, options: { session: hopper-b, pollMs: 1000 } }
  - { name: test, plugin: test }
`;

describe('GET /api/plugins: what the UI edits', () => {
  it('carries the file version and every configured instance by role', async () => {
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

  it('with no plugins.yaml the version says so', async () => {
    const { a } = await start();
    expect((await report(a)).config.version).toBe('missing');
  });
});

describe('POST /ui/api/plugins — one instance\'s options', () => {
  it('without a UI session: 403, file unchanged', async () => {
    const { a, file } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version });
    expect(r.status).toBe(403);
    expect(read(file)).toBe(TWO_EXECUTORS);
  });

  it('a live role: the assessor swaps to the new options; other sections and comments stay; mode 600', async () => {
    const { a, token, file } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<any>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.assessor.instance).toEqual({ name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'sonnet' } });
    expect(r.body.config.version).not.toBe(version);
    const text = read(file);
    expect(text).toContain("# the owner's note: kept across UI edits");
    const doc = parse(text);
    expect(doc.assessor.options).toEqual({ model: 'sonnet' });
    expect(doc.executors).toEqual(parse(TWO_EXECUTORS).executors);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('one executor instance: only its own entry changes; restart pending', async () => {
    const { a, token, file } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<any>('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-b', options: { session: 'hopper-b', pollMs: 250 }, version,
    }, { token });
    expect(r.status).toBe(200);
    const doc = parse(read(file));
    expect(doc.executors[0]).toEqual({ name: 'herdr-a', plugin: 'herdr-claude', options: { session: 'hopper-a', pollMs: 1000 } });
    expect(doc.executors[1]).toEqual({ name: 'herdr-b', plugin: 'herdr-claude', options: { session: 'hopper-b', pollMs: 250 } });
    expect(doc.executors[2]).toEqual({ name: 'test', plugin: 'test' });
    expect(r.body.executors.pending.status).toBe('changed — restart pending');
  });

  it('a command-bearing option that differs: 409 naming it, nothing written', async () => {
    const { a, token, file } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<any>('/ui/api/plugins', {
      action: 'options', role: 'executor', name: 'herdr-a', options: { session: 'hopper-a', pollMs: 1000, cwd: '/tmp/elsewhere' }, version,
    }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cwd/);
    expect(r.body.error).toMatch(/plugins\.yaml/);
    expect(read(file)).toBe(TWO_EXECUTORS);
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
    const { a, token, file } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui<any>('/ui/api/plugins', { action: 'options', role: 'executor', name: 'herdr-a', options: { session: 'default' }, version }, { token });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/session/);
    expect(read(file)).toBe(TWO_EXECUTORS);
  });

  it('a stale version (the file changed since the form was read): 409, nothing written', async () => {
    const { a, token, file } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const edited = TWO_EXECUTORS.replace('model: fable', 'model: opus');
    writeFileSync(file, edited, { mode: 0o600 });
    const r = await a.ui<any>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/changed/);
    expect(read(file)).toBe(edited);
  });

  it('an instance that is not configured: 404', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    const version = (await report(a)).config.version;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'executor', name: 'nope', options: {}, version }, { token });
    expect(r.status).toBe(404);
  });

  it('no plugins.yaml: the edit writes one with version 1 and that section only, mode 600', async () => {
    const { a, token, file } = await start();
    const r = await a.ui<any>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'haiku' }, version: 'missing' }, { token });
    expect(r.status).toBe(200);
    const doc = parse(read(file));
    expect(Object.keys(doc).sort()).toEqual(['assessor', 'version']);
    expect(doc.assessor).toMatchObject({ name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'haiku' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.body.config.source).toBe('file');
  });

  it('an invalid plugins.yaml is not edited from the UI: 409', async () => {
    const { a, token, file } = await start('version: 1\nrouter: [nonsense\n');
    const version = (await report(a)).config.version;
    const r = await a.ui<any>('/ui/api/plugins', { action: 'options', role: 'assessor', name: 'fable', options: { model: 'sonnet' }, version }, { token });
    expect(r.status).toBe(409);
    expect(read(file)).toBe('version: 1\nrouter: [nonsense\n');
  });
});

describe('POST /ui/api/plugins — select a plugin for a one-instance role', () => {
  it('the assessor: an available plugin takes the slot under its own name; the answerer: none', async () => {
    const { a, token, file } = await start(TWO_EXECUTORS);
    let version = (await report(a)).config.version;
    let r = await a.ui<any>('/ui/api/plugins', { action: 'select', role: 'assessor', plugin: 'always-escalate', version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.assessor).toMatchObject({ instance: { name: 'always-escalate', plugin: 'always-escalate' }, active: 'always-escalate', fallback: false });
    expect(parse(read(file)).executors).toEqual(parse(TWO_EXECUTORS).executors);

    version = r.body.config.version;
    r = await a.ui<any>('/ui/api/plugins', { action: 'select', role: 'answerer', plugin: null, version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.answerer).toMatchObject({ instance: null, active: null });
    expect(parse(read(file)).answerer).toBeNull();
  });

  it('refused: a plugin that is not available here (409), of another role (409), unknown (404); none for the assessor (400)', async () => {
    const { a, token, file } = await start(TWO_EXECUTORS, (d) => writePlugin(d, 'never-here', UNAVAILABLE_ROUTER));
    const version = (await report(a)).config.version;
    const sel = (role: string, plugin: string | null) => a.ui<any>('/ui/api/plugins', { action: 'select', role, plugin, version }, { token });
    expect((await sel('router', 'never-here')).status).toBe(409);
    expect((await sel('router', 'always-escalate')).status).toBe(409);
    expect((await sel('router', 'no-such-plugin')).status).toBe(404);
    expect((await sel('assessor', null)).status).toBe(400);
    expect(read(file)).toBe(TWO_EXECUTORS);
  });
});

describe('POST /ui/api/plugins — rescan', () => {
  it('a custom plugin added after start appears in the catalogue', async () => {
    const { a, token } = await start(TWO_EXECUTORS);
    expect((await report(a)).plugins.some((p: { id: string }) => p.id === 'never-here')).toBe(false);
    writePlugin(a.dataDir, 'never-here', UNAVAILABLE_ROUTER);
    const r = await a.ui<any>('/ui/api/plugins', { action: 'rescan' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.plugins.find((p: { id: string }) => p.id === 'never-here')).toMatchObject({ role: 'router', detection: { status: 'unavailable' } });
  });
});
