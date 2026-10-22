// A done item's fact for the label mirror (issue #1892 part 24): its job finished, and its final report found the issue
// closed as complete and put `hopper:done` on. Only then is `hopper:done` its label when no whole merge and no Done by hand
// made it done.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/store.ts';
import { storeSourceContext } from '../../src/users/source-context.ts';

const KEY = 'https://github.com/o/r/issues/7';

const doneReportedOf = (source: Record<string, unknown> | undefined, jobId = 'j1', finalReported = true): boolean => {
  const store = {
    settings: { claimHolder: () => 'a1b2c3d4e5f6' },
    workItems: { get: (key: string) => (key === KEY ? { key, jobId } : undefined) },
    jobs: { get: (id: string) => (id === 'j1' ? { id, status: 'finished', spec: {}, sourceState: { sync: { finalReported }, ...(source ? { source } : {}) } } : undefined) },
  } as unknown as UserStore;
  return storeSourceContext(store, undefined, undefined).intake('github')!.doneReported!(KEY);
};

describe('doneReported: the report put hopper:done on (issue #1892 part 24)', () => {
  it('its job\'s final report found the issue closed as complete', () => {
    expect(doneReportedOf({ doneReported: true })).toBe(true);
  });

  it('not reported yet, another end, or its job not in the store: none', () => {
    expect(doneReportedOf({ doneReported: true }, 'j1', false)).toBe(false);
    expect(doneReportedOf({ follow: 'open' })).toBe(false);
    expect(doneReportedOf(undefined)).toBe(false);
    expect(doneReportedOf({ doneReported: true }, 'gone')).toBe(false);
  });
});
