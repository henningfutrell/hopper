// The patched Node floor (issue #2479): Node's October 21, 2026 security release, the lowest version of each line that has it.
import { describe, expect, it } from 'vitest';
import { nodeFloorOf, nodeWarning } from '../../src/client/node-floor.ts';

describe('the patched Node floor', () => {
  it('names no floor for a patched version', () => {
    for (const v of ['v24.22.1', 'v24.23.0', 'v26.12.1', 'v26.13.0', 'v27.0.0', '28.1.2']) expect(nodeFloorOf(v)).toBeUndefined();
  });

  it('names the floor of its line for an unpatched version', () => {
    expect(nodeFloorOf('v24.22.0')).toBe('24.22.1');
    expect(nodeFloorOf('v24.9.9')).toBe('24.22.1');
    expect(nodeFloorOf('v26.8.2')).toBe('26.12.1');
    expect(nodeFloorOf('v26.12.0')).toBe('26.12.1');
  });

  it('names the next patched line for a line with no patched release', () => {
    expect(nodeFloorOf('v22.20.0')).toBe('24.22.1');
    expect(nodeFloorOf('v25.9.0')).toBe('26.12.1');
  });

  it('names no floor for a version it cannot read', () => {
    expect(nodeFloorOf('')).toBeUndefined();
    expect(nodeFloorOf('node')).toBeUndefined();
  });

  it('warns only below the floor', () => {
    expect(nodeWarning('v26.12.1')).toBeUndefined();
    expect(nodeWarning('v26.8.2')).toMatch(/^Node v26\.8\.2 lacks the October 21, 2026 security release: update it to 26\.12\.1 or later/);
  });
});
