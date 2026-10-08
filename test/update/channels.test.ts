// The dev, beta and stable update channels (issues #282, #423) against real git repositories: each
// follows the branch of its name, an applied update installs from that branch, and moving to a
// steadier channel goes back to its head.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../support/wait.ts';
import { createInstall, git, readInstall } from './support.ts';
import { updater, world, type World } from './world.ts';

describe('the dev, beta and stable channels (issues #282, #423)', () => {
  /** stable ← beta ← dev: each branch one commit ahead of the next more stable one. */
  function branches(w: World) {
    w.up.whatsNew(['Stable news.']);
    const stable = w.up.commit('stable', 'stable');
    git(w.up.dir, 'checkout', '-q', '-b', 'beta');
    w.up.whatsNew(['Beta news.', 'Stable news.']);
    const beta = w.up.commit('beta', 'beta');
    git(w.up.dir, 'checkout', '-q', '-b', 'dev');
    w.up.whatsNew(['Dev news.', 'Beta news.', 'Stable news.']);
    const dev = w.up.commit('dev', 'dev');
    git(w.up.dir, 'checkout', '-q', 'stable');
    return { stable, beta, dev };
  }

  it('each channel follows the head of its own branch', async () => {
    const w = world();
    const b = branches(w);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.stable));
    expect(await u.check()).toMatchObject({ state: 'current', channel: 'stable', target: { commit: b.stable, ref: 'stable' } });
    u.settings({ channel: 'beta' });
    expect(await u.check()).toMatchObject({ state: 'available', channel: 'beta', target: { commit: b.beta, ref: 'beta' }, whatsNew: ['Beta news.'] });
    u.settings({ channel: 'dev' });
    expect(await u.check()).toMatchObject({ state: 'available', channel: 'dev', target: { commit: b.dev, ref: 'dev' }, whatsNew: ['Dev news.', 'Beta news.'] });
  });

  it('with no channel chosen, follows the branch it was installed from when that is a channel', async () => {
    const w = world();
    const b = branches(w);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.beta, 'beta'));
    expect(u.status().channel).toBe('beta');
    expect(await u.check()).toMatchObject({ state: 'current', target: { commit: b.beta, ref: 'beta' } });
    rmSync(join(w.root, 'app'), { recursive: true });
    expect(updater(w, createInstall(w.root, w.up.dir, b.stable, 'feature')).u.status().channel).toBe('stable');
  });

  it('an install from main, from before the channels were dev, beta and stable, follows stable', async () => {
    const w = world();
    const b = branches(w);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.stable, 'main'));
    expect(u.status().channel).toBe('stable');
    expect(await u.check()).toMatchObject({ state: 'current', target: { commit: b.stable, ref: 'stable' } });
  });

  it('applying a channel\'s update installs from that branch, so the next check follows it', async () => {
    const w = world();
    const b = branches(w);
    const appDir = createInstall(w.root, w.up.dir, b.stable);
    const { u, restarts } = updater(w, appDir);
    u.settings({ channel: 'dev' });
    await u.check();
    u.apply();
    await waitFor(async () => restarts.length === 1);
    expect(readInstall(appDir)).toMatchObject({ commit: b.dev, branch: 'dev' });
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('dev');
  });

  it('moving to a more stable channel offers that channel\'s head, though the install already contains it', async () => {
    const w = world();
    const b = branches(w);
    const appDir = createInstall(w.root, w.up.dir, b.dev, 'dev');
    const { u, restarts } = updater(w, appDir);
    expect((await u.check()).state).toBe('current');
    u.settings({ channel: 'stable' });
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', channel: 'stable', target: { commit: b.stable, ref: 'stable' }, whatsNew: [] });
    u.apply();
    await waitFor(async () => restarts.length === 1);
    expect(readInstall(appDir)).toMatchObject({ commit: b.stable, branch: 'stable' });
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('stable');
  });

  it('says so when the channel\'s branch does not exist', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1));
    u.settings({ channel: 'beta' });
    const s = await u.check();
    expect(s.state).toBe('error');
    expect(s.reason).toMatch(/branch beta not found/);
  });
});
