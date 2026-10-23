// A drain's expiry (issue #2499): a drain ends at its `until`; one kept before drains had an expiry ends a day after it
// began. A machine whose drain ended is listed as not drained, even before the drain watch clears it.
import { describe, expect, it } from 'vitest';
import { DRAIN_DEFAULT_HOURS, drainEnds, withDrains, type MachineDrain } from '../../src/domain/machines.ts';

const began = '2026-10-21T04:00:00.000Z';
const d = (o: Partial<MachineDrain> = {}): MachineDrain => ({ person: 'Pat', via: 'cli', at: began, ...o });

describe('a drain\'s expiry', () => {
  it('ends at its until, or a day after it began when it has none', () => {
    expect(drainEnds(d({ until: '2026-10-21T06:00:00.000Z' }))).toBe('2026-10-21T06:00:00.000Z');
    expect(DRAIN_DEFAULT_HOURS).toBe(24);
    expect(drainEnds(d())).toBe('2026-10-22T04:00:00.000Z');
  });

  it('marks a machine drained only until its drain ends', () => {
    const drains = { a: d({ reason: 'rebuild', until: '2026-10-21T06:00:00.000Z' }), b: d() };
    const ms = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(withDrains(ms, drains, '2026-10-21T05:00:00.000Z')).toEqual([{ id: 'a', drained: drains.a }, { id: 'b', drained: drains.b }, { id: 'c' }]);
    expect(withDrains(ms, drains, '2026-10-21T06:00:00.000Z')).toEqual([{ id: 'a' }, { id: 'b', drained: drains.b }, { id: 'c' }]);
    expect(withDrains(ms, drains, '2026-10-22T04:00:00.000Z')).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
});
