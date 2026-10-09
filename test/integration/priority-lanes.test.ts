// Issue #535: priority lanes through the real daemon, store and HTTP server. The hopper measures each lane from its
// own history and makes the most reliable ones priority lanes; GET /api/priority-lanes shows the figures and why;
// an admin's settings (the threshold, the count, keep-free or share, the window, the minimum runs, a manual choice)
// are stored and apply to the next Decision without a restart; a high-priority job takes a free priority lane
// ahead of the default jobs waiting.
import { afterEach, describe, expect, it } from 'vitest';
import type { PriorityLanesView } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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
  const a = await startTestApp({ dbPath: path, plugins: { machines: lanes(2) } });
  apps.push(a);
  return a;
}

const view = async (a: TestApp) => (await a.api<PriorityLanesView>('GET', '/api/priority-lanes')).body;
const HIGH = { priority: 80, priorityReason: 'label:hopper:high' };

describe('priority lanes', () => {
  it('none before any lane has history; every lane listed with why', async () => {
    const a = await boot();
    const v = await view(a);
    expect(v).toMatchObject({ settings: { highPriority: 75, count: 1, whenIdle: 'keep-free', windowDays: 14, minRuns: 5 }, chosen: [], by: 'none' });
    expect(v.lanes.map((l) => [l.laneId, l.reason])).toEqual([
      ['local/lane-1', 'not ranked: 0 of the 5 runs needed in 14 days'],
      ['local/lane-2', 'not ranked: 0 of the 5 runs needed in 14 days'],
    ]);
  });

  it('the most reliable lane becomes the priority lane once it has the runs; the event says so', async () => {
    const a = await boot();
    for (let i = 0; i < 3; i++) await a.waitForStatus((await a.pull({ op: 'echo' })).id, 'finished');
    const admin = await a.login();
    expect((await a.ui('/ui/api/priority-lanes/settings', { minRuns: 3 }, { token: admin })).status).toBe(200);
    const v = await waitFor(async () => { const x = await view(a); return x.by === 'reliability' ? x : undefined; });
    expect(v.chosen).toEqual(['local/lane-1']);
    expect(v.lanes[0]).toMatchObject({ laneId: 'local/lane-1', runs: 3, finished: 3, laneFaults: 0, rank: 1, priority: true });
    expect((await a.events('types=priority_lanes.changed')).map((e) => e.data)).toEqual([{ from: [], to: ['local/lane-1'], by: 'reliability' }]);
    expect((await a.events('types=priority_lanes.settings_changed')).map((e) => e.data.to)).toEqual([expect.objectContaining({ minRuns: 3 })]);
  });

  it('a high-priority job takes the free priority lane ahead of the default jobs waiting; they keep off it', async () => {
    const a = await boot();
    const admin = await a.login();
    expect((await a.ui('/ui/api/priority-lanes/settings', { manual: ['local/lane-2'] }, { token: admin })).status).toBe(200);
    expect(await view(a)).toMatchObject({ chosen: ['local/lane-2'], by: 'manual' });

    const busy = await a.pull({ op: 'sleep', ms: 30_000 });
    expect((await a.waitForStatus(busy.id, 'running')).laneId).toBe('local/lane-1');
    const plain = await a.pull({ op: 'echo' });
    const waiting = await waitFor(async () => { const j = await a.job(plain.id); return j.waitReason ? j : undefined; });
    expect(waiting.waitReason).toBe('waiting for a lane: machine local keeps priority lane local/lane-2 free for high-priority jobs, the other 1 are in use');

    const urgent = await a.pull({ op: 'echo' }, HIGH);
    const done = await a.waitForStatus(urgent.id, 'finished');
    expect(done.laneId).toBe('local/lane-2');
    expect((await a.job(plain.id)).status).toBe('queued');

    // share: the default job takes the priority lane once nothing else is free.
    expect((await a.ui('/ui/api/priority-lanes/settings', { whenIdle: 'share' }, { token: admin })).status).toBe(200);
    await a.waitForStatus(plain.id, 'finished');
  });

  it('settings outside their bounds are refused, and are not a viewer\'s to set', async () => {
    const a = await boot();
    const admin = await a.login();
    for (const body of [{ count: -1 }, { highPriority: 0 }, { highPriority: 101 }, { whenIdle: 'sometimes' }, { windowDays: 0 }, { minRuns: 0 }, { manual: ['nowhere'] }]) {
      expect((await a.ui('/ui/api/priority-lanes/settings', body, { token: admin })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await view(a)).settings).toMatchObject({ count: 1, highPriority: 75 });

    const db = tempDbPath();
    cleanups.push(db.cleanup);
    writeConfig(db.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
    const b = await boot(db.dbPath);
    const viewer = (await b.ui<{ token: string }>('/ui/auth/none', {})).body.token;
    expect((await b.ui('/ui/api/priority-lanes/settings', { count: 2 }, { token: viewer })).status).toBe(403);
  });

  it('the settings outlive a restart; manual: null goes back to the ranking', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await boot(db.dbPath);
    await a.ui('/ui/api/priority-lanes/settings', { highPriority: 60, manual: ['local/lane-1'] }, { token: await a.login() });
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    const b = await boot(db.dbPath);
    expect(await view(b)).toMatchObject({ settings: { highPriority: 60, manual: ['local/lane-1'] }, chosen: ['local/lane-1'] });
    expect((await b.api('GET', '/api/queue')).body.highPriority).toBe(60);
    await b.ui('/ui/api/priority-lanes/settings', { manual: null }, { token: await b.login() });
    expect(await view(b)).toMatchObject({ by: 'none', chosen: [] });
    expect((await view(b)).settings.manual).toBeUndefined();
  });
});
