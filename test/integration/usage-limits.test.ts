// The usage limits set in the UI (issue #522) through the real daemon, store and HTTP server: the soft and hard
// limits default to HOPPER_SOFT_LIMIT / HOPPER_HARD_LIMIT; an admin sets them through the UI session, the stored
// limits win over the environment from then on, apply to the next Decision without a restart, and outlive one;
// a soft limit at or above the hard one is refused; the change is a usage.limits_changed event.
import { afterEach, describe, expect, it } from 'vitest';
import type { Decision, UsageReport } from '../../src/domain/types.ts';
import { lanes as laneCount, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath?: string): Promise<TestApp> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  const a = await startTestApp({ dbPath: path, plugins: { machines: laneCount(2) } });
  apps.push(a);
  return a;
}

const usage = async (a: TestApp) => (await a.api<UsageReport>('GET', '/api/usage')).body;

describe('usage limits', () => {
  it('default to the environment, and say so', async () => {
    const a = await boot();
    expect((await usage(a)).limits).toEqual({ soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false });
  });

  it('an admin sets them; the next Decision decides by them, without a restart', async () => {
    const a = await boot();
    const admin = await a.login();
    a.setUsage(50);
    const before = await a.pull({ op: 'echo' });
    await a.waitForStatus(before.id, 'finished');

    const r = await a.ui<{ limits: UsageReport['limits'] }>('/ui/api/usage/limits', { soft: 0.3, hard: 0.4 }, { token: admin });
    expect(r.status).toBe(200);
    expect(r.body.limits).toEqual({ soft: 0.3, hard: 0.4, defaults: { soft: 0.7, hard: 0.95 }, set: true });
    const report = await usage(a);
    expect(report.limits).toMatchObject({ soft: 0.3, hard: 0.4, set: true });
    expect(report.machines[0]).toMatchObject({ band: 'hard', cap: 0 });

    // 50% is past the new hard limit: a job waits for a lane.
    const held = await a.pull({ op: 'echo' });
    const h = await waitFor(async () => { const j = await a.job(held.id); return j.waitReason ? j : undefined; });
    expect(h.waitReason).toMatch(/usage hard limit/);
    const { decisions } = (await a.api<{ decisions: Decision[] }>('GET', '/api/decisions?limit=5')).body;
    expect(decisions[0]!.inputs.policy).toMatchObject({ softLimit: 0.3, hardLimit: 0.4 });

    expect((await a.events('types=usage.limits_changed')).map((e) => e.data)).toEqual([
      { from: { soft: 0.7, hard: 0.95 }, to: { soft: 0.3, hard: 0.4 } },
    ]);

    // Raised again: the held job starts.
    await a.ui('/ui/api/usage/limits', { soft: 0.6, hard: 0.9 }, { token: admin });
    await a.waitForStatus(held.id, 'finished');
  });

  it('refuse a soft limit at or above the hard one, and a fraction out of 0..1', async () => {
    const a = await boot();
    const admin = await a.login();
    for (const body of [{ soft: 0.8, hard: 0.8 }, { soft: 0.9, hard: 0.5 }, { soft: -0.1, hard: 0.5 }, { soft: 0.5, hard: 1.2 }, { soft: 0.5 }]) {
      expect((await a.ui('/ui/api/usage/limits', body, { token: admin })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await usage(a)).limits.set).toBe(false);
  });

  it('are not a viewer\'s to set', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    writeConfig(db.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
    const a = await boot(db.dbPath);
    const viewer = (await a.ui<{ token: string }>('/ui/auth/none', {})).body.token;
    expect((await a.ui('/ui/api/usage/limits', { soft: 0.5, hard: 0.6 }, { token: viewer })).status).toBe(403);
  });

  it('outlive a restart: the stored limits win over the environment', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await boot(db.dbPath);
    await a.ui('/ui/api/usage/limits', { soft: 0.5, hard: 0.8 }, { token: await a.login() });
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    const b = await boot(db.dbPath);
    expect((await usage(b)).limits).toMatchObject({ soft: 0.5, hard: 0.8, set: true });
  });
});
