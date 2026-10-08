// Issue #409: every build knows what it was built from — an image as much as an install. The update check and the
// version history read an image's install.json as an install's; apply never swaps an image; a build that lacks a
// field still says what it does know. Real git repositories, as in updater.test.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyBuilder, createInstall, readInstall } from './support.ts';
import { types, updater, world } from './world.ts';

describe('what a build knows of itself', () => {
  it('reads an image build the same as an install: the check and the version history from what it was built from (issue #409)', async () => {
    const w = world();
    w.up.whatsNew(['First.']);
    const c1 = w.up.commit('first');
    w.up.whatsNew(['Second.', 'First.']);
    const c2 = w.up.commit('second');
    const { u } = updater(w, createInstall(w.root, w.up.dir, c1, 'stable', 'image'));
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', installed: { kind: 'image', commit: c1 }, target: { commit: c2 } });
    expect(s.whatsNew).toEqual(['Second.']);
    const h = await u.history();
    expect(h.reason).toBeUndefined();
    expect(h.build).toMatchObject({ kind: 'image', repo: w.up.dir, branch: 'stable', commit: c1 });
    expect(h.versions.map((v) => v.commit)).toEqual([c1]);
  });

  it('never applies to an image build: the image is replaced by pulling or rebuilding it, not swapped in place (issue #409)', async () => {
    const w = world();
    const c1 = w.up.commit('first');
    w.up.commit('second');
    const calls: string[] = [];
    const { u, restarts } = updater(w, createInstall(w.root, w.up.dir, c1, 'stable', 'image'), { builder: copyBuilder({ calls }) });
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
    writeFileSync(join(appDir, 'install.json'), JSON.stringify({ kind: 'image', repo: w.up.dir, branch: 'stable', installedAt: '2026-10-07T12:00:00.000Z' }));
    const { u } = updater(w, appDir);
    const h = await u.history();
    expect(h.versions).toEqual([]);
    expect(h.build).toEqual({ kind: 'image', repo: w.up.dir, branch: 'stable', installedAt: '2026-10-07T12:00:00.000Z' });
    expect(h.reason).toMatch(/commit/);
    expect(h.reason).not.toMatch(/repository/);
    const s = await u.check();
    expect(s.state).toBe('unavailable');
    expect(s.reason).toMatch(/commit/);
  });
});
