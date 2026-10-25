// Self-update (issue #44) against real git repositories: detecting newer commits on the channel,
// applying one beside the running install, waiting for jobs a restart would lose, and reporting
// the result on the next boot. The build (scripts/install.sh build-only mode) and the restart are seams.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../src/domain/types.ts';
import { waitFor } from '../support/wait.ts';
import { copyBuilder, createInstall, git, readInstall, releaseCheck } from './support.ts';
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
    expect(s).toMatchObject({ state: 'available', channel: 'stable', target: { commit: c3, ref: 'stable' } });
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

  it('records the commit the install runs once, with the merge commits it carries beyond the one recorded before (issue #2775 part 10)', async () => {
    const w = world();
    w.up.commit('first');
    const merge = (n: number): string => {
      git(w.up.dir, 'checkout', '-q', '-b', `topic-${n}`);
      w.up.commit(`topic ${n}`);
      git(w.up.dir, 'checkout', '-q', 'stable');
      w.up.commit(`main ${n}`);
      git(w.up.dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, `topic-${n}`);
      return git(w.up.dir, 'rev-parse', 'HEAD');
    };
    const m1 = merge(1);
    const { u } = updater(w, createInstall(w.root, w.up.dir, m1));
    await u.check();
    await u.check();
    const seen = () => w.store.events.since(0).filter((e) => e.type === 'install.seen').map((e) => e.data);
    expect(seen()).toEqual([{ commit: m1, branch: 'stable', mergeCommits: [m1] }]);
    // The install now runs a later commit: only the merge commits beyond the one recorded before.
    const m2 = merge(2);
    createInstall(w.root, w.up.dir, m2);
    await u.check();
    expect(seen()).toEqual([{ commit: m1, branch: 'stable', mergeCommits: [m1] }, { commit: m2, branch: 'stable', from: m1, mergeCommits: [m2] }]);
  });

  it('checks on its own and offers a newer version even when the check interval is set to 0: checking cannot be turned off (issue #177)', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const c2 = w.up.commit('merged to stable');
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
    git(w.up.dir, 'checkout', '-q', 'stable');
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
    git(w.up.dir, 'checkout', '-q', 'stable');
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

  it('reads the fragments of whats-new/ too, newest first; the assembly that moves them into WHATS-NEW.md is no news and no version (issue #824)', async () => {
    const w = world();
    w.up.whatsNew(['Older news.']);
    const c1 = w.up.commit('first');
    w.up.fragment('12.md', ['Jobs show their machine.']);
    const c2 = w.up.commit('machine on the job');
    w.up.fragment('13.md', ['You can pause the queue.']);
    const c3 = w.up.commit('pause');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    expect((await u.check()).whatsNew).toEqual(['You can pause the queue.', 'Jobs show their machine.']);
    w.up.whatsNew(['You can pause the queue.', 'Jobs show their machine.', 'Older news.']);
    w.up.fragment('12.md');
    w.up.fragment('13.md');
    const assembled = w.up.commit('assemble what is new');
    rmSync(join(w.root, 'app'), { recursive: true });
    const { u: u2 } = updater(w, createInstall(w.root, w.up.dir, c3));
    expect(u2.status().installedWhatsNew).toEqual(['You can pause the queue.', 'Jobs show their machine.', 'Older news.']);
    expect(await u2.check()).toMatchObject({ state: 'available', target: { commit: assembled }, whatsNew: [] });
    rmSync(join(w.root, 'app'), { recursive: true });
    const h = await updater(w, createInstall(w.root, w.up.dir, assembled)).u.history();
    expect(h.versions.map((v) => ({ commit: v.commit, changes: v.changes }))).toEqual([
      { commit: c3, changes: ['You can pause the queue.'] },
      { commit: c2, changes: ['Jobs show their machine.'] },
      { commit: c1, changes: ['Older news.'] },
    ]);
  });

  it('has no version history without install.json, and says why', async () => {
    const w = world();
    const h = await updater(w, join(w.root, 'bare')).u.history();
    expect(h.versions).toEqual([]);
    expect(h.build).toEqual({});
    expect(h.reason).toMatch(/install\.json/);
  });

  it('keeps the settings in the store', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const appDir = createInstall(w.root, w.up.dir, c1);
    updater(w, appDir).u.settings({ channel: 'beta', autoUpdate: true });
    expect(updater(w, appDir).u.status()).toMatchObject({ channel: 'beta', autoUpdate: true });
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

describe('only a merged pull request with passing checks (issue #652)', () => {
  it('offers the head of the channel with the pull request it is the merge of', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const c2 = w.up.commit('second');
    const release = releaseCheck(() => ({ passed: true, pullRequest: { number: 9, url: 'https://github.com/o/r/pull/9' } }));
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1), { release });
    expect(await u.check()).toMatchObject({ state: 'available', target: { commit: c2, ref: 'stable', pullRequest: { number: 9, url: 'https://github.com/o/r/pull/9' } } });
    expect(release.asked).toEqual([c2]);
    expect(w.store.events.since(0).find((e) => e.type === 'update.available')?.data).toMatchObject({ to: c2, pullRequest: 9 });
  });

  it('holds a head that is not one: says why, announces nothing, never applies it, even with auto-update on', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const c2 = w.up.commit('pushed straight to the branch');
    const warned: string[] = [];
    const { u, restarts } = updater(w, createInstall(w.root, w.up.dir, c1), {
      release: releaseCheck((c) => ({ passed: false, reason: `${c.slice(0, 7)} is not the merge of a pull request` })),
      logger: { info: () => {}, warn: (l) => { warned.push(l); } },
    });
    u.settings({ autoUpdate: true });
    const s = await u.check();
    expect(s).toMatchObject({ state: 'held', target: { commit: c2, ref: 'stable' }, reason: `${c2.slice(0, 7)} is not the merge of a pull request`, whatsNew: [] });
    expect(s.target?.pullRequest).toBeUndefined();
    expect(u.apply()).toEqual({ ok: false, error: 'no update available' });
    await u.check();
    expect(types(w)).toEqual([]);
    expect(restarts).toEqual([]);
    expect(warned.filter((l) => l.includes('held'))).toHaveLength(1);
  });

  it('asks nothing when the install is at the head', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const release = releaseCheck();
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1), { release });
    expect((await u.check()).state).toBe('current');
    expect(release.asked).toEqual([]);
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
    expect(readInstall(appDir)).toMatchObject({ commit: c2, branch: 'stable', repo: w.up.dir });
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
    expect(done.map((e) => e.data)).toEqual([{ from: c1, to: c2, ref: 'stable' }]);
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
