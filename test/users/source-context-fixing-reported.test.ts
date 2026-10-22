// A failed item's fact for the label mirror (issue #1892 part 31): its job failed, and its final report told the failure as
// one the hopper fixes itself (issue #1230, `fixingReported`). Its issue then carries no end label.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/store.ts';
import { storeSourceContext } from '../../src/users/source-context.ts';

const KEY = 'https://github.com/o/r/issues/7';

const fixingReportedOf = (sync: Record<string, unknown>, status = 'failed', jobId = 'j1'): boolean => {
  const store = {
    settings: { claimHolder: () => 'a1b2c3d4e5f6' },
    workItems: { get: (key: string) => (key === KEY ? { key, jobId } : undefined) },
    jobs: { get: (id: string) => (id === 'j1' ? { id, status, spec: {}, sourceState: { sync } } : undefined) },
  } as unknown as UserStore;
  return storeSourceContext(store, undefined, undefined).intake('github')!.fixingReported!(KEY);
};

describe('fixingReported: a failure told as one the hopper fixes (issue #1892 part 31)', () => {
  it('its job failed, and its final report went out as one the hopper fixes', () => {
    expect(fixingReportedOf({ finalReported: true, fixingReported: true })).toBe(true);
  });

  it('reported as failed, not reported yet, another end, or its job not in the store: no', () => {
    expect(fixingReportedOf({ finalReported: true, fixingReported: false })).toBe(false);
    expect(fixingReportedOf({ finalReported: false, fixingReported: true })).toBe(false);
    expect(fixingReportedOf({ finalReported: true, fixingReported: true }, 'finished')).toBe(false);
    expect(fixingReportedOf({ finalReported: true, fixingReported: true }, 'failed', 'gone')).toBe(false);
  });
});
