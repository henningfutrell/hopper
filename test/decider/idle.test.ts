// Issue #440: a machine with room it does not use says why, on its lane plan (`idle`): the queue gate, usage
// pacing, reserved lanes, a low disk, a machine that cannot take work, or no job waiting. A machine whose
// lanes are all in use, or are being filled by this Decision, has no idle reason.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { AWAITING_ACCEPTANCE } from '../../src/decider/index.ts';
import { busy, inputs, job, lane, machine, reading } from './support.ts';

const idleOf = (d: ReturnType<typeof decide>, id = 'local') => d.lanes.find((l) => l.machineId === id)?.idle;

describe('why a lane is idle (issue #440)', () => {
  it('no job waiting', () => {
    const d = decide(inputs({ lanes: [lane(1)] }), 'd1');
    expect(idleOf(d)).toBe('no job waiting');
  });

  it('every waiting job is held: at the queue gate', () => {
    const d = decide(inputs({ waiting: [job('a', { accepted: false }), job('b', { accepted: false })] }), 'd1');
    expect(idleOf(d)).toBe(`every waiting job is held: ${AWAITING_ACCEPTANCE} (2 jobs)`);
  });

  it('usage pacing: the lane cap is below the machine\'s lanes and in use', () => {
    const m = machine({ maxLanes: 4 });
    const lanes = [busy(1, 'r1'), busy(2, 'r2')];
    const d = decide(inputs({
      machines: [m], lanes, running: [job('r1', { status: 'running' }), job('r2', { status: 'running' })],
      waiting: [job('w')], usage: [reading(80)],
    }), 'd1');
    expect(d.wait.map((w) => w.jobId)).toEqual(['w']);
    expect(idleOf(d)).toMatch(/^usage pacing: lane cap 2 of 4 \(soft/);
  });

  it('reserved lanes: the free lanes are kept for jobs pinned to the machine', () => {
    const m = machine({ maxLanes: 2, reservedLanes: 1 });
    const d = decide(inputs({ machines: [m], lanes: [busy(1, 'r1')], running: [job('r1', { status: 'running' })], waiting: [job('w')] }), 'd1');
    expect(idleOf(d)).toBe('reserved: 1 lane kept for jobs pinned to this machine');
  });

  it('a low disk, an offline machine, a machine whose home is unknown, a machine with no lanes', () => {
    const low = machine({ id: 'low', disk: { freeBytes: 1024 ** 3, totalBytes: 100 * 1024 ** 3, low: true } });
    const off = machine({ id: 'off', online: false });
    const homeless = machine({ id: 'far', ssh: 'far' });
    const none = machine({ id: 'none', maxLanes: 0 });
    const d = decide(inputs({ machines: [low, off, homeless, none] }), 'd1');
    expect(idleOf(d, 'low')).toBe('disk low: no new job is claimed there');
    expect(idleOf(d, 'off')).toBe('machine offline');
    expect(idleOf(d, 'far')).toBe('its home is not known yet: no job is placed there');
    expect(idleOf(d, 'none')).toBe('no lanes: the machine\'s lane count is 0');
  });

  it('jobs wait but cannot run here: another executor or a pin elsewhere', () => {
    const other = machine({ id: 'other', maxLanes: 1 });
    const d = decide(inputs({
      machines: [machine(), other], lanes: [busy(1, 'r', { machineId: 'other' })], running: [job('r', { status: 'running' })],
      waiting: [job('p', { machineId: 'other' })],
    }), 'd1');
    expect(idleOf(d)).toBe('no waiting job can run here (its executor, its pin, or an executor\'s lane cap)');
  });

  it('a machine using all its lanes, or filling them now, has no idle reason', () => {
    const m = machine({ maxLanes: 1 });
    expect(idleOf(decide(inputs({ machines: [m], waiting: [job('a')] }), 'd1'))).toBeUndefined();
    expect(idleOf(decide(inputs({ machines: [m], lanes: [busy(1, 'r')], running: [job('r', { status: 'running' })] }), 'd2'))).toBeUndefined();
  });
});
