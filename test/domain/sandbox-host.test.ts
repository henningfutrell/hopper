// Issue #2272: which machines can be the sandbox host. `local` (the runtime beside the hopper) always; another machine
// only when the hopper knows it and it runs no coding lane, so no minted credential reaches a worker seat; at most five,
// none twice. Each machine of the sandbox host is marked with its place, and a step that waits says which host is offline.
import { describe, expect, it } from 'vitest';
import { sandboxHostOffline, sandboxHostProblem, withSandboxHost } from '../../src/domain/sandbox-host.ts';

const MACHINES = [{ id: 'local', maxLanes: 4 }, { id: 'seat', maxLanes: 2 }, { id: 'vm', maxLanes: 0 }];
const known = (id: string) => id === 'configured';

describe('the sandbox host (issue #2272)', () => {
  it('takes local, a machine with no coding lanes, and a machine of the config not polled now', () => {
    expect(sandboxHostProblem(['vm', 'local'], MACHINES, known)).toBeUndefined();
    expect(sandboxHostProblem(['configured'], MACHINES, known)).toBeUndefined();
    expect(sandboxHostProblem([], MACHINES, known)).toBeUndefined();
  });

  it('refuses a worker seat, a machine it does not know, one named twice, and more than five', () => {
    expect(sandboxHostProblem(['seat'], MACHINES, known)).toBe('machine seat runs coding lanes: a sandbox host runs none. Set its lanes to 0 first');
    expect(sandboxHostProblem(['gone'], MACHINES, known)).toBe('machine gone not found');
    expect(sandboxHostProblem(['vm', 'vm'], MACHINES, known)).toBe('the sandbox host names a machine twice');
    expect(sandboxHostProblem(['a', 'b', 'c', 'd', 'e', 'f'], MACHINES, known)).toBe('the sandbox host names at most 5 machines');
  });

  it('marks each machine of it with its place, and says which host is offline', () => {
    expect(withSandboxHost(MACHINES, ['vm', 'local']).map((m) => [m.id, m.sandboxHost])).toEqual([['local', 2], ['seat', undefined], ['vm', 1]]);
    expect(sandboxHostOffline(['vm'])).toBe('sandbox host vm is offline');
    expect(sandboxHostOffline(['vm', 'local'])).toBe('sandbox hosts vm, local are offline');
  });
});
