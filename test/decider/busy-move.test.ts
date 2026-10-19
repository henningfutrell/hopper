// Issue #1977: a job queued to resume on its own machine waits there only while that machine has room, or for a short
// time. When every lane of its machine is in use and another machine that runs its executor has room, the busy-machine
// move may take it there (src/engine/busy-move.ts). This is the pure part: which jobs, and which machines.
//
// Feature: the busy-machine move, which jobs and where
//   Scenario: a resuming job whose machine is full may go to each other machine with room
//   Scenario: no move while its machine has room, or when no other machine has room
//   Scenario: no move for a job that is not resuming, is pinned by its spec, resumes elsewhere already, or was continued
//   Scenario: a machine that is offline, runs another executor, is leaving or drained, or keeps its lanes is no target
import { describe, expect, it } from 'vitest';
import { busyMove } from '../../src/decider/busy-move.ts';
import type { Lane } from '../../src/domain/types.ts';
import { job, lane, machine } from './support.ts';

const FLEET = [machine({ id: 'l1' }), machine({ id: 'l2' }), machine({ id: 'l3' })];
const full = (id: string, n = 4): Lane[] => Array.from({ length: n }, (_, i) => lane(i + 1, { machineId: id, state: 'busy', jobId: `${id}-${i}` }));
const resuming = (over = {}) => job('a', { pendingAnswer: 'go on', resumeOn: 'l2', parked: { at: '2026-10-02T11:00:00.000Z', from: 'running' }, ...over });

describe('the busy-machine move: which jobs and where (issue #1977)', () => {
  it('a resuming job whose machine is full may go to each other machine with room', () => {
    expect(busyMove(resuming(), FLEET, [...full('l2'), ...full('l1', 2)])).toEqual(['l1', 'l3']);
  });

  it('no move while its machine has room, or when no other machine has room', () => {
    expect(busyMove(resuming(), FLEET, full('l2', 3))).toBeUndefined();
    expect(busyMove(resuming(), FLEET, [...full('l2', 3), lane(4, { machineId: 'l2' })])).toBeUndefined();
    expect(busyMove(resuming(), FLEET, [...full('l1'), ...full('l2'), ...full('l3')])).toBeUndefined();
  });

  it('no move for a job that is not resuming, is pinned by its spec, resumes elsewhere already, or was continued', () => {
    const lanes = full('l2');
    expect(busyMove(resuming({ pendingAnswer: undefined }), FLEET, lanes)).toBeUndefined();
    expect(busyMove(resuming({ resumeOn: undefined }), FLEET, lanes)).toBeUndefined();
    expect(busyMove(resuming({ status: 'waiting_answer' }), FLEET, lanes)).toBeUndefined();
    expect(busyMove(job('a', { pendingAnswer: 'go on', resumeOn: 'l2', machineId: 'l2' }), FLEET, lanes)).toBeUndefined();
    expect(busyMove(resuming({ parked: { at: '2026-10-02T11:00:00.000Z', from: 'running', elsewhere: { at: '2026-10-02T11:00:00.000Z', checkpointAt: '2026-10-02T11:00:00.000Z' } } }), FLEET, lanes)).toBeUndefined();
    expect(busyMove(resuming({ continued: { at: '2026-10-02T11:00:00.000Z', handoffId: 'h1' } }), FLEET, lanes)).toBeUndefined();
  });

  it('a machine that is offline, runs another executor, is leaving or drained, or keeps its lanes is no target', () => {
    const lanes = full('l2');
    const others = [
      machine({ id: 'off', online: false }), machine({ id: 'other', executors: ['command'] }), machine({ id: 'leaving', leaving: true }),
      machine({ id: 'drained', drained: { at: '2026-10-02T11:00:00.000Z', person: 'a person', via: 'ui' } }), machine({ id: 'kept', maxLanes: 2, reservedLanes: 2 }),
    ];
    expect(busyMove(resuming(), [machine({ id: 'l2' }), ...others], lanes)).toBeUndefined();
    expect(busyMove(resuming(), [machine({ id: 'l2' }), ...others, machine({ id: 'l1' })], lanes)).toEqual(['l1']);
  });
});
