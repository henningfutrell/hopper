// The daily usage trend in the database (issue #2966 part 4, tenant migration 110): one row per account and UTC day, counts
// only. A day read again is one row with the newest counts; a store opened again reads them back; a row older than the days
// kept goes at the next keep.
import { describe, expect, it } from 'vitest';
import type { DailyUsage } from '../../src/domain/usage.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const day = (account: string, date: string, over: Partial<DailyUsage> = {}): DailyUsage => ({
  account, date, costCents: 113.75, tokens: { input: 100, output: 35, cacheRead: 10, cacheCreation: 5 },
  sessions: 5, commits: 12, pullRequests: 2, linesAdded: 1543, linesRemoved: 892, toolActions: { accepted: 53, rejected: 6 }, ...over,
});

describe('the daily usage in the database', () => {
  it('keeps one row per account and day, the newest read of a day replaces it, and reads them back after a restart', () => {
    const url = t.url();
    const store = t.open(url);
    store.dailyUsage.keep([day('a@example.com', '2026-10-01'), day('b@example.com', '2026-10-01')], '2026-07-01');
    store.dailyUsage.keep([day('a@example.com', '2026-10-01', { costCents: 200.5, sessions: 7 }), day('a@example.com', '2026-10-02')], '2026-07-01');
    store.close();
    const again = t.open(url);
    expect(again.dailyUsage.since('2026-09-01')).toEqual([
      day('a@example.com', '2026-10-01', { costCents: 200.5, sessions: 7 }), day('b@example.com', '2026-10-01'), day('a@example.com', '2026-10-02'),
    ]);
    expect(again.dailyUsage.since('2026-10-02')).toEqual([day('a@example.com', '2026-10-02')]);
    again.close();
  });

  it('drops the rows older than the first day kept', () => {
    const store = t.open(t.url());
    store.dailyUsage.keep([day('a@example.com', '2026-06-30'), day('a@example.com', '2026-07-01')], '2026-01-01');
    store.dailyUsage.keep([day('a@example.com', '2026-10-01')], '2026-07-01');
    expect(store.dailyUsage.since('2000-01-01').map((d) => d.date)).toEqual(['2026-07-01', '2026-10-01']);
    store.close();
  });
});
