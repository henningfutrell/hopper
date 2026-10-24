// Issue #2715: a client target that ran another release than the hopper's too long while jobs were at work there holds
// jobs off (`client.updateHold`): no new job goes there, and no job back to its pane, so the jobs at work end and its
// client is updated. The job is held, not failed, with why; it starts on another machine.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine } from './support.ts';

const SINCE = '2026-10-24T09:00:00.000Z';
const seat = (o: Parameters<typeof machine>[0] = {}) => machine({ id: 'seat', client: { release: '0123456789abcdef', current: false, updateHold: { since: SINCE } }, ...o });

describe('a client target that holds jobs off to be updated', () => {
  it('a job goes to another machine, even with less room', () => {
    const d = decide(inputs({ machines: [seat({ maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only that machine: the job is held with the reason, never failed; the machine says why it is idle', () => {
    const d = decide(inputs({ machines: [seat()], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'seat holds jobs off until its client is updated: no new job is claimed there' }]);
    expect(d.lanes.find((l) => l.machineId === 'seat')?.idle).toBe('its client is updated once the jobs at work end: no new job is claimed there');
  });

  it('a job back to its pane there waits too, with the reason', () => {
    const d = decide(inputs({ machines: [seat(), machine({ id: 'host' })], waiting: [job('a', { pendingAnswer: 'go on', resumeOn: 'seat' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'pinned machine seat holds jobs off until its client is updated: no new job is claimed there' }]);
  });

  it('jobs already at work there keep their lanes', () => {
    const d = decide(inputs({ machines: [seat({ maxLanes: 2 })], lanes: [busy(1, 'r', { machineId: 'seat' })], running: [job('r', { status: 'running' })] }), 'd1');
    expect(d.lanes.find((l) => l.machineId === 'seat')).toMatchObject({ drain: [] });
  });

  it('once updated, it takes jobs again', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat', home: '/home/seat', client: { release: 'fedcba9876543210', current: true } })], waiting: [job('a')] }), 'd1');
    expect(d.hold).toEqual([]);
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'seat' })]);
  });
});
