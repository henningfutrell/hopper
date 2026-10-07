// Usage history and the usage graph (issue #385) through the real daemon, store and HTTP server: every
// reading of every usage source is kept as a usage sample in the user's schema; GET /api/usage/history
// answers the usage graph — the last 7 days per hour unless the user chose otherwise, the choice kept for
// the user; the history retention is the user's setting, applied at once; the history outlives a restart;
// one user never reads another's, and the instance admin reads totals only.
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceUsageHistory, UsageHistory, UsageSample } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';

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
  const a = await startTestApp({ dbPath: path });
  apps.push(a);
  return a;
}

const session = (token: string) => ({ 'x-hopper-session': token });
const history = async (a: TestApp, query = '', headers: Record<string, string> = {}) => a.api<UsageHistory>('GET', `/api/usage/history${query}`, undefined, headers);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const old = (at: number, used: number): UsageSample => ({ source: 'plan', window: 'session', used, limit: 100, unit: '%', at: new Date(at).toISOString() });

describe('usage history', () => {
  it('each reading is kept once; the usage graph is the last 7 days per hour by default', async () => {
    const a = await boot();
    a.setUsage(40);
    expect(await a.user().usageHistory.record()).toBe(1);
    // The source answers from the same read: nothing new.
    expect(await a.user().usageHistory.record()).toBe(0);
    a.setUsage(55);
    expect(await a.user().usageHistory.record()).toBe(1);

    const r = await history(a);
    expect(r.status).toBe(200);
    expect(r.body.view).toEqual({ range: { preset: '7d' }, step: '1h' });
    expect(r.body.stepMs).toBe(HOUR);
    expect(Date.parse(r.body.to) - Date.parse(r.body.from)).toBe(7 * DAY);
    expect(r.body.retentionDays).toBe(90);
    expect(r.body.series).toEqual([expect.objectContaining({ source: 'fake', informational: false, unit: '%' })]);
    const points = r.body.series[0]!.points;
    expect(points.at(-1)!.usedFrac).toBe(0.55);
  });

  it('the graph range and graph step: asked in the query, or the user\'s saved choice; a viewer saves their own', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    writeConfig(db.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
    const a = await boot(db.dbPath);
    const viewer = (await a.ui<{ token: string }>('/ui/auth/none', {})).body.token;

    const asked = await history(a, '?range=24h&step=15m', session(viewer));
    expect(asked.body.view).toEqual({ range: { preset: '24h' }, step: '15m' });
    expect(Date.parse(asked.body.to) - Date.parse(asked.body.from)).toBe(DAY);
    // Asking is not choosing: the saved view is still the default.
    expect((await history(a, '', session(viewer))).body.view).toEqual({ range: { preset: '7d' }, step: '1h' });

    const custom = { range: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' }, step: '1d' };
    const saved = await a.ui('/ui/api/usage-history/view', custom, { token: viewer });
    expect(saved.status).toBe(200);
    const r = await history(a, '', session(viewer));
    expect(r.body.view).toEqual(custom);
    expect([r.body.from, r.body.to, r.body.stepMs]).toEqual([custom.range.from, custom.range.to, DAY]);

    expect((await a.ui('/ui/api/usage-history/view', { range: { preset: '2y' }, step: '1h' }, { token: viewer })).status).toBe(400);
    expect((await a.ui('/ui/api/usage-history/view', { range: { from: custom.range.to, to: custom.range.from }, step: '1h' }, { token: viewer })).status).toBe(400);
    // The history retention is not a viewer's to change.
    expect((await a.ui('/ui/api/usage-history/retention', { days: 7 }, { token: viewer })).status).toBe(403);
  });

  it('the history retention applies at once: older samples are pruned', async () => {
    const a = await boot();
    const admin = await a.login();
    const now = Date.now();
    a.user().store.usageHistory.record([old(now - 10 * DAY, 10), old(now - 2 * DAY, 20)]);
    const r = await a.ui<UsageHistory>('/ui/api/usage-history/retention', { days: 5 }, { token: admin });
    expect(r.status).toBe(200);
    const after = await history(a, '?range=30d&step=1d', session(admin));
    expect(after.body.retentionDays).toBe(5);
    expect(after.body.series.find((s) => s.source === 'plan')!.points.map((p) => p.usedFrac)).toEqual([0.2]);
    expect((await a.ui('/ui/api/usage-history/retention', { days: 0 }, { token: admin })).status).toBe(400);
  });

  it('the history outlives a restart: it is in the database', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await boot(db.dbPath);
    a.setUsage(30);
    await a.user().usageHistory.record();
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    const b = await boot(db.dbPath);
    const r = await history(b);
    expect(r.body.series.find((s) => s.source === 'fake')!.points.map((p) => p.usedFrac)).toEqual([0.3]);
  });

  it('a user reads their own history only; the instance admin reads totals, nothing named', async () => {
    const a = await boot();
    const admin = await a.login();
    const added = await a.ui<{ links: string[] }>('/ui/api/users', { action: 'add', name: 'Bea' }, { token: admin });
    const bea = await a.loginWith(/#login=([0-9a-f]{64})$/.exec(added.body.links[0]!)![1]!);
    const now = Date.now();
    a.user().store.usageHistory.record([{ ...old(now - HOUR, 40), account: 'owner@example.test' }]);
    a.user('bea').store.usageHistory.record([{ ...old(now - HOUR, 50), source: 'bea-plan', account: 'bea@example.test' }]);

    // Each test user also has the harness's fake source, recorded as the runtime starts.
    const mine = await history(a, '', session(admin));
    expect(mine.body.series.map((s) => s.source)).toEqual(['fake', 'plan']);
    const hers = await history(a, '', session(bea));
    expect(hers.body.series.map((s) => s.source)).toEqual(['bea-plan', 'fake']);
    expect(JSON.stringify(hers.body)).not.toContain('owner@example');

    const totals = await a.api<InstanceUsageHistory>('GET', '/api/instance/usage-history', undefined, session(admin));
    expect(totals.status).toBe(200);
    expect(totals.body.totals.find((s) => s.window === 'session')).toEqual({ unit: '%', window: 'session', informational: false, points: [{ at: expect.any(String), usedFrac: 0.45, series: 2 }] });
    expect(JSON.stringify(totals.body)).not.toMatch(/plan|fake|example\.test|bea|Bea/);
    expect((await a.api('GET', '/api/instance/usage-history', undefined, session(bea))).status).toBe(403);
  });
});
