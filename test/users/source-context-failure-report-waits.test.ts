// A failed item's fact for the label mirror (issue #1892 part 32): its job failed, and its final report is not out yet
// (`failureReportWaits`). Its issue then carries `hopper:failed`, or no end label.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/store.ts';
import { storeSourceContext } from '../../src/users/source-context.ts';

const KEY = 'https://github.com/o/r/issues/7';

const waitsOf = (sync: Record<string, unknown>, status = 'failed', jobId = 'j1'): boolean => {
  const store = {
    settings: { claimHolder: () => 'a1b2c3d4e5f6' },
    workItems: { get: (key: string) => (key === KEY ? { key, jobId } : undefined) },
    jobs: { get: (id: string) => (id === 'j1' ? { id, status, spec: {}, sourceState: { sync } } : undefined) },
  } as unknown as UserStore;
  return storeSourceContext(store, undefined, undefined).intake('github')!.failureReportWaits!(KEY);
};

describe('failureReportWaits: a failure not reported yet (issue #1892 part 32)', () => {
  it('its job failed, and its final report is not out', () => {
    expect(waitsOf({})).toBe(true);
    expect(waitsOf({ finalReported: false, fixingReported: true })).toBe(true);
  });

  it('reported, another end, or its job not in the store: no', () => {
    expect(waitsOf({ finalReported: true })).toBe(false);
    expect(waitsOf({ finalReported: true, fixingReported: true })).toBe(false);
    expect(waitsOf({}, 'finished')).toBe(false);
    expect(waitsOf({}, 'failed', 'gone')).toBe(false);
  });
});
