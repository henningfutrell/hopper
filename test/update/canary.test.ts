// The canary subset (issue #1073 part 5, design.md "Landing batches: the canary"): a stable install that takes stable
// releases early follows the `canary` branch while it is ahead of `stable`, so a stable release reaches it before every
// other install. Real git repositories, as the channels' tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../support/wait.ts';
import { createInstall, git, readInstall } from './support.ts';
import { updater, world, type World } from './world.ts';

describe('the canary subset (issue #1073 part 5)', () => {
  /** stable ← canary: the candidate one commit ahead of stable. */
  function branches(w: World) {
    w.up.whatsNew(['Stable news.']);
    const stable = w.up.commit('stable', 'stable');
    git(w.up.dir, 'checkout', '-q', '-b', 'canary');
    w.up.whatsNew(['Candidate news.', 'Stable news.']);
    const canary = w.up.commit('canary', 'canary');
    git(w.up.dir, 'checkout', '-q', 'stable');
    return { stable, canary };
  }

  it('is off by default: a stable install follows stable only', async () => {
    const w = world();
    const b = branches(w);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.stable));
    expect(u.status().canary).toBe(false);
    expect(await u.check()).toMatchObject({ state: 'current', target: { commit: b.stable, ref: 'stable' } });
  });

  it('on, a stable install is offered the canary candidate, and applying it installs from canary', async () => {
    const w = world();
    const b = branches(w);
    const appDir = createInstall(w.root, w.up.dir, b.stable);
    const { u, restarts } = updater(w, appDir);
    u.settings({ canary: true });
    expect(await u.check()).toMatchObject({ state: 'available', channel: 'stable', canary: true, target: { commit: b.canary, ref: 'canary' }, whatsNew: ['Candidate news.'] });
    u.apply();
    await waitFor(async () => restarts.length === 1);
    expect(readInstall(appDir)).toMatchObject({ commit: b.canary, branch: 'canary' });
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('canary');
  });

  it('on another channel, the canary does not apply', async () => {
    const w = world();
    const b = branches(w);
    git(w.up.dir, 'branch', 'beta', b.stable);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.stable, 'beta'));
    u.settings({ canary: true, channel: 'beta' });
    expect(await u.check()).toMatchObject({ state: 'current', target: { commit: b.stable, ref: 'beta' } });
  });

  it('once stable has the candidate, the canary install is current on stable', async () => {
    const w = world();
    const b = branches(w);
    git(w.up.dir, 'merge', '-q', '--ff-only', b.canary);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.canary, 'canary'));
    u.settings({ canary: true });
    expect(await u.check()).toMatchObject({ state: 'current', target: { commit: b.canary, ref: 'stable' } });
  });

  it('a canary branch that is not ahead of stable is not followed', async () => {
    const w = world();
    const b = branches(w);
    git(w.up.dir, 'checkout', '-q', 'stable');
    w.up.whatsNew(['Other news.', 'Stable news.']);
    const fix = w.up.commit('stable fix', 'stable2');
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.stable));
    u.settings({ canary: true });
    expect(await u.check()).toMatchObject({ state: 'available', target: { commit: fix, ref: 'stable' } });
  });

  it('turned off on the candidate, the install goes back to stable\'s head', async () => {
    const w = world();
    const b = branches(w);
    const { u } = updater(w, createInstall(w.root, w.up.dir, b.canary, 'canary'));
    expect(await u.check()).toMatchObject({ state: 'available', canary: false, target: { commit: b.stable, ref: 'stable' } });
  });
});
