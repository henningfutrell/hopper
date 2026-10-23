// The disk defaults (issue #2494, design.md "Hopper's own disk use" → "Part 13") through the real daemon and store: an admin
// sets the disk thresholds and the sweep settings every machine takes where its own options are silent, or clears them;
// GET /api/machines/disk-defaults reads them, and GET /api/machines shows them applied.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

const DEFAULTS = {
  diskLow: { belowPercent: 100 },
  sweep: { everyMinutes: 30, retainHours: { failed: 48 }, pruneAfterDays: 7, trimAboveGiB: 20, cacheCapsGiB: { npm: 5 } },
};

describe('the disk defaults', () => {
  it('none at first; an admin sets them, they are read back, and null clears them; a value out of range is 400', async () => {
    const a = await boot();
    const admin = await a.login();
    const read = async () => (await a.api<{ diskDefaults: unknown }>('GET', '/api/machines/disk-defaults', undefined, { 'x-hopper-session': admin })).body.diskDefaults;
    expect(await read()).toBeNull();
    expect((await a.ui('/ui/api/machines/disk-defaults', { defaults: { sweep: { pruneAfterDays: 0 } } }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/machines/disk-defaults', { defaults: { sweep: { cacheCapsGiB: { cache: 1 } } } }, { token: admin })).status).toBe(400);
    const set = await a.ui<{ diskDefaults: unknown }>('/ui/api/machines/disk-defaults', { defaults: DEFAULTS }, { token: admin });
    expect(set.status).toBe(200);
    expect(set.body.diskDefaults).toEqual(DEFAULTS);
    expect(await read()).toEqual(DEFAULTS);
    const off = await a.ui<{ diskDefaults: unknown }>('/ui/api/machines/disk-defaults', { defaults: null }, { token: admin });
    expect(off.body.diskDefaults).toBeNull();
    expect(await read()).toBeNull();
  });

  it('applies to a machine with no options of its own: its sweep takes them and its disk is judged by them', async () => {
    const a = await boot();
    const admin = await a.login();
    const local = async () => (await a.api<{ machines: MachineSnapshot[] }>('GET', '/api/machines', undefined, { 'x-hopper-session': admin })).body.machines.find((m) => !m.ssh && !m.containerImage);
    const before = await local();
    expect(before?.sweep?.pruneAfterDays).toBeUndefined();
    expect((await a.ui('/ui/api/machines/disk-defaults', { defaults: DEFAULTS }, { token: admin })).status).toBe(200);
    await expect.poll(async () => (await local())?.sweep, { timeout: 5000 }).toEqual(DEFAULTS.sweep);
    // Below 100% free is low whatever the disk holds.
    if (before?.disk) await expect.poll(async () => (await local())?.disk?.low, { timeout: 5000 }).toBe(true);
  });
});
