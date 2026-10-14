// Usage history and the usage graph (issues #385, #502) through the real daemon, store and HTTP server: every
// reading of every usage source is kept as a usage sample in the user's schema; GET /api/usage/history
// answers the usage graph — the last 7 days per day unless the user chose another range, the choice kept for
// the user, and the graph step following the range down to an hour; new samples are pushed on the event
// stream; the history retention is the user's setting, applied at once; the history outlives a restart;
// one user never reads another's, and the instance admin reads totals only.
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceUsageHistory, UsageHistory, UsageSample } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';
import { openSse, type SseClient } from '../support/sse.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
let sse: SseClient | undefined;
afterEach(async () => {
  sse?.close();
  sse = undefined;
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
  it('each reading is kept once; the usage graph is the last 7 days per day by default', async () => {
    const a = await boot();
    a.setUsage(40);
    expect(await a.user().usageHistory.record()).toBe(1);
    // The source answers from the same read: nothing new.
    expect(await a.user().usageHistory.record()).toBe(0);
    a.setUsage(55);
    expect(await a.user().usageHistory.record()).toBe(1);

    const r = await history(a);
    expect(r.status).toBe(200);
    expect(r.body.view).toEqual({ range: { preset: '7d' } });
    expect(r.body.stepMs).toBe(DAY);
    expect(Date.parse(r.body.to) - Date.parse(r.body.from)).toBe(7 * DAY);
    expect(r.body.retentionDays).toBe(90);
    expect(r.body.series).toEqual([expect.objectContaining({ account: 'fake', informational: false, unit: '%' })]);
    const points = r.body.series[0]!.points;
    expect(points.at(-1)!.usedFrac).toBe(0.55);
  });

  it('the graph step follows the graph range: an hour zoomed in, a day at the week, a week past two months', async () => {
    const a = await boot();
    const to = Date.parse('2026-10-08T00:00:00.000Z');
    const stretch = (days: number) => `?from=${new Date(to - days * DAY).toISOString()}&to=${new Date(to).toISOString()}`;
    const stepOf = async (query: string) => (await history(a, query)).body.stepMs;
    expect(await stepOf(stretch(0.25))).toBe(HOUR);
    expect(await stepOf(stretch(2))).toBe(HOUR);
    expect(await stepOf(stretch(3))).toBe(6 * HOUR);
    expect(await stepOf(stretch(7))).toBe(DAY);
    expect(await stepOf(stretch(90))).toBe(7 * DAY);
    expect(await stepOf('?range=24h')).toBe(HOUR);
    expect(await stepOf('?range=30d')).toBe(DAY);
    const zoomed = await history(a, stretch(1));
    expect([zoomed.body.from, zoomed.body.to]).toEqual([new Date(to - DAY).toISOString(), new Date(to).toISOString()]);
  });

  it('the graph range: asked in the query, or the user\'s saved choice; a viewer saves their own', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    writeConfig(db.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
    const a = await boot(db.dbPath);
    const viewer = (await a.ui<{ token: string }>('/ui/auth/none', {})).body.token;

    const asked = await history(a, '?range=24h', session(viewer));
    expect(asked.body.view).toEqual({ range: { preset: '24h' } });
    expect(Date.parse(asked.body.to) - Date.parse(asked.body.from)).toBe(DAY);
    // Asking is not choosing: the saved view is still the default.
    expect((await history(a, '', session(viewer))).body.view).toEqual({ range: { preset: '7d' } });

    const saved = await a.ui('/ui/api/usage-history/view', { range: { preset: '30d' } }, { token: viewer });
    expect(saved.status).toBe(200);
    const r = await history(a, '', session(viewer));
    expect(r.body.view).toEqual({ range: { preset: '30d' } });
    expect([Date.parse(r.body.to) - Date.parse(r.body.from), r.body.stepMs]).toEqual([30 * DAY, DAY]);

    expect((await a.ui('/ui/api/usage-history/view', { range: { preset: '2y' } }, { token: viewer })).status).toBe(400);
    expect((await a.ui('/ui/api/usage-history/view', { range: { from: '2026-09-15T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' } }, { token: viewer })).status).toBe(400);
    // The history retention is not a viewer's to change.
    expect((await a.ui('/ui/api/usage-history/retention', { days: 7 }, { token: viewer })).status).toBe(403);
  });

  it('new samples are pushed on the event stream as usage.recorded (no id); a record that adds nothing pushes nothing', async () => {
    const a = await boot();
    sse = await openSse(`${a.url}/api/events/stream`);
    a.setUsage(10);
    await a.user().usageHistory.record();
    const m = await waitFor(() => sse!.messages.find((x) => x.event === 'usage.recorded'));
    expect(m.id).toBeUndefined();
    expect(JSON.parse(m.data)).toEqual({ added: 1 });
    await a.user().usageHistory.record();
    a.setUsage(20);
    await a.user().usageHistory.record();
    await waitFor(() => sse!.messages.filter((x) => x.event === 'usage.recorded').length === 2 || undefined);
    expect(sse.messages.filter((x) => x.event === 'usage.recorded').map((x) => JSON.parse(x.data))).toEqual([{ added: 1 }, { added: 1 }]);
  });

  it('the history retention applies at once: older samples are pruned', async () => {
    const a = await boot();
    const admin = await a.login();
    const now = Date.now();
    a.user().store.usageHistory.record([old(now - 10 * DAY, 10), old(now - 2 * DAY, 20)]);
    const r = await a.ui<UsageHistory>('/ui/api/usage-history/retention', { days: 5 }, { token: admin });
    expect(r.status).toBe(200);
    const after = await history(a, '?range=30d', session(admin));
    expect(after.body.retentionDays).toBe(5);
    expect(after.body.series.find((s) => s.account === 'plan')!.points.map((p) => p.usedFrac)).toEqual([0.2]);
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
    expect(r.body.series.find((s) => s.account === 'fake')!.points.map((p) => p.usedFrac)).toEqual([0.3]);
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
    expect(mine.body.series.map((s) => s.account)).toEqual(['fake', 'owner@example.test']);
    const hers = await history(a, '', session(bea));
    expect(hers.body.series.map((s) => s.account)).toEqual(['bea@example.test', 'fake']);
    expect(JSON.stringify(hers.body)).not.toContain('owner@example');

    const totals = await a.api<InstanceUsageHistory>('GET', '/api/instance/usage-history', undefined, session(admin));
    expect(totals.status).toBe(200);
    expect(totals.body.totals.find((s) => s.window === 'session')).toEqual({ unit: '%', window: 'session', informational: false, points: [{ at: expect.any(String), usedFrac: 0.45, series: 2 }] });
    expect(JSON.stringify(totals.body)).not.toMatch(/plan|fake|example\.test|bea|Bea/);
    expect((await a.api('GET', '/api/instance/usage-history', undefined, session(bea))).status).toBe(403);
  });
});
