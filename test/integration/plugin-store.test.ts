// The plugin store through the HTTP edge (issue #75, design.md "Plugin store"): a real git
// repository holding a store catalogue, a real daemon. GET /api/plugin-store reads; POST
// /ui/api/plugin-store refreshes, installs (and updates) and removes, behind an admin UI session.
// Installs are kept in the database (issue #93): their code is unpacked into the work dir, which is
// scratch, and restored from the plugin store at the next start; the plugin dir is never written.
// Installed plugins show in /api/plugins without a restart.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginStoreReport, PluginsReport } from '../../src/domain/types.ts';
import type { AppSeams } from '../../src/main.ts';
import { startTestApp, tempDbPath, writePlugins, TEST_PLUGINS, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { git, tempDir } from '../update/support.ts';
import { createStoreRepo, entry, serveDir } from '../plugin-store/support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

function world() {
  const root = tempDir('jh-plugin-store-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const store = createStoreRepo(root);
  store.addExample('executor', 'echo-executor');
  store.addExample('queue-sorter', 'word-first');
  const first = store.commit('two plugins', [entry('executor', 'echo-executor'), entry('queue-sorter', 'word-first')]);
  const pluginDir = join(db.dbPath, '..', 'plugins');
  return { store, first, db, pluginDir };
}

async function start(w: ReturnType<typeof world>, env: Record<string, string> = { HOPPER_PLUGIN_STORE: w.store.dir }, seams: AppSeams = {}): Promise<TestApp> {
  const app = await startTestApp({ dbPath: w.db.dbPath, env, seams });
  apps.push(app);
  return app;
}

const read = async (app: TestApp) => (await app.api<PluginStoreReport>('GET', '/api/plugin-store')).body;
/** The first read of the store, done in the background at start. */
const ready = (app: TestApp) => waitFor(async () => { const r = await read(app); return r.commit !== undefined || r.error !== undefined; });
const plugin = (r: PluginStoreReport, id: string) => r.plugins.find((p) => p.id === id);

describe('the plugin store over HTTP', () => {
  it('needs no plugin dir: installs are kept in the database', async () => {
    const w = world();
    const app = await start(w, { HOPPER_PLUGIN_STORE: w.store.dir, HOPPER_PLUGIN_DIR: undefined } as unknown as Record<string, string>);
    await ready(app);
    expect((await read(app)).state).toBe('ready');
    const token = await app.login();
    const r = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token });
    expect(r.status).toBe(200);
    expect(plugin(r.body, 'word-first')?.installed).toMatchObject({ commit: w.first });
  });

  it('restores its installs on a fresh work dir from the database setting, with no environment variable, as an ephemeral container starts', async () => {
    const w = world();
    const first = await start(w);
    await ready(first);
    await first.ui('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token: await first.login() });
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    const fresh = tempDir('jh-plugin-store-work-');
    cleanups.push(() => rmSync(fresh, { recursive: true, force: true }));
    const app = await start(w, { HOPPER_WORK_DIR: fresh });
    expect(plugin(await read(app), 'echo-executor')?.installed).toMatchObject({ commit: w.first });
    const plugins = (await app.api<PluginsReport>('GET', '/api/plugins')).body;
    expect(plugins.plugins.find((p) => p.id === 'echo-executor')).toMatchObject({ role: 'executor', builtin: false, detection: { status: 'available' } });
    expect(existsSync(w.pluginDir) ? readdirSync(w.pluginDir) : []).toEqual([]);
  });

  it('moves a store install left in the plugin dir into the database', async () => {
    const w = world();
    const legacy = join(w.pluginDir, 'word-first');
    mkdirSync(w.pluginDir, { recursive: true });
    cpSync(join(w.store.dir, 'plugins', 'word-first'), legacy, { recursive: true });
    const marker = { role: 'queue-sorter', describe: 'the word-first example', commit: w.first, tree: git(w.store.dir, 'rev-parse', `${w.first}:plugins/word-first`), installedAt: '2026-10-01T00:00:00.000Z' };
    writeFileSync(join(legacy, '.plugin-store.json'), JSON.stringify(marker));
    const app = await start(w);
    expect(plugin(await read(app), 'word-first')?.installed).toMatchObject({ commit: w.first, installedAt: marker.installedAt });
    expect(existsSync(legacy)).toBe(false);
    expect((await app.api<PluginsReport>('GET', '/api/plugins')).body.plugins.find((p) => p.id === 'word-first')).toMatchObject({ builtin: false });
  });

  it('lists the catalogue, installs a plugin that then shows in /api/plugins, and removes it', async () => {
    const w = world();
    const app = await start(w);
    await ready(app);
    const listed = await read(app);
    expect(listed).toMatchObject({ state: 'ready', repo: w.store.dir, commit: w.first });
    expect(listed.plugins.map((p) => [p.id, p.role, p.listed, p.installed])).toEqual([
      ['echo-executor', 'executor', true, undefined], ['word-first', 'queue-sorter', true, undefined],
    ]);

    expect((await app.ui('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' })).status).toBe(403);
    const token = await app.login();
    const installed = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token });
    expect(installed.status).toBe(200);
    expect(plugin(installed.body, 'echo-executor')).toMatchObject({ installed: { commit: w.first, current: true }, restartPending: false });
    expect(existsSync(join(w.pluginDir, 'echo-executor'))).toBe(false);

    const plugins = (await app.api<PluginsReport>('GET', '/api/plugins')).body;
    expect(plugins.plugins.find((p) => p.id === 'echo-executor')).toMatchObject({ role: 'executor', builtin: false, detection: { status: 'available' } });

    const removed = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'remove', id: 'echo-executor' }, { token });
    expect(removed.status).toBe(200);
    expect(plugin(removed.body, 'echo-executor')?.installed).toBeUndefined();
    expect((await app.api<PluginsReport>('GET', '/api/plugins')).body.plugins.some((p) => p.id === 'echo-executor')).toBe(false);

    const events = (await app.events()).filter((e) => e.type.startsWith('plugin.'));
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['plugin.installed', { id: 'echo-executor', role: 'executor', commit: w.first }],
      ['plugin.removed', { id: 'echo-executor' }],
    ]);
  });

  it('offers an update only when the plugin changed, and an update waits for a restart', async () => {
    const w = world();
    const app = await start(w);
    await ready(app);
    const token = await app.login();
    await app.ui('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token });

    const untouched = w.store.commit('another plugin changes', [entry('executor', 'echo-executor', 'changed'), entry('queue-sorter', 'word-first')]);
    let r = (await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'refresh' }, { token })).body;
    expect(r.commit).toBe(untouched);
    expect(plugin(r, 'word-first')?.installed).toMatchObject({ commit: w.first, current: true });

    w.store.write('plugins/word-first/NOTES.md', 'a change\n');
    const changed = w.store.commit('word-first changes', [entry('executor', 'echo-executor'), entry('queue-sorter', 'word-first')]);
    r = (await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'refresh' }, { token })).body;
    expect(plugin(r, 'word-first')?.installed).toMatchObject({ commit: w.first, current: false });

    r = (await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token })).body;
    expect(plugin(r, 'word-first')).toMatchObject({ installed: { commit: changed, current: true }, restartPending: true });
  });

  it('refuses to remove a plugin the plugins config names, and to touch a plugin the operator put there by hand', async () => {
    const w = world();
    mkdirSync(join(w.pluginDir, 'word-first'), { recursive: true });
    writeFileSync(join(w.pluginDir, 'word-first', 'index.ts'), "export default { id: 'word-first', role: 'queue-sorter', describe: 'mine', detect: async () => ({ status: 'available' }), create: () => ({ name: 'w', sort: () => [] }) };\n");
    const app = await start(w);
    await ready(app);
    const token = await app.login();

    const own = await app.ui<{ error: string }>('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token });
    expect(own.status).toBe(409);
    expect(own.body.error).toMatch(/plugin dir/);
    expect((await app.ui('/ui/api/plugin-store', { action: 'remove', id: 'word-first' }, { token })).status).toBe(404);
    expect(readFileSync(join(w.pluginDir, 'word-first', 'index.ts'), 'utf8')).toMatch(/describe: 'mine'/);

    await app.ui('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token });
    writePlugins(w.db.dbPath, { ...TEST_PLUGINS, executors: [{ name: 'test', plugin: 'test' }, { name: 'echo', plugin: 'echo-executor' }] });
    const named = await app.ui<{ error: string }>('/ui/api/plugin-store', { action: 'remove', id: 'echo-executor' }, { token });
    expect(named.status).toBe(409);
    expect(named.body.error).toMatch(/echo/);
    expect(plugin(await read(app), 'echo-executor')?.installed).toMatchObject({ commit: w.first });

    expect((await app.ui('/ui/api/plugin-store', { action: 'install', id: 'nope' }, { token })).status).toBe(404);
    expect((await app.ui('/ui/api/plugin-store', { action: 'remove', id: '../plugins/echo-executor' }, { token })).status).toBe(400);
  });

  it('refuses a store plugin that does not load as the catalogue says, and leaves nothing behind', async () => {
    const w = world();
    w.store.addExample('router', 'proceed-all', 'plugins/liar');
    w.store.write('plugins/empty/README.md', 'no module\n');
    w.store.addExample('router', 'proceed-all', 'plugins/test');
    w.store.commit('bad entries', [
      entry('router', 'liar'), entry('router', 'empty'), { id: 'test', role: 'executor', describe: 'a built-in id', path: 'plugins/test' },
    ]);
    const app = await start(w);
    await ready(app);
    const token = await app.login();
    for (const [id, why] of [['liar', /declares id proceed-all/], ['empty', /no index\.ts or index\.js/], ['test', /built-in/]] as const) {
      const r = await app.ui<{ error: string }>('/ui/api/plugin-store', { action: 'install', id }, { token });
      expect(r.status, id).toBe(409);
      expect(r.body.error).toMatch(why);
    }
    expect(existsSync(w.pluginDir) ? readdirSync(w.pluginDir) : []).toEqual([]);
    expect((await read(app)).plugins.filter((p) => p.installed)).toEqual([]);
  });

  it('keeps the last good catalogue and reports the error when the store breaks', async () => {
    const w = world();
    const app = await start(w);
    await ready(app);
    const token = await app.login();
    w.store.write('plugin-store.yaml', 'version: 1\nplugins:\n  - { id: Bad Id, role: executor, describe: x, path: ../x }\n');
    w.store.commit('broken', [{ id: 'Bad Id', role: 'executor', describe: 'x', path: '../x' }]);
    const r = (await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'refresh' }, { token })).body;
    expect(r.state).toBe('error');
    expect(r.error).toMatch(/plugin-store\.yaml/);
    expect(r.commit).toBe(w.first);
    expect(r.plugins.map((p) => p.id)).toEqual(['echo-executor', 'word-first']);
  });
});

// Issue #445: the plugin store has a default and is a setting of the instance, kept in the database
// beside the store installs and set by an instance admin on the Plugin store card, without a restart.
// HOPPER_PLUGIN_STORE only seeds that setting while it was never set.
describe('the plugin store setting', () => {
  /** A second plugin store, offering one other plugin. */
  function other(root: string) {
    const dir = tempDir('jh-plugin-store-b-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const b = createStoreRepo(dir);
    b.addExample('notifier', 'log-events');
    return { b, head: b.commit('one plugin', [entry('notifier', 'log-events')]), root };
  }
  const source = (app: TestApp, token: string, s: unknown) => app.ui<PluginStoreReport & { error?: string }>('/ui/api/plugin-store', { action: 'source', source: s }, { token });

  it('a new hopper reads the default plugin store, with nothing set', async () => {
    const w = world();
    const app = await start(w, {}, { pluginStoreDefault: w.store.dir });
    await ready(app);
    expect(await read(app)).toMatchObject({ state: 'ready', source: 'default', repo: w.store.dir, defaultRepo: w.store.dir, commit: w.first });
    expect((await read(app)).plugins.map((p) => p.id)).toEqual(['echo-executor', 'word-first']);
  });

  it("reads this repository's default plugin store as the Pages site serves it, and installs from it", async () => {
    const w = world();
    const site = tempDir('jh-plugin-store-site-');
    cleanups.push(() => rmSync(site, { recursive: true, force: true }));
    execFileSync('bash', [join(ROOT, 'scripts', 'build-plugin-store.sh'), ROOT, join(site, 'plugin-store.git')], { stdio: 'ignore' });
    const served = await serveDir(site);
    cleanups.push(() => void served.close());
    const url = `${served.url}/plugin-store.git`;
    const app = await start(w, {}, { pluginStoreDefault: url });
    await ready(app);
    const r = await read(app);
    expect(r).toMatchObject({ state: 'ready', source: 'default', repo: url });
    expect(r.plugins.map((p) => p.id)).toContain('echo-executor');
    const installed = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token: await app.login() });
    expect(installed.status).toBe(200);
    expect(plugin(installed.body, 'echo-executor')?.installed).toMatchObject({ current: true });
  });

  it('with no plugin store, says so without naming an environment variable', async () => {
    const w = world();
    const app = await start(w, {});
    const r = await read(app);
    expect(r).toMatchObject({ state: 'unavailable', source: 'default' });
    expect(r.reason).toBeTruthy();
    expect(r.reason).not.toMatch(/HOPPER_|environment/);
  });

  it('an instance admin sets the plugin store in the UI, and its catalogue is read without a restart', async () => {
    const w = world();
    const { b, head } = other('b');
    const app = await start(w, {}, { pluginStoreDefault: w.store.dir });
    await ready(app);
    expect((await app.ui('/ui/api/plugin-store', { action: 'source', source: { kind: 'repo', repo: b.dir } })).status).toBe(403);
    const token = await app.login();

    const set = await source(app, token, { kind: 'repo', repo: b.dir });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ state: 'ready', source: 'repo', repo: b.dir, commit: head });
    expect(set.body.plugins.map((p) => p.id)).toEqual(['log-events']);
    expect(await read(app)).toMatchObject({ repo: b.dir, commit: head });
    expect(app.app.instance.settings.getPluginStoreSource()).toEqual({ kind: 'repo', repo: b.dir });

    const installed = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'install', id: 'log-events' }, { token });
    expect(plugin(installed.body, 'log-events')?.installed).toMatchObject({ commit: head });
    expect((await app.ui('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token })).status).toBe(404);

    const back = await source(app, token, { kind: 'default' });
    expect(back.body).toMatchObject({ state: 'ready', source: 'default', repo: w.store.dir, commit: w.first });
    expect(plugin(back.body, 'log-events')).toMatchObject({ listed: false, installed: { commit: head } });

    expect((await source(app, token, { kind: 'repo', repo: '--upload-pack=touch x' })).status).toBe(400);
    expect((await source(app, token, { kind: 'repo', repo: ' ' })).status).toBe(400);
  });

  it('a bad plugin store shows the error, keeps the last good catalogue and offers no install from it', async () => {
    const w = world();
    const app = await start(w);
    await ready(app);
    const token = await app.login();
    const missing = join(w.store.dir, '..', 'no-such-store');
    const r = (await source(app, token, { kind: 'repo', repo: missing })).body;
    expect(r).toMatchObject({ state: 'error', source: 'repo', repo: missing, from: w.store.dir, commit: w.first });
    expect(r.error).toMatch(/no-such-store/);
    expect(r.plugins.map((p) => p.id)).toEqual(['echo-executor', 'word-first']);
    const refused = await app.ui<{ error: string }>('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/read from/);

    const fixed = (await source(app, token, { kind: 'repo', repo: w.store.dir })).body;
    expect(fixed).toMatchObject({ state: 'ready', repo: w.store.dir });
    expect(fixed.from).toBeUndefined();
  });

  it('clearing the plugin store leaves none, and its store installs can still be removed', async () => {
    const w = world();
    const app = await start(w);
    await ready(app);
    const token = await app.login();
    await app.ui('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token });
    const r = (await source(app, token, { kind: 'none' })).body;
    expect(r).toMatchObject({ state: 'unavailable', source: 'none' });
    expect(r.repo).toBeUndefined();
    expect(r.plugins.map((p) => [p.id, p.listed])).toEqual([['word-first', false]]);
    expect((await app.ui('/ui/api/plugin-store', { action: 'refresh' }, { token })).status).toBe(200);
    expect((await app.ui('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token })).status).toBe(409);
    const removed = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'remove', id: 'word-first' }, { token });
    expect(removed.status).toBe(200);
    expect(removed.body.plugins).toEqual([]);
  });

  it('copies HOPPER_PLUGIN_STORE into the database once; a second boot changes nothing', async () => {
    const w = world();
    const { b } = other('b');
    const first = await start(w, { HOPPER_PLUGIN_STORE: w.store.dir }, { pluginStoreDefault: b.dir });
    await ready(first);
    expect(await read(first)).toMatchObject({ source: 'repo', repo: w.store.dir });
    expect(first.app.instance.settings.getPluginStoreSource()).toEqual({ kind: 'repo', repo: w.store.dir });
    const token = await first.login();
    await source(first, token, { kind: 'none' });
    await first.stop();
    apps.splice(apps.indexOf(first), 1);

    const second = await start(w, { HOPPER_PLUGIN_STORE: b.dir }, { pluginStoreDefault: b.dir });
    expect(await read(second)).toMatchObject({ state: 'unavailable', source: 'none' });
    expect(second.app.instance.settings.getPluginStoreSource()).toEqual({ kind: 'none' });
  });
});
