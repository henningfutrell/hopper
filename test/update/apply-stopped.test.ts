// Self-update (issue #1626): an apply the process stopped in, at each phase, is settled at the next start from its
// apply record — the events say what happened, and no half-built install is left.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UpdaterOptions } from '../../src/update/index.ts';
import { waitFor } from '../support/wait.ts';
import { copyBuilder, createInstall } from './support.ts';
import { types, updater, world } from './world.ts';

describe('an apply the process stopped in (issue #1626)', () => {
  /** A builder that writes part of the next install, then hangs: the process stops while it builds. */
  function hangingBuilder(): { builder: UpdaterOptions['builder']; started: () => boolean } {
    let started = false;
    return {
      started: () => started,
      builder: {
        async build(_source, targetDir) {
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(join(targetDir, 'half.txt'), 'half');
          started = true;
          await new Promise(() => {});
        },
      },
    };
  }

  it('records update.failed at the next start when it stopped while building, and leaves no half-built install', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    const c2 = w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const hang = hangingBuilder();
    const { u } = updater(w, appDir, { builder: hang.builder });
    await u.check();
    u.apply();
    await waitFor(async () => hang.started());
    expect(existsSync(`${appDir}.next`)).toBe(true);
    u.stop();
    const { u: after } = updater(w, appDir);
    after.start();
    expect(types(w)).toEqual(['update.available', 'update.started', 'update.failed']);
    expect(w.store.events.since(0).at(-1)?.data).toMatchObject({ to: c2, error: expect.stringMatching(/stopped while building/) });
    expect(existsSync(`${appDir}.next`)).toBe(false);
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v1');
    updater(w, appDir).u.start();
    expect(types(w)).toEqual(['update.available', 'update.started', 'update.failed']);
  });

  it('records update.failed at the next start when it stopped while waiting for running jobs, and leaves no built install', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    const c2 = w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const { u, restarts } = updater(w, appDir, { restartBlockers: () => 1 });
    await u.check();
    u.apply();
    await waitFor(async () => u.status().apply?.phase === 'waiting');
    u.stop();
    const { u: after } = updater(w, appDir);
    after.start();
    expect(types(w)).toEqual(['update.available', 'update.started', 'update.failed']);
    expect(w.store.events.since(0).at(-1)?.data).toMatchObject({ to: c2, error: expect.stringMatching(/stopped while waiting/) });
    expect(existsSync(`${appDir}.next`)).toBe(false);
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v1');
    await new Promise((r) => setTimeout(r, 60));
    expect(restarts).toEqual([]);
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v1');
  });

  it('records update.applied at the next start when it stopped after the swap, before the restart ended', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    const c2 = w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    let restarting = false;
    const { u } = updater(w, appDir, { restart: () => { restarting = true; return new Promise(() => {}); } });
    await u.check();
    u.apply();
    await waitFor(async () => restarting);
    u.stop();
    updater(w, appDir).u.start();
    expect(types(w)).toEqual(['update.available', 'update.started', 'update.applied']);
    expect(w.store.events.since(0).at(-1)?.data).toEqual({ from: c1, to: c2, ref: 'stable' });
    expect(readFileSync(join(appDir, 'app.txt'), 'utf8')).toBe('v2');
  });

  it('records nothing more at the next start after an apply that failed while running', async () => {
    const w = world();
    const c1 = w.up.commit('first', 'v1');
    w.up.commit('second', 'v2');
    const appDir = createInstall(w.root, w.up.dir, c1);
    const { u } = updater(w, appDir, { builder: copyBuilder({ main: 'export const = ;\n' }) });
    await u.check();
    u.apply();
    await waitFor(async () => u.status().state === 'error');
    updater(w, appDir).u.start();
    expect(types(w)).toEqual(['update.available', 'update.started', 'update.failed']);
  });
});
