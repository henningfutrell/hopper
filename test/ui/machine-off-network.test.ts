// Issue #711: a machine whose jobs cannot reach the hopper shows as off-network on Machines, with why and, when one
// fits, the command that joins it to the hopper's network, to copy and paste.
import { describe, expect, it } from 'vitest';
import { offNetwork } from '../../ui/src/model/machines.ts';

describe('an off-network machine on Machines', () => {
  const base = { id: 'seat', label: 'seat', maxLanes: 1, online: true, executors: [], ssh: 'agent@hopper-box-claude' };
  const problem = 'the hopper cannot be reached from it: http://hopper:4790 (no connection)';

  it('with a fix: why, and the command', () => {
    expect(offNetwork({ ...base, addressProblem: problem, addressFix: 'podman network connect hopper_default hopper-box-claude' }))
      .toEqual({ problem, fix: 'podman network connect hopper_default hopper-box-claude' });
  });

  it('with no fix that fits: why alone', () => {
    expect(offNetwork({ ...base, addressProblem: problem })).toEqual({ problem });
  });

  it('a machine that reaches the hopper: nothing', () => {
    expect(offNetwork({ ...base, hopperUrl: 'http://hopper:4790' })).toBeNull();
  });
});
