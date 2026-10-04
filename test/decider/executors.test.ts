// Phase 5 slice 3: an executor configured but unavailable (unknown plugin, invalid options, not
// detected, create threw) holds the jobs naming it — never fails or re-routes them. The decider
// gets the unavailable executors as an input; it does no I/O.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { advice, inputs, job, machine } from './support.ts';

const unavailableExecutors = [{ name: 'herdr-claude', reason: 'herdr not found: herdr' }];

describe('unavailable executors', () => {
  it('holds a job naming one, with the reason; other jobs start', () => {
    const d = decide(inputs({
      unavailableExecutors,
      waiting: [job('h', { executor: 'herdr-claude' }), job('t')],
    }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['t']);
    expect(d.hold).toEqual([{ jobId: 'h', reason: 'executor herdr-claude unavailable: herdr not found: herdr' }]);
  });

  it('wins over every other hold reason, so the reason says what to fix', () => {
    const d = decide(inputs({
      unavailableExecutors,
      machines: [machine({ executors: ['test'] })],
      waiting: [job('h', { executor: 'herdr-claude', machineId: 'ghost' })],
    }), 'd1');
    expect(d.hold[0]!.reason).toBe('executor herdr-claude unavailable: herdr not found: herdr');
  });

  it('holds a resuming job too (its answer waits for the executor)', () => {
    const d = decide(inputs({
      unavailableExecutors,
      waiting: [job('r', { executor: 'herdr-claude', pendingAnswer: 'blue', resumeOn: 'local' })],
    }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold[0]).toMatchObject({ jobId: 'r', reason: expect.stringMatching(/^executor herdr-claude unavailable: /) });
  });

  it('active router mode admitting the job does not start it', () => {
    const d = decide(inputs({
      routerMode: 'active', unavailableExecutors,
      machines: [machine({ executors: ['test', 'herdr-claude'] })],
      waiting: [job('h', { executor: 'herdr-claude', advice: advice('proceed_full') })],
    }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold[0]!.reason).toMatch(/^executor herdr-claude unavailable: /);
  });

  it('none unavailable: nothing changes', () => {
    const d = decide(inputs({ unavailableExecutors: [], waiting: [job('t')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['t']);
  });
});
