// Self-update (issue #44) against real git repositories: detecting newer commits and releases,
// applying one beside the running install, waiting for jobs a restart would lose, and reporting
// the result on the next boot. The build (scripts/install.sh stage mode) and the restart are seams.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/domain/ports.ts';
import type { UpdateStatus } from '../../src/domain/types.ts';
import { openStore } from '../../src/store/index.ts';
import { createUpdater, type UpdaterOptions } from '../../src/update/index.ts';
import { waitFor } from '../support/wait.ts';
import { copyStager, createInstall, createUpstream, git, readInstall, tempDir, type Upstream } from './support.ts';

const dirs: string[] = [];
const stores: Store[] = [];
const updaters: { stop(): void }[] = [];

afterEach(() => {
  for (const u of updaters.splice(0)) u.stop();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World { root: string; up: Upstream; store: Store; dataDir: string }

function world(): World {
  const root = tempDir('jh-update-');
  dirs.push(root);
  const dataDir = join(root, 'data');
  const store = openStore({ path: join(dataDir, 'db.sqlite'), clock: { now: () => new Date() } });
  stores.push(store);
  return { root, up: createUpstream(root), store, dataDir };
}

function updater(w: World, appDir: string, o: Partial<UpdaterOptions> = {}) {
  const restarts: number[] = [];
  const u = createUpdater({
    appDir, dataDir: w.dataDir, store: w.store, clock: { now: () => new Date() }, logger: { info: () => {}, warn: () => {} },
    stager: copyStager(), restart: async () => { restarts.push(Date.now()); }, restartBlockers: () => [], checkMs: 0, waitMs: 20,
    ...o,
  });
  updaters.push(u);
  return { u, restarts };
}

const types = (w: World, prefix = 'update.') => w.store.events.since(0).filter((e) => e.type.startsWith(prefix)).map((e) => e.type);

describe('detecting an update', () => {
  it('is unavailable without install.json, and says why', async () => {
    const w = world();
    const appDir = join(w.root, 'bare');
    const { u } = updater(w, appDir);
    const s = await u.check();
    expect(s.state).toBe('unavailable');
    expect(s.reason).toMatch(/install\.json/);
  });

  it('finds newer commits on the tracked branch, newest first, and announces each new target once', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const c2 = w.up.commit('second');
    const c3 = w.up.commit('third');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', channel: 'main', target: { commit: c3, ref: 'main' }, truncated: false });
    expect(s.installed?.commit).toBe(c1);
    expect(s.changes.map((c) => [c.commit, c.subject])).toEqual([[c3, 'third'], [c2, 'second']]);
    await u.check();
    expect(types(w)).toEqual(['update.available']);
    const c4 = w.up.commit('fourth');
    expect((await u.check()).target?.commit).toBe(c4);
    expect(types(w)).toEqual(['update.available', 'update.available']);
  });

  it('is current when installed at the head, or ahead of it', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    expect((await u.check()).state).toBe('current');
    git(w.up.dir, 'checkout', '-q', '-b', 'feature');
    const ahead = w.up.commit('ahead');
    git(w.up.dir, 'checkout', '-q', 'main');
    rmSync(join(w.root, 'app'), { recursive: true });
    const { u: u2 } = updater(w, createInstall(w.root, w.up.dir, ahead));
    const s = await u2.check();
    expect(s.state).toBe('current');
    expect(s.changes).toEqual([]);
  });

  it('on the release channel targets the newest v<semver> tag, and reports the newest release on either channel', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const c2 = w.up.commit('second');
    w.up.tag('v0.9.0', c2);
    const c3 = w.up.commit('third');
    w.up.tag('v0.10.0', c3);
    w.up.tag('not-a-release', c3);
    w.up.commit('fourth');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    expect((await u.check()).release).toEqual({ tag: 'v0.10.0', commit: c3, newer: true });
    const s = u.settings({ channel: 'release' });
    expect(s.channel).toBe('release');
    const r = await u.check();
    expect(r).toMatchObject({ state: 'available', target: { commit: c3, ref: 'v0.10.0' } });
    expect(r.changes.map((c) => c.subject)).toEqual(['third', 'second']);
  });

  it('keeps the settings in the store', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const appDir = createInstall(w.root, w.up.dir, c1);
    updater(w, appDir).u.settings({ channel: 'release', autoUpdate: true });
    expect(updater(w, appDir).u.status()).toMatchObject({ channel: 'release', autoUpdate: true });
  });

  it('reports a failed fetch as an error with the reason', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const appDir = createInstall(w.root, w.up.dir, c1);
    writeFileSync(join(appDir, 'install.json'), JSON.stringify({ ...readInstall(appDir), repo: join(w.root, 'missing-repo') }));
    const s = await updater(w, appDir).u.check();
    expect(s.state).toBe('error');
    expect(s.reason).toMatch(/fetch/);
  });
});

describe('applying an update', () => {
  it('builds the target beside the install, waits for jobs a restart would lose, swaps, and restarts', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    const c2 = w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    let blockers = ['job-1 (test)'];
    const { u, restarts } = updater(w, appDir, { restartBlockers: () => blockers });
    await u.check();
    const r = u.apply();
    expect(r.ok).toBe(true);
    expect(u.apply()).toEqual({ ok: false, error: 'an update is already being applied' });
    const waiting = await waitFor(async () => (u.status().apply?.phase === 'waiting' ? u.status() : undefined));
    expect(waiting.apply?.detail).toMatch(/job-1 \(test\)/);
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v1');
    blockers = [];
    await waitFor(async () => restarts.length === 1);
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v2');
    expect(readInstall(appDir)).toMatchObject({ commit: c2, branch: 'main', repo: w.up.dir });
    expect(readFileSync(join(`${appDir}.prev`, 'app.txt'), 'utf8')).toBe('v1');
    expect(existsSync(`${appDir}.next`)).toBe(false);
    expect(u.status().apply?.phase).toBe('restarting');
    expect(types(w)).toEqual(['update.available', 'update.started']);
  });

  it('refuses when nothing is available', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    await u.check();
    expect(u.apply()).toEqual({ ok: false, error: 'no update available' });
  });

  it('leaves the install untouched when the new build does not load', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const { u, restarts } = updater(w, appDir, { stager: copyStager({ main: 'export const = ;\n' }) });
    await u.check();
    u.apply();
    const s = await waitFor(async () => (u.status().state === 'error' ? u.status() : undefined));
    expect(s.reason).toMatch(/does not load/);
    expect(s.apply).toBeUndefined();
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v1');
    expect(existsSync(`${appDir}.next`)).toBe(false);
    expect(restarts).toEqual([]);
    expect(types(w)).toEqual(['update.available', 'update.started', 'update.failed']);
  });

  it('applies on its own when auto-update is on', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const { u, restarts } = updater(w, appDir);
    u.settings({ autoUpdate: true });
    await u.check();
    await waitFor(async () => restarts.length === 1);
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v2');
  });
});

describe('the boot after an update', () => {
  async function applied(w: World): Promise<{ appDir: string; c1: string; c2: string }> {
    const c1 = w.up.commit('first', 'v1');
    const c2 = w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const { u, restarts } = updater(w, appDir);
    await u.check();
    u.apply();
    await waitFor(async () => restarts.length === 1);
    u.stop();
    return { appDir, c1, c2 };
  }

  it('records update.applied once the new install is running', async () => {
    const w = world();
    const { appDir, c1, c2 } = await applied(w);
    const { u } = updater(w, appDir);
    u.start();
    const s: UpdateStatus = await u.check();
    expect(s.state).toBe('current');
    const done = w.store.events.since(0).filter((e) => e.type === 'update.applied');
    expect(done.map((e) => e.data)).toEqual([{ from: c1, to: c2, ref: 'main' }]);
    updater(w, appDir).u.start();
    expect(types(w).filter((t) => t === 'update.applied')).toHaveLength(1);
  });

  it('records update.failed when the boot is not on the applied commit (rolled back by hand)', async () => {
    const w = world();
    const { appDir, c2 } = await applied(w);
    rmSync(appDir, { recursive: true });
    renameSync(`${appDir}.prev`, appDir);
    updater(w, appDir).u.start();
    const failed = w.store.events.since(0).filter((e) => e.type === 'update.failed');
    expect(failed.at(-1)?.data).toMatchObject({ to: c2 });
  });
});
