// Issue #708: a template's limits, the defaults and maximums its sandboxes get. Pure: src/domain/sandboxes.ts.
//
// Feature: a template's limits
//   Scenario: a template's limits must have each default within its max
import { describe, expect, it } from 'vitest';
import { limitsProblem } from '../../src/domain/sandboxes.ts';

describe('a template\'s limits', () => {
  it('a template\'s limits must have each default within its max', () => {
    expect(limitsProblem({ cpus: { default: 1, max: 2 }, memoryMb: { default: 1024, max: 4096 } })).toBeUndefined();
    expect(limitsProblem({ cpus: { default: 4, max: 2 } })).toBe('cpus: the default 4 is more than the max 2');
    expect(limitsProblem({ memoryMb: { default: 0, max: 2 } })).toBe('memoryMb: the default must be more than 0');
  });
});
