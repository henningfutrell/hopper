// A problem whose cause a check can see (issue #509) resolves by itself once the check passes. Issue #741: a herdr
// problem's check is the machine's herdr problem, as its probe finds it.
import { describe, expect, it } from 'vitest';
import { causePresent } from '../../src/failures/causes.ts';
import type { MachineSnapshot } from '../../src/domain/types.ts';

const seat = (over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({ id: 'seat', label: 'seat', maxLanes: 1, online: true, executors: ['herdr-claude'], ...over });

describe('causePresent', () => {
  it('online: the machine offline', () => {
    expect(causePresent('online', seat({ online: false }))).toBe(true);
    expect(causePresent('online', seat())).toBe(false);
  });

  it('disk: its disk low', () => {
    expect(causePresent('disk', seat({ disk: { freeBytes: 1, totalBytes: 10, low: true } }))).toBe(true);
    expect(causePresent('disk', seat())).toBe(false);
  });

  it('herdr: its herdr problem', () => {
    expect(causePresent('herdr', seat({ herdrProblem: 'its herdr client (protocol 17) is not compatible with its herdr server (protocol 22)' }))).toBe(true);
    expect(causePresent('herdr', seat())).toBe(false);
  });
});
