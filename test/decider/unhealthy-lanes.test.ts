// Issue #2234: an unhealthy lane takes no new job while it is out, and its machine says why it is idle; a new lane there
// gets another number. A rerun of a start failure prefers a lane other than the one it failed on: another machine first,
// else another lane of that machine, and that lane only when there is no other.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { UnhealthyLane } from '../../src/domain/machines.ts';
import { NOW, busy, inputs, job, lane, machine } from './support.ts';

const out = (laneId: string, until = '2026-10-02T12:30:00.000Z'): UnhealthyLane =>
  ({ laneId, failures: 3, error: 'claude did not start in 3 attempts', since: NOW, until });
const box = (o: Parameters<typeof machine>[0] = {}) => machine({ id: 'box', maxLanes: 1, ...o });

describe('an unhealthy lane (issue #2234)', () => {
  it('takes no new job; the job goes to another machine', () => {
    const d = decide(inputs({
      machines: [box({ unhealthyLanes: [out('box/lane-1')] }), machine({ id: 'host', maxLanes: 1 })],
      lanes: [lane(1, { machineId: 'box' })], waiting: [job('a')],
    }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('its machine\'s only lane: the job waits, and the machine says why it is idle', () => {
    const d = decide(inputs({ machines: [box({ unhealthyLanes: [out('box/lane-1')] })], lanes: [lane(1, { machineId: 'box' })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait.map((w) => w.jobId)).toEqual(['a']);
    expect(d.lanes.find((l) => l.machineId === 'box')?.idle)
      .toBe('lane box/lane-1 is unhealthy: 3 starts in a row failed with the same start error (claude did not start in 3 attempts); no new job there until 2026-10-02T12:30:00.000Z');
  });

  it('a machine with more lanes takes the job on another lane; a new lane there gets another number', () => {
    const idle = decide(inputs({
      machines: [box({ maxLanes: 2, unhealthyLanes: [out('box/lane-1')] })], lanes: [lane(1, { machineId: 'box' }), lane(2, { machineId: 'box' })], waiting: [job('a')],
    }), 'd1');
    expect(idle.start).toEqual([expect.objectContaining({ jobId: 'a', laneId: 'box/lane-2' })]);
    const closed = decide(inputs({ machines: [box({ maxLanes: 2, unhealthyLanes: [out('box/lane-1')] })], waiting: [job('a')] }), 'd1');
    expect(closed.start).toEqual([expect.objectContaining({ jobId: 'a', laneId: null, opens: 'box/lane-2' })]);
  });

  it('a lane whose time out passed takes a job again', () => {
    const d = decide(inputs({ machines: [box({ unhealthyLanes: [out('box/lane-1', NOW)] })], lanes: [lane(1, { machineId: 'box' })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', laneId: 'box/lane-1' })]);
  });

  it('an unhealthy lane still busy keeps its job, and no other lane of the machine drains for it', () => {
    const d = decide(inputs({
      machines: [box({ maxLanes: 2, unhealthyLanes: [out('box/lane-1')] })],
      lanes: [busy(1, 'r', { machineId: 'box' }), busy(2, 's', { machineId: 'box' })], running: [job('r', { status: 'running' }), job('s', { status: 'running' })],
    }), 'd1');
    expect(d.lanes.find((l) => l.machineId === 'box')).toMatchObject({ drain: [] });
  });
});

describe('a rerun of a start failure (issue #2234)', () => {
  const avoidLanes = { a: 'box/lane-1' };

  it('goes to another machine, even one the placement would not pick first', () => {
    const d = decide(inputs({
      machines: [box({ maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], lanes: [lane(1, { machineId: 'box' })], waiting: [job('a')], avoidLanes,
    }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('on a machine of its own: another idle lane, else a new lane with another number', () => {
    const idle = decide(inputs({ machines: [box({ maxLanes: 2 })], lanes: [lane(1, { machineId: 'box' }), lane(2, { machineId: 'box' })], waiting: [job('a')], avoidLanes }), 'd1');
    expect(idle.start).toEqual([expect.objectContaining({ jobId: 'a', laneId: 'box/lane-2' })]);
    const closed = decide(inputs({ machines: [box({ maxLanes: 2 })], waiting: [job('a')], avoidLanes }), 'd1');
    expect(closed.start).toEqual([expect.objectContaining({ jobId: 'a', laneId: null, opens: 'box/lane-2' })]);
  });

  it('with no other lane it may take, it runs on that lane all the same', () => {
    const d = decide(inputs({ machines: [box()], lanes: [lane(1, { machineId: 'box' })], waiting: [job('a')], avoidLanes }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', laneId: 'box/lane-1' })]);
  });
});
