import { describe, expect, it } from 'vitest';
import type { Decision } from '../../src/domain/types.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function decision(id: string, at: string): Decision {
  return {
    id, at, trigger: 'tick', lanes: [], start: [], hold: [], wait: [], advice: [],
    reasons: ['r'],
    inputs: {
      at, trigger: 'tick', machines: [], lanes: [], usage: [], waiting: [], running: [], unavailableExecutors: [],
      policy: { softLimit: 0.7, hardLimit: 0.95, routerCheapBoost: 10, laneIdleGraceMs: 1000, resumeBoost: 20 },
    },
  };
}

describe('decisions', () => {
  it('saves, gets, lists newest first with limit, survives reopen', () => {
    const path = t.url();
    const s = t.open(path);
    const [d1, d2, d3] = [decision('d1', '2026-10-02T10:00:00Z'), decision('d2', '2026-10-02T10:01:00Z'), decision('d3', '2026-10-02T10:02:00Z')];
    for (const d of [d1, d2, d3]) s.decisions.save(d);
    expect(s.decisions.get('d2')).toEqual(d2);
    expect(s.decisions.get('zz')).toBeUndefined();
    expect(s.decisions.list().map((d) => d.id)).toEqual(['d3', 'd2', 'd1']);
    expect(s.decisions.list(2).map((d) => d.id)).toEqual(['d3', 'd2']);
    s.close();
    const s2 = t.open(path);
    expect(s2.decisions.list()).toEqual([d3, d2, d1]);
    s2.close();
  });
});
