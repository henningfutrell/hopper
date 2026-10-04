// How the daemon starts again after an update: exit for a supervisor, or respawn itself.
import { describe, expect, it } from 'vitest';
import { RESTART_EXIT_CODE, restartMode } from '../../src/update/index.ts';

describe('restartMode', () => {
  it('exits under systemd or as a container PID 1, respawns otherwise, and follows JOB_HOPPER_RESTART', () => {
    expect(restartMode({ INVOCATION_ID: 'x' }, 4242)).toBe('exit');
    expect(restartMode({}, 1)).toBe('exit');
    expect(restartMode({}, 4242)).toBe('respawn');
    expect(restartMode({ INVOCATION_ID: 'x' }, 4242, 'respawn')).toBe('respawn');
    expect(restartMode({}, 4242, 'exit')).toBe('exit');
    expect(RESTART_EXIT_CODE).toBe(75);
  });
});
