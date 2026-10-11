// Issue #794: a job's progress is its task count, x/y, from the lines it writes: never a clock.
import { describe, expect, it } from 'vitest';
import { lastTaskCount, taskFraction } from '../../src/domain/task-count.ts';

describe('the task count line', () => {
  it('the last HOPPER_TASKS line gives the count: done of total', () => {
    expect(lastTaskCount('Cloned the repo\nHOPPER_TASKS 1/4\nWrote the test\nHOPPER_TASKS 2/4\nRunning the checks')).toEqual({ done: 2, total: 4 });
  });

  it('the gutter and spaces around the line do not count', () => {
    expect(lastTaskCount('● HOPPER_TASKS 0/3')).toEqual({ done: 0, total: 3 });
    expect(lastTaskCount('  ⎿  HOPPER_TASKS  5 / 5  ')).toEqual({ done: 5, total: 5 });
  });

  it('no line, the line inside other text, or a count that cannot be: no count', () => {
    expect(lastTaskCount('Working')).toBeUndefined();
    expect(lastTaskCount('write a line HOPPER_TASKS 1/2 when a task completes')).toBeUndefined();
    expect(lastTaskCount('HOPPER_TASKS 3/2')).toBeUndefined();
    expect(lastTaskCount('HOPPER_TASKS 0/0')).toBeUndefined();
    expect(lastTaskCount('HOPPER_TASKS x/y')).toBeUndefined();
  });

  it('a count that cannot be does not hide the last good one', () => {
    expect(lastTaskCount('HOPPER_TASKS 1/2\nHOPPER_TASKS 3/2')).toEqual({ done: 1, total: 2 });
  });

  it('the fraction is done over total', () => {
    expect(taskFraction({ done: 2, total: 5 })).toBe(0.4);
    expect(taskFraction({ done: 0, total: 3 })).toBe(0);
  });
});
