import { describe, expect, it } from 'vitest';
import { retiredPins } from '../../src/decider/retired.ts';
import { job, machine } from './support.ts';

describe('retired pins (issue #919)', () => {
  const machines = [machine({ id: 'a' }), machine({ id: 'b', online: false })];

  it('names each waiting job pinned to, or resuming on, a machine no machine source lists', () => {
    const waiting = [
      job('gone', { machineId: 'ghost' }),
      job('back', { pendingAnswer: 'yes', resumeOn: 'ghost', machineId: 'a' }),
      job('offline', { machineId: 'b' }),
      job('free'),
      job('here', { machineId: 'a' }),
    ];
    expect(retiredPins(waiting, machines, ['a', 'b'])).toEqual([
      { jobId: 'gone', machineId: 'ghost', reason: 'pinned machine ghost is retired: it is no longer configured. Run the job again to place it on another machine' },
      { jobId: 'back', machineId: 'ghost', reason: 'pinned machine ghost is retired: it is no longer configured. Run the job again to place it on another machine' },
    ]);
  });

  it('a machine still in the plugins config is not retired, though no machine source lists it (its instance did not build)', () => {
    expect(retiredPins([job('broken', { machineId: 'ghost' })], machines, ['a', 'b', 'ghost'])).toEqual([]);
  });

  it('skips a job on a question: it is not waiting for a machine', () => {
    expect(retiredPins([job('q', { machineId: 'ghost', status: 'waiting_answer' })], machines, [])).toEqual([]);
  });
});
