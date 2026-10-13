// The stack's resources over time, as the Resources page draws them (issue #947): a line per service and metric, named
// `<service> · <metric>`, a colour per service and a dash per metric; a sandbox box's lines hidden until shown. Pure.
import { describe, expect, it } from 'vitest';
import type { StackSeries } from '../../src/domain/types.ts';
import { stackLines } from '../../ui/src/model/stack-history.ts';

const at = (h: number) => new Date(Date.parse('2026-10-12T00:00:00.000Z') + h * 3_600_000).toISOString();
const series = (service: string, metric: StackSeries['metric'], group: StackSeries['group'] = 'stack'): StackSeries =>
  ({ service, group, metric, points: [{ at: at(0), usedFrac: 0.3 }], gaps: [{ from: at(1), to: at(2) }] });

describe('the stack\'s resource graph', () => {
  it('a line per service and metric, named by both; a colour per service, a dash per metric', () => {
    const lines = stackLines([series('postgres', 'cpu'), series('postgres', 'memory'), series('postgres', 'connections'), series('openfga', 'check-errors'), series('openfga', 'cpu')]);
    expect(lines.map((l) => l.label)).toEqual(['postgres · CPU', 'postgres · memory', 'postgres · connections', 'openfga · failed checks', 'openfga · CPU']);
    expect(new Set(lines.map((l) => l.key)).size).toBe(5);
    expect(lines[0]!.color).toBe(lines[1]!.color);
    expect(lines[3]!.color).not.toBe(lines[0]!.color);
    expect(lines.map((l) => l.dash)).toEqual(['solid', 'dashed', 'dotted', 'dotted', 'solid']);
    expect(lines[0]!.series.points).toEqual([{ at: at(0), usedFrac: 0.3 }]);
    expect(lines[0]!.series.gaps).toEqual([{ from: at(1), to: at(2) }]);
  });

  it('a sandbox box\'s lines are hidden until shown; the stack\'s are shown', () => {
    const lines = stackLines([series('postgres', 'cpu'), series('hopper-sandbox-claude', 'cpu', 'sandbox')]);
    expect(lines.map((l) => l.shownByDefault)).toEqual([true, false]);
  });
});
