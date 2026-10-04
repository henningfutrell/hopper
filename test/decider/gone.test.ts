// A machine removed from the configuration (issue #18: attached machines follow plugins.yaml live)
// leaves its stored lanes behind. The decider closes the idle ones and drains any busy one; it
// never starts anything there.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { busy, inputs, job, lane, machine } from './support.ts';

describe('lanes of a machine that is gone', () => {
  it('idle lanes close, busy lanes drain, nothing starts there', () => {
    const idle = lane(1, { machineId: 'laptop' });
    const working = busy(2, 'j1', { machineId: 'laptop' });
    const d = decide(inputs({ machines: [machine()], lanes: [idle, working], waiting: [job('a')] }), 'd1');
    const plan = d.lanes.find((p) => p.machineId === 'laptop')!;
    expect(plan).toMatchObject({ current: 2, target: 0, open: 0, close: [idle.id], drain: [working.id] });
    expect(plan.reason).toMatch(/laptop: no longer configured/);
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'local' })]);
  });

  it('a draining lane of a gone machine is left to close when its job ends', () => {
    const draining = busy(1, 'j1', { machineId: 'laptop', state: 'draining' });
    const d = decide(inputs({ lanes: [draining] }), 'd1');
    expect(d.lanes.find((p) => p.machineId === 'laptop')).toMatchObject({ close: [], drain: [] });
  });
});
