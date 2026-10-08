// Self-update (issue #44) against real git repositories: detecting newer commits and releases,
// applying one beside the running install, waiting for jobs a restart would lose, and reporting
// the result on the next boot. The build (scripts/install.sh build-only mode) and the restart are seams.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../src/domain/types.ts';
import { waitFor } from '../support/wait.ts';
import { copyBuilder, createInstall, git, readInstall } from './support.ts';
import { types, updater, world, type World } from './world.ts';

describe('detecting an update', () => {
  it('is unavailable without install.json, and says why', async () => {
    const w = world();
    const appDir = join(w.root, 'bare');
    const { u } = updater(w, appDir);
    const s = await u.check();
    expect(s.state).toBe('unavailable');
    expect(s.reason).toMatch(/install\.json/);
  });

  it('finds a newer head of the tracked branch, says what is new in plain words, and announces each new target once', async () => {
    const w = world();
    w.up.whatsNew(['Older news.']);
    const c1 = w.up.commit('first');
    w.up.whatsNew(['Jobs show their machine.', 'Older news.']);
    w.up.commit('feat: machine on the job (#12)');
    w.up.whatsNew(['You can pause the queue.', 'Jobs show their machine.', 'Older news.']);
    const c3 = w.up.commit('fix: pause (#13)');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', channel: 'main', target: { commit: c3, ref: 'main' } });
    expect(s.installed?.commit).toBe(c1);
    expect(s.whatsNew).toEqual(['You can pause the queue.', 'Jobs show their machine.']);
    expect(JSON.stringify(s)).not.toMatch(/#1[23]|feat:|fix:/);
    expect(w.store.events.since(0).find((e) => e.type === 'update.available')?.data).toMatchObject({ changes: 2 });
    await u.check();
    expect(types(w)).toEqual(['update.available']);
    const c4 = w.up.commit('fourth');
    expect((await u.check()).target?.commit).toBe(c4);
    expect(types(w)).toEqual(['update.available', 'update.available']);
  });

  it('checks on its own and offers a newer version even when the check interval is set to 0: checking cannot be turned off (issue #177)', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const c2 = w.up.commit('merged to main');
    const warned: string[] = [];
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1), { checkMs: 0, logger: { info: () => {}, warn: (l) => { warned.push(l); } } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    try {
      u.start();
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(async () => u.status().state === 'available');
    expect(u.status().target?.commit).toBe(c2);
    expect(types(w)).toEqual(['update.available']);
    expect(warned.join('\n')).toMatch(/HOPPER_UPDATE_CHECK_MS/);
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
    expect(s.whatsNew).toEqual([]);
  });

  it('says what the installed version brought, from its own What\'s new, with no update and before any check (issue #165)', async () => {
    const w = world();
    w.up.whatsNew(['Seventh.', 'Sixth.', 'Fifth.', 'Fourth.', 'Third.', 'Second.', 'First.']);
    const c1 = w.up.commit('first');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    expect(u.status().installedWhatsNew).toEqual(['Seventh.', 'Sixth.', 'Fifth.', 'Fourth.', 'Third.']);
    const s = await u.check();
    expect(s.state).toBe('current');
    expect(s.installedWhatsNew).toEqual(['Seventh.', 'Sixth.', 'Fifth.', 'Fourth.', 'Third.']);
  });

  it('says what the installed version brought even when self-update is unavailable; none when it has no What\'s new', async () => {
    const w = world();
    const bare = join(w.root, 'bare');
    mkdirSync(bare);
    writeFileSync(join(bare, 'WHATS-NEW.md'), "# What's new\n\n- Jobs show their machine.\n");
    expect((await updater(w, bare).u.check()).installedWhatsNew).toEqual(['Jobs show their machine.']);
    const c1 = w.up.commit('first');
    expect(updater(w, createInstall(w.root, w.up.dir, c1)).u.status().installedWhatsNew).toEqual([]);
  });

  it('lists the version history: every version the install is made of that brought What\'s new, with the day it landed, newest first (issue #246)', async () => {
    const w = world();
    w.up.whatsNew(['First.']);
    const c1 = w.up.commit('first');
    w.up.commit('no change people notice');
    git(w.up.dir, 'checkout', '-q', '-b', 'feature');
    w.up.whatsNew(['Second.', 'First.']);
    w.up.commit('feature work');
    git(w.up.dir, 'checkout', '-q', 'main');
    git(w.up.dir, 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    const merged = git(w.up.dir, 'rev-parse', 'HEAD');
    w.up.whatsNew(['Third.', 'Second.', 'First.']);
    w.up.commit('newer than the install');
    const { u } = updater(w, createInstall(w.root, w.up.dir, merged));
    const h = await u.history();
    expect(h.reason).toBeUndefined();
    expect(h.versions.map((v) => ({ commit: v.commit, changes: v.changes }))).toEqual([
      { commit: merged, changes: ['Second.'] },
      { commit: c1, changes: ['First.'] },
    ]);
    for (const v of h.versions) expect(new Date(v.at).getTime()).not.toBeNaN();
  });

  it('has no version history without install.json, and says why', async () => {
    const w = world();
    const h = await updater(w, join(w.root, 'bare')).u.history();
    expect(h.versions).toEqual([]);
    expect(h.build).toEqual({});
    expect(h.reason).toMatch(/install\.json/);
  });

  it('reads an image build the same as an install: the check and the version history from what it was built from (issue #409)', async () => {
    const w = world();
    w.up.whatsNew(['First.']);
    const c1 = w.up.commit('first');
    w.up.whatsNew(['Second.', 'First.']);
    const c2 = w.up.commit('second');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1, 'main', 'image'));
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', installed: { kind: 'image', commit: c1 }, target: { commit: c2 } });
    expect(s.whatsNew).toEqual(['Second.']);
    const h = await u.history();
    expect(h.reason).toBeUndefined();
    expect(h.build).toMatchObject({ kind: 'image', repo: w.up.dir, branch: 'main', commit: c1 });
    expect(h.versions.map((v) => v.commit)).toEqual([c1]);
  });

  it('never applies to an image build: the image is replaced by pulling or rebuilding it, not swapped in place (issue #409)', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    w.up.commit('second');
    const calls: string[] = [];
    const { u, restarts } = updater(w, createInstall(w.root, w.up.dir, c1, 'main', 'image'), { builder: copyBuilder({ calls }) });
    w.instance.settings.setUpdateSettings({ autoUpdate: true });
    expect((await u.check()).state).toBe('available');
    const r = u.apply();
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/image/);
    await new Promise((res) => setTimeout(res, 50));
    expect(calls).toEqual([]);
    expect(restarts).toEqual([]);
    expect(types(w)).toEqual(['update.available']);
  });

  it('reads an install.json from before kinds as an install (issue #409)', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const { kind: _kind, ...old } = readInstall(appDir);
    writeFileSync(join(appDir, 'install.json'), JSON.stringify(old));
    expect(updater(w, appDir).u.status().installed).toMatchObject({ kind: 'install', commit: c1 });
  });

  it('a build that lacks its commit shows what it does know, and names what is missing (issue #409)', async () => {
    const w = world();
    const appDir = join(w.root, 'partial');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'install.json'), JSON.stringify({ kind: 'image', repo: w.up.dir, branch: 'main', installedAt: '2026-10-07T12:00:00.000Z' }));
    const { u } = updater(w, appDir);
    const h = await u.history();
    expect(h.versions).toEqual([]);
    expect(h.build).toEqual({ kind: 'image', repo: w.up.dir, branch: 'main', installedAt: '2026-10-07T12:00:00.000Z' });
    expect(h.reason).toMatch(/commit/);
    expect(h.reason).not.toMatch(/repository/);
    const s = await u.check();
    expect(s.state).toBe('unavailable');
    expect(s.reason).toMatch(/commit/);
  });

  it('on the release channel targets the newest v<semver> tag, and reports the newest release on either channel', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    w.up.whatsNew(['Second news.']);
    const c2 = w.up.commit('second');
    w.up.tag('v0.9.0', c2);
    w.up.whatsNew(['Third news.', 'Second news.']);
    const c3 = w.up.commit('third');
    w.up.tag('v0.10.0', c3);
    w.up.tag('not-a-release', c3);
    w.up.whatsNew(['Fourth news.', 'Third news.', 'Second news.']);
    w.up.commit('fourth');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    expect((await u.check()).release).toEqual({ tag: 'v0.10.0', commit: c3, newer: true });
    const s = u.settings({ channel: 'release' });
    expect(s.channel).toBe('release');
    const r = await u.check();
    expect(r).toMatchObject({ state: 'available', target: { commit: c3, ref: 'v0.10.0' } });
    expect(r.whatsNew).toEqual(['Third news.', 'Second news.']);
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
    let blockers = 2;
    const { u, restarts } = updater(w, appDir, { restartBlockers: () => blockers });
    await u.check();
    const r = u.apply();
    expect(r.ok).toBe(true);
    expect(u.apply()).toEqual({ ok: false, error: 'an update is already being applied' });
    const waiting = await waitFor(async () => (u.status().apply?.phase === 'waiting' ? u.status() : undefined));
    expect(waiting.apply?.detail).toBe('waiting for 2 running jobs: a restart would lose them');
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v1');
    blockers = 0;
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
    const { u, restarts } = updater(w, appDir, { builder: copyBuilder({ main: 'export const = ;\n' }) });
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
