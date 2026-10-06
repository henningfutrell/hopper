// The dev, beta and main update channels (issue #282) against real git repositories: each follows
// the branch of its name, an applied update installs from that branch, and moving to a steadier
// channel goes back to its head.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../support/wait.ts';
import { createInstall, git, readInstall } from './support.ts';
import { updater, world, type World } from './world.ts';

describe('the dev, beta and main channels (issue #282)', () => {
  /** main ← beta ← dev: each branch one commit ahead of the next more stable one. */
  function branches(w: World) {
    w.up.whatsNew(['Stable news.']);
    const main = w.up.commit('stable', 'main');
    git(w.up.dir, 'checkout', '-q', '-b', 'beta');
    w.up.whatsNew(['Beta news.', 'Stable news.']);
    const beta = w.up.commit('beta', 'beta');
    git(w.up.dir, 'checkout', '-q', '-b', 'dev');
    w.up.whatsNew(['Dev news.', 'Beta news.', 'Stable news.']);
    const dev = w.up.commit('dev', 'dev');
    git(w.up.dir, 'checkout', '-q', 'main');
    return { main, beta, dev };
  }

  it('each channel follows the head of its own branch', async () => {
    const w = world();
    const b = branches(w);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.main));
    expect(await u.check()).toMatchObject({ state: 'current', channel: 'main', target: { commit: b.main, ref: 'main' } });
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
    expect(updater(w, createInstall(w.root, w.up.dir, b.main, 'feature')).u.status().channel).toBe('main');
  });

  it('applying a channel\'s update installs from that branch, so the next check follows it', async () => {
    const w = world();
    const b = branches(w);
    const appDir = createInstall(w.root, w.up.dir, b.main);
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
    u.settings({ channel: 'main' });
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', channel: 'main', target: { commit: b.main, ref: 'main' }, whatsNew: [] });
    u.apply();
    await waitFor(async () => restarts.length === 1);
    expect(readInstall(appDir)).toMatchObject({ commit: b.main, branch: 'main' });
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('main');
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
