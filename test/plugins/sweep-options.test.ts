// The sweep's machine options (issue #2494, design.md "Hopper's own disk use" → "Part 14"): a machine's own disk budget
// (`diskBudgetGiB`) and its dry run (`sweepDryRun`, false kept so it wins over a default dry run).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sweepOf, sweepShape } from '../../src/plugins/machine-source/attached.ts';

describe('the sweep\'s machine options (issue #2494)', () => {
  it('diskBudgetGiB and sweepDryRun set the machine\'s budget and dry run', () => {
    expect(sweepOf({ diskBudgetGiB: 40, sweepDryRun: true })).toEqual({ budgetGiB: 40, dryRun: true });
    expect(sweepOf({ sweepDryRun: false })).toEqual({ dryRun: false });
    expect(sweepOf({})).toBeUndefined();
  });

  it('a budget must be above 0', () => {
    const shape = z.object(sweepShape(z));
    expect(shape.safeParse({ diskBudgetGiB: 0 }).success).toBe(false);
    expect(shape.safeParse({ diskBudgetGiB: 0.5, sweepDryRun: true }).success).toBe(true);
  });
});
