// Usage history (issues #385, #502): every usage reading a source gives is kept as a usage sample in the user's
// schema, once per reading (a source answers from its last read until it reads again). The usage graph
// reads it per account — the same account read on several machines is one series — and per graph step:
// the highest share of the limit used in each step, the gaps where no machine gave anything for the account
// (a failing or offline source), and where a usage window reset. Samples past the history retention are pruned.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import type { UsageSample } from '../../src/domain/types.ts';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
let store: UserStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const H = 3_600_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const sample = (at: number, used: number, o: Partial<UsageSample> = {}): UsageSample =>
  ({ source: 'work', window: 'session', used, limit: 100, unit: '%', at: iso(at), ...o });

const range = { from: new Date(T0), to: new Date(T0 + 24 * H), stepMs: H, originMs: T0 };

describe('usage history in the user store', () => {
  it('keeps a reading once: the same source, machine, window and time again adds nothing', () => {
    store = t.open(t.url());
    expect(store.usageHistory.record([sample(T0, 10), sample(T0, 10, { window: 'week' })])).toBe(2);
    expect(store.usageHistory.record([sample(T0, 10), sample(T0 + 600_000, 12)])).toBe(1);
    const series = store.usageHistory.series(range);
    expect(series.map((s) => [s.account, s.window, s.points.length])).toEqual([['work', 'session', 1], ['work', 'week', 1]]);
  });

  it('a point per graph step: its start and the highest share of the limit used in it; the series named by the account', () => {
    store = t.open(t.url());
    store.usageHistory.record([
      sample(T0 + 10 * 60_000, 20, { account: 'me@example.com' }), sample(T0 + 40 * 60_000, 35, { account: 'me@example.com' }),
      sample(T0 + H + 10 * 60_000, 5, { used: 5, limit: 10, unit: 'jobs', source: 'other', window: undefined, machineId: 'box', informational: true }),
    ]);
    const series = store.usageHistory.series(range);
    expect(series).toEqual([
      { account: 'me@example.com', window: 'session', informational: false, unit: '%', points: [{ at: iso(T0), usedFrac: 0.35 }], gaps: [], resets: [] },
      { account: 'other', informational: true, unit: 'jobs', points: [{ at: iso(T0 + H), usedFrac: 0.5 }], gaps: [], resets: [] },
    ]);
  });

  it('one series per account: the same account read on two machines is one series, the higher reading per step', () => {
    store = t.open(t.url());
    store.usageHistory.record([
      sample(T0 + 10 * 60_000, 20, { source: 'plan-a', machineId: 'a', account: 'me@example.com' }),
      sample(T0 + 20 * 60_000, 35, { source: 'plan-b', machineId: 'b', account: 'me@example.com' }),
      sample(T0 + H + 10 * 60_000, 40, { source: 'plan-a', machineId: 'a', account: 'me@example.com' }),
      sample(T0 + H + 20 * 60_000, 30, { source: 'plan-b', machineId: 'b', account: 'me@example.com' }),
      sample(T0 + 10 * 60_000, 70, { source: 'plan-c', machineId: 'c', account: 'other@example.com' }),
    ]);
    const series = store.usageHistory.series(range);
    expect(series.map((s) => [s.account, s.points.map((p) => p.usedFrac)])).toEqual([
      ['me@example.com', [0.35, 0.4]],
      ['other@example.com', [0.7]],
    ]);
  });

  it('a reading kept before its source knew the account counts as that account', () => {
    store = t.open(t.url());
    store.usageHistory.record([sample(T0, 10, { machineId: 'a' }), sample(T0 + H, 20, { machineId: 'a', account: 'me@example.com' })]);
    expect(store.usageHistory.series(range).map((s) => [s.account, s.points.length])).toEqual([['me@example.com', 2]]);
  });

  it('a stretch with no samples, far longer than the source reads, is a gap', () => {
    store = t.open(t.url());
    const tenMin = 600_000;
    const ats = [0, 1, 2, 3, 4, 5, 15, 16, 17].map((i) => T0 + i * tenMin);
    store.usageHistory.record(ats.map((at) => sample(at, 10)));
    const [s] = store.usageHistory.series({ ...range, stepMs: tenMin });
    expect(s!.gaps).toEqual([{ from: iso(T0 + 5 * tenMin), to: iso(T0 + 15 * tenMin) }]);
  });

  it('an account is a gap only where no machine read it: one machine going quiet is not', () => {
    store = t.open(t.url());
    const tenMin = 600_000;
    const at = (i: number) => T0 + i * tenMin;
    store.usageHistory.record([
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => sample(at(i), 10, { source: 'plan-a', machineId: 'a', account: 'me@example.com' })),
      ...[0, 1, 2].map((i) => sample(at(i) + 60_000, 10, { source: 'plan-b', machineId: 'b', account: 'me@example.com' })),
      ...[20, 21].map((i) => sample(at(i), 10, { source: 'plan-a', machineId: 'a', account: 'me@example.com' })),
    ]);
    const [s] = store.usageHistory.series({ ...range, stepMs: tenMin });
    expect(s!.gaps).toEqual([{ from: iso(at(9)), to: iso(at(20)) }]);
  });

  it('a usage window rolled over where its resetsAt moves on: the reset is at the old resetsAt, once however many machines read it', () => {
    store = t.open(t.url());
    const reset1 = iso(T0 + 3 * H);
    const reset2 = iso(T0 + 8 * H);
    const on = (machineId: string) => ({ source: `plan-${machineId}`, machineId, account: 'me@example.com' });
    store.usageHistory.record([
      sample(T0 + H, 50, { resetsAt: reset1, ...on('a') }), sample(T0 + 2 * H, 90, { resetsAt: reset1, ...on('a') }),
      sample(T0 + 4 * H, 0, { resetsAt: reset2, ...on('a') }), sample(T0 + 5 * H, 10, { resetsAt: reset2, ...on('a') }),
      sample(T0 + H + 60_000, 50, { resetsAt: reset1, ...on('b') }), sample(T0 + 4 * H + 60_000, 0, { resetsAt: reset2, ...on('b') }),
    ]);
    expect(store.usageHistory.series(range)[0]!.resets).toEqual([reset1]);
  });

  it('gaps and resets are the same at every graph step', () => {
    store = t.open(t.url());
    const reset1 = iso(T0 + 3 * H);
    const reset2 = iso(T0 + 30 * H);
    store.usageHistory.record([
      ...[0, 1, 2].map((h) => sample(T0 + h * H, 50, { resetsAt: reset1 })),
      ...[20, 21, 22].map((h) => sample(T0 + h * H, 10, { resetsAt: reset2 })),
    ]);
    const week = { ...range, to: new Date(T0 + 7 * 24 * H) };
    const at = (stepMs: number) => store!.usageHistory.series({ ...week, stepMs })[0]!;
    for (const stepMs of [H, 6 * H, 24 * H, 7 * 24 * H]) {
      expect(at(stepMs).gaps).toEqual([{ from: iso(T0 + 2 * H), to: iso(T0 + 20 * H) }]);
      expect(at(stepMs).resets).toEqual([reset1]);
    }
  });

  it('only the range asked: samples before `from` or from `to` on are left out', () => {
    store = t.open(t.url());
    store.usageHistory.record([sample(T0 - H, 1), sample(T0 + H, 2), sample(T0 + 24 * H, 3)]);
    expect(store.usageHistory.series(range)[0]!.points).toEqual([{ at: iso(T0 + H), usedFrac: 0.02 }]);
  });

  it('the totals count an account read on two machines once', () => {
    store = t.open(t.url());
    store.usageHistory.record([
      sample(T0 + 10 * 60_000, 20, { source: 'plan-a', machineId: 'a', account: 'me@example.com' }),
      sample(T0 + 20 * 60_000, 30, { source: 'plan-b', machineId: 'b', account: 'me@example.com' }),
      sample(T0 + 30 * 60_000, 50, { source: 'plan-c', machineId: 'c', account: 'other@example.com' }),
    ]);
    expect(store.usageHistory.totals(range)).toEqual([
      { unit: '%', window: 'session', informational: false, points: [{ at: iso(T0), used: 80, limit: 200, series: 2 }] },
    ]);
  });

  it('prune deletes the samples older than the time given', () => {
    store = t.open(t.url());
    store.usageHistory.record([sample(T0, 1), sample(T0 + H, 2), sample(T0 + 2 * H, 3)]);
    expect(store.usageHistory.prune(new Date(T0 + H))).toBe(1);
    expect(store.usageHistory.series(range)[0]!.points.map((p) => p.at)).toEqual([iso(T0 + H), iso(T0 + 2 * H)]);
  });

  it('the usage graph view and the history retention are the user\'s settings', () => {
    store = t.open(t.url());
    expect(store.settings.getUsageGraphView()).toBeUndefined();
    expect(store.settings.getHistoryRetentionDays()).toBeUndefined();
    store.settings.setUsageGraphView({ range: { preset: '30d' } });
    store.settings.setHistoryRetentionDays(14);
    expect(store.settings.getUsageGraphView()).toEqual({ range: { preset: '30d' } });
    expect(store.settings.getHistoryRetentionDays()).toBe(14);
  });

  it('a view saved by the build before reads as its range; a view saved now keeps its step for the build before', () => {
    const url = t.url();
    store = t.open(url);
    const u = new URL(url);
    u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
    const raw = openDb(u.toString());
    const stored = () => JSON.parse(raw.get("SELECT value FROM settings WHERE key = 'usageGraphView'")!.value as string) as unknown;
    raw.run("INSERT INTO settings (key, value) VALUES ('usageGraphView', ?)", JSON.stringify({ range: { preset: '3d' }, step: '15m' }));
    expect(store.settings.getUsageGraphView()).toEqual({ range: { preset: '3d' } });
    store.settings.setUsageGraphView({ range: { preset: '24h' } });
    expect(stored()).toEqual({ range: { preset: '24h' }, step: '1h' });
    store.settings.setUsageGraphView({ range: { preset: '7d' } });
    expect(stored()).toEqual({ range: { preset: '7d' }, step: '1d' });
    raw.close();
  });
});
