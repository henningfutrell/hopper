import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { advice, inputs, job, lane, machine, policy } from './support.ts';

const resuming = (id: string, over = {}) => job(id, { pendingAnswer: 'yes', ...over });
const twoMachines = [machine({ id: 'a', maxLanes: 1 }), machine({ id: 'b', maxLanes: 1 })];

describe('resume boost', () => {
  it('adds resumeBoost and runs ahead of a higher plain priority', () => {
    const plain = job('plain', { priority: 60, advice: advice('proceed_full') });
    const back = resuming('back', { priority: 50, advice: advice('proceed_full') });
    const d = decide(inputs({ machines: [machine({ maxLanes: 1 })], waiting: [plain, back] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['back']);
    expect(d.start[0]!.effectivePriority).toBe(50 + policy.resumeBoost);
    expect(d.start[0]!.reason).toContain(`resume boost +${policy.resumeBoost}`);
  });
});

describe('resume pin', () => {
  it('goes to resumeOn, over spec.machineId', () => {
    const d = decide(inputs({
      machines: twoMachines,
      waiting: [resuming('r', { resumeOn: 'b', machineId: 'a' })],
    }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('falls back to spec.machineId without resumeOn', () => {
    const d = decide(inputs({ machines: twoMachines, waiting: [resuming('r', { machineId: 'a' })] }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['a']);
  });

  it('holds natively when the resumeOn machine is offline', () => {
    const machines = [machine({ id: 'a' }), machine({ id: 'b', online: false })];
    const d = decide(inputs({ machines, waiting: [resuming('r', { resumeOn: 'b' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'r', reason: 'pinned machine b offline' }]);
  });

  it('a re-queued parked job (issue #501) waits for its machine while it is offline, with the reason, and never starts elsewhere', () => {
    const machines = [machine({ id: 'a' }), machine({ id: 'b', online: false })];
    const back = resuming('p', { resumeOn: 'b', parked: { at: '2026-10-01T00:00:00Z', from: 'running' } });
    const d = decide(inputs({ machines, waiting: [back] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'p', reason: 'pinned machine b offline' }]);
  });

  it('holds natively when the resumeOn machine is unknown', () => {
    const d = decide(inputs({ waiting: [resuming('r', { resumeOn: 'ghost' })] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'r', reason: 'pinned machine ghost unknown' }]);
  });

  it('waits for room on the resumeOn machine instead of spilling over', () => {
    const d = decide(inputs({
      machines: twoMachines,
      lanes: [lane(1, { machineId: 'b', state: 'busy', jobId: 'x' })],
      waiting: [resuming('r', { resumeOn: 'b' })],
    }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.jobId).toBe('r');
  });
});

describe('the router never holds a resuming job', () => {
  it.each(['ask_human', 'reuse_cache', 'stop_retry'] as const)('%s: starts, no divergence', (action) => {
    const d = decide(inputs({ waiting: [resuming('r', { advice: advice(action) })] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['r']);
    expect(d.hold).toEqual([]);
    expect(d.advice).toEqual([]);
  });

  it('starts without any advice', () => {
    const d = decide(inputs({ waiting: [resuming('r', { advice: undefined })] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['r']);
  });

  it('does not boost the priority of a cheap advice class', () => {
    const d = decide(inputs({ waiting: [resuming('r', { advice: advice('chat_only') })] }), 'd1');
    expect(d.start[0]!.effectivePriority).toBe(50 + policy.resumeBoost);
    expect(d.advice).toEqual([]);
  });
});

describe('waiting_answer in inputs is ignored', () => {
  it('in waiting: not started, not held, not counted; reason notes it', () => {
    const parked = job('p', { status: 'waiting_answer' });
    const d = decide(inputs({ waiting: [parked, job('a')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.hold).toEqual([]);
    expect(d.reasons).toContain('ignored p: status waiting_answer is not an input');
    expect(d.reasons.join('\n')).toContain('1 waiting');
  });

  it('in running: does not count against anything; reason notes it', () => {
    const parked = job('p', { status: 'waiting_answer' });
    const d = decide(inputs({ running: [parked] }), 'd1');
    expect(d.reasons).toContain('ignored p: status waiting_answer is not an input');
  });
});

it('is deterministic with resuming jobs', () => {
  const i = inputs({ machines: twoMachines, waiting: [resuming('r', { resumeOn: 'a' }), job('q')] });
  expect(decide(i, 'd1')).toEqual(decide(i, 'd1'));
});
