// The disk budget (issue #1120, design.md "Hopper's own disk use" → "Part 2") through the real daemon and store: an admin
// sets the most the hopper's own disk use may be on each machine, or turns it off; GET /api/machines/disk-budget reads it.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const GB = 1e9;
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

describe('the disk budget', () => {
  it('none at first; an admin sets it, it is read back, and null turns it off; a budget not above 0 is 400', async () => {
    const a = await boot();
    const admin = await a.login();
    const read = async () => (await a.api<{ diskBudget: unknown }>('GET', '/api/machines/disk-budget', undefined, { 'x-hopper-session': admin })).body.diskBudget;
    expect(await read()).toBeNull();
    expect((await a.ui('/ui/api/machines/disk-budget', { budget: { bytes: 0 } }, { token: admin })).status).toBe(400);
    const set = await a.ui<{ diskBudget: unknown }>('/ui/api/machines/disk-budget', { budget: { bytes: 50 * GB } }, { token: admin });
    expect(set.status).toBe(200);
    expect(set.body.diskBudget).toEqual({ bytes: 50 * GB });
    expect(await read()).toEqual({ bytes: 50 * GB });
    const off = await a.ui<{ diskBudget: unknown }>('/ui/api/machines/disk-budget', { budget: null }, { token: admin });
    expect(off.body.diskBudget).toBeNull();
    expect(await read()).toBeNull();
  });
});
