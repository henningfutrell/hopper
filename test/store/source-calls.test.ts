// The call log (issue #1264, a tenant migration): the calls each job source's sync passes made, a row per source and
// minute, so Sources shows each source's calls in the last hour and day from the database, after a restart too.
import { describe, expect, it } from 'vitest';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const at = (iso: string) => new Date(iso).toISOString();

describe('the call log', () => {
  it('adds the calls of passes in the same minute, and sums the last hour and the last day per source', () => {
    const url = t.url();
    const store = t.open(url);
    const now = '2026-10-15T12:00:30.000Z';
    expect(store.sourceCalls.volume('github-account', now)).toEqual({ lastHour: 0, lastDay: 0 });
    store.sourceCalls.record('github-account', at('2026-10-15T12:00:05Z'), 3);
    store.sourceCalls.record('github-account', at('2026-10-15T12:00:20Z'), 2);
    store.sourceCalls.record('github-account', at('2026-10-15T11:30:00Z'), 10);
    store.sourceCalls.record('github-account', at('2026-10-15T02:00:00Z'), 100);
    store.sourceCalls.record('github-account', at('2026-10-14T11:00:00Z'), 1000); // more than a day ago
    store.sourceCalls.record('gh-2', at('2026-10-15T12:00:00Z'), 7);
    expect(store.sourceCalls.volume('github-account', now)).toEqual({ lastHour: 15, lastDay: 115 });
    expect(store.sourceCalls.volume('gh-2', now)).toEqual({ lastHour: 7, lastDay: 7 });
    store.close();
    const again = t.open(url);
    expect(again.sourceCalls.volume('github-account', now)).toEqual({ lastHour: 15, lastDay: 115 });
    again.close();
  });
});
