// Usage history (issue #385): every usage reading a source gives is kept as a usage sample in the user's
// schema, once per reading (a source answers from its last read until it reads again). The usage graph
// reads it per graph step: the highest share of the limit used in each step, the gaps where a source gave
// nothing (a failing or offline source), and where a usage window reset. Samples past the history
// retention are pruned.
import { afterEach, describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import type { UsageSample } from '../../src/domain/types.ts';
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
    expect(series.map((s) => [s.source, s.window, s.points.length])).toEqual([['work', 'session', 1], ['work', 'week', 1]]);
  });

  it('a point per graph step: its start and the highest share of the limit used in it; the account the readings were for', () => {
    store = t.open(t.url());
    store.usageHistory.record([
      sample(T0 + 10 * 60_000, 20, { account: 'me@example.com' }), sample(T0 + 40 * 60_000, 35, { account: 'me@example.com' }),
      sample(T0 + H + 10 * 60_000, 5, { used: 5, limit: 10, unit: 'jobs', source: 'other', window: undefined, machineId: 'box', informational: true }),
    ]);
    const series = store.usageHistory.series(range);
    expect(series).toEqual([
      { source: 'other', machineId: 'box', informational: true, unit: 'jobs', points: [{ at: iso(T0 + H), usedFrac: 0.5 }], gaps: [], resets: [] },
      { source: 'work', window: 'session', informational: false, unit: '%', account: 'me@example.com', points: [{ at: iso(T0), usedFrac: 0.35 }], gaps: [], resets: [] },
    ]);
  });

  it('a stretch with no samples, far longer than the source reads, is a gap', () => {
    store = t.open(t.url());
    const tenMin = 600_000;
    const ats = [0, 1, 2, 3, 4, 5, 15, 16, 17].map((i) => T0 + i * tenMin);
    store.usageHistory.record(ats.map((at) => sample(at, 10)));
    const [s] = store.usageHistory.series({ ...range, stepMs: tenMin });
    expect(s!.gaps).toEqual([{ from: iso(T0 + 5 * tenMin), to: iso(T0 + 15 * tenMin) }]);
  });

  it('a usage window rolled over where its resetsAt moves on: the reset is at the old resetsAt', () => {
    store = t.open(t.url());
    const reset1 = iso(T0 + 3 * H);
    const reset2 = iso(T0 + 8 * H);
    store.usageHistory.record([
      sample(T0 + H, 50, { resetsAt: reset1 }), sample(T0 + 2 * H, 90, { resetsAt: reset1 }),
      sample(T0 + 4 * H, 0, { resetsAt: reset2 }), sample(T0 + 5 * H, 10, { resetsAt: reset2 }),
    ]);
    expect(store.usageHistory.series(range)[0]!.resets).toEqual([reset1]);
  });

  it('only the range asked: samples before `from` or from `to` on are left out', () => {
    store = t.open(t.url());
    store.usageHistory.record([sample(T0 - H, 1), sample(T0 + H, 2), sample(T0 + 24 * H, 3)]);
    expect(store.usageHistory.series(range)[0]!.points).toEqual([{ at: iso(T0 + H), usedFrac: 0.02 }]);
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
    store.settings.setUsageGraphView({ range: { preset: '30d' }, step: '1d' });
    store.settings.setHistoryRetentionDays(14);
    expect(store.settings.getUsageGraphView()).toEqual({ range: { preset: '30d' }, step: '1d' });
    expect(store.settings.getHistoryRetentionDays()).toBe(14);
  });
});
