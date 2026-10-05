// The plugin store through the HTTP edge (issue #75, design.md "Plugin store"): a real git
// repository holding a store catalogue, a real daemon. GET /api/plugin-store reads; POST
// /ui/api/plugin-store refreshes, installs (and updates) and removes, behind an admin UI session.
// Installed plugins land in the plugin dir and show in /api/plugins without a restart.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginStoreReport, PluginsReport } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePluginsYaml, TEST_PLUGINS, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { tempDir } from '../update/support.ts';
import { createStoreRepo, entry } from '../plugin-store/support.ts';

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

async function start(w: ReturnType<typeof world>, env: Record<string, string> = { JOB_HOPPER_PLUGIN_STORE: w.store.dir }): Promise<TestApp> {
  const app = await startTestApp({ dbPath: w.db.dbPath, env });
  apps.push(app);
  return app;
}

const read = async (app: TestApp) => (await app.api<PluginStoreReport>('GET', '/api/plugin-store')).body;
const ready = (app: TestApp) => waitFor(async () => (await read(app)).state !== 'unavailable' || undefined);
const plugin = (r: PluginStoreReport, id: string) => r.plugins.find((p) => p.id === id);

describe('the plugin store over HTTP', () => {
  it('is unavailable without JOB_HOPPER_PLUGIN_STORE', async () => {
    const w = world();
    const app = await start(w, {});
    const r = await read(app);
    expect(r).toMatchObject({ state: 'unavailable', plugins: [] });
    expect(r.reason).toMatch(/JOB_HOPPER_PLUGIN_STORE/);
  });

  it('is unavailable without a plugin dir: there is nowhere to install', async () => {
    const w = world();
    // Unset: the test app sets a plugin dir by default.
    const app = await start(w, { JOB_HOPPER_PLUGIN_STORE: w.store.dir, JOB_HOPPER_PLUGIN_DIR: undefined } as unknown as Record<string, string>);
    const r = await read(app);
    expect(r.state).toBe('unavailable');
    expect(r.reason).toMatch(/JOB_HOPPER_PLUGIN_DIR/);
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
    expect(existsSync(join(w.pluginDir, 'echo-executor', 'index.ts'))).toBe(true);
    expect(JSON.parse(readFileSync(join(w.pluginDir, 'echo-executor', '.plugin-store.json'), 'utf8'))).toMatchObject({ commit: w.first });

    const plugins = (await app.api<PluginsReport>('GET', '/api/plugins')).body;
    expect(plugins.plugins.find((p) => p.id === 'echo-executor')).toMatchObject({ role: 'executor', builtin: false, detection: { status: 'available' } });

    const removed = await app.ui<PluginStoreReport>('/ui/api/plugin-store', { action: 'remove', id: 'echo-executor' }, { token });
    expect(removed.status).toBe(200);
    expect(plugin(removed.body, 'echo-executor')?.installed).toBeUndefined();
    expect(existsSync(join(w.pluginDir, 'echo-executor'))).toBe(false);
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
    expect(existsSync(join(w.pluginDir, 'word-first', 'NOTES.md'))).toBe(true);
  });

  it('refuses to remove a plugin plugins.yaml names, and to touch a plugin the operator put there by hand', async () => {
    const w = world();
    mkdirSync(join(w.pluginDir, 'word-first'), { recursive: true });
    writeFileSync(join(w.pluginDir, 'word-first', 'index.ts'), "export default { id: 'word-first', role: 'queue-sorter', describe: 'mine', detect: async () => ({ status: 'available' }), create: () => ({ name: 'w', sort: () => [] }) };\n");
    const app = await start(w);
    await ready(app);
    const token = await app.login();

    const own = await app.ui<{ error: string }>('/ui/api/plugin-store', { action: 'install', id: 'word-first' }, { token });
    expect(own.status).toBe(409);
    expect(own.body.error).toMatch(/not a store install/);
    expect((await app.ui('/ui/api/plugin-store', { action: 'remove', id: 'word-first' }, { token })).status).toBe(404);
    expect(readFileSync(join(w.pluginDir, 'word-first', 'index.ts'), 'utf8')).toMatch(/describe: 'mine'/);

    await app.ui('/ui/api/plugin-store', { action: 'install', id: 'echo-executor' }, { token });
    writePluginsYaml(w.db.dbPath, { ...TEST_PLUGINS, executors: [{ name: 'test', plugin: 'test' }, { name: 'echo', plugin: 'echo-executor' }] });
    const named = await app.ui<{ error: string }>('/ui/api/plugin-store', { action: 'remove', id: 'echo-executor' }, { token });
    expect(named.status).toBe(409);
    expect(named.body.error).toMatch(/echo/);
    expect(existsSync(join(w.pluginDir, 'echo-executor'))).toBe(true);

    expect((await app.ui('/ui/api/plugin-store', { action: 'install', id: 'nope' }, { token })).status).toBe(404);
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
