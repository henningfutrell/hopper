// Issue #602: a sandbox box whose template is not approved takes no new job. The job is held, not failed, with why;
// it starts on a machine that can take it. A job resuming there returns to the pane it holds.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, machine } from './support.ts';

const WAITING = 'waiting for template approval: kube is not approved';
const box = (o: Parameters<typeof machine>[0] = {}) => machine({ id: 'box', template: { name: 'kube', waiting: WAITING }, ...o });

describe('boxes whose template is not approved', () => {
  it('a job goes to the machine that can take it, even with less room', () => {
    const d = decide(inputs({ machines: [box({ maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only such boxes: the job is held with the reason, never failed; the box says why it is idle', () => {
    const d = decide(inputs({ machines: [box()], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `box: ${WAITING}: no new job is claimed there` }]);
    expect(d.lanes.find((l) => l.machineId === 'box')?.idle).toBe(`${WAITING}: no new job is claimed there`);
  });

  it('a job pinned to such a box is held with the reason', () => {
    const d = decide(inputs({ machines: [box(), machine({ id: 'host' })], waiting: [job('a', { machineId: 'box' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine box: ${WAITING}` }]);
  });

  it('a box of an approved template takes jobs', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', template: { name: 'kube' } })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'box' })]);
  });

  it('jobs already running there keep their lanes', () => {
    const d = decide(inputs({ machines: [box({ maxLanes: 2 })], lanes: [busy(1, 'r', { machineId: 'box' })], running: [job('r', { status: 'running' })] }), 'd1');
    expect(d.lanes.find((l) => l.machineId === 'box')).toMatchObject({ drain: [] });
  });
});
