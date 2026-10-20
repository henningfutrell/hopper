// Issue #2234: a lane whose starts fail again and again with the same start error is unhealthy. It takes no new job for
// a while, and its machine says so; then one job is placed there again, and a start that fails the same way puts it out
// at once. A rerun of a start failure prefers a lane other than the one it failed on.
import { describe, expect, it } from 'vitest';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { LANE_START_FAILURES, avoidLanesOf, createLaneHealth } from '../../src/engine/lane-health.ts';
import { job, machine } from '../decider/support.ts';

const source = (machines: MachineSnapshot[]) => ({ list: async () => machines });
const START = 'claude did not start in 3 attempts: pane w1:p3 never set up the job\'s container runtime within 60000 ms: > ';
const OTHER_PANE = 'claude did not start in 3 attempts: pane w7:p12 never set up the job\'s container runtime within 60000 ms: > ';

function rig(outMs = 1000) {
  let now = 0;
  const health = createLaneHealth({ now: () => new Date(now) }, outMs);
  const machines = health.source(source([machine({ id: 'box' }), machine({ id: 'seat' })]));
  const out = async () => (await machines.list()).map((m) => m.unhealthyLanes?.map((l) => [l.laneId, l.failures]) ?? []);
  return { health, out, at: (ms: number) => { now = ms; } };
}

describe('lane health (issue #2234)', () => {
  it(`a lane is unhealthy after ${LANE_START_FAILURES} starts in a row fail with the same start error; its machine says so, the others not`, async () => {
    const { health, out } = rig();
    expect(health.ended('box/lane-1', START)).toBeUndefined();
    expect(health.ended('box/lane-1', OTHER_PANE)).toBeUndefined();
    expect(await out()).toEqual([[], []]);
    expect(health.ended('box/lane-1', START)).toMatchObject({ laneId: 'box/lane-1', failures: 3, error: START });
    expect(await out()).toEqual([[['box/lane-1', 3]], []]);
  });

  it('a start error of another kind starts the count again', async () => {
    const { health, out } = rig();
    health.ended('box/lane-1', START);
    health.ended('box/lane-1', START);
    health.ended('box/lane-1', 'herdr: agent failed to start: no such pane');
    health.ended('box/lane-1', START);
    expect(await out()).toEqual([[], []]);
  });

  it('a job that got under way, or failed for its own reason, makes the lane healthy again', async () => {
    const { health, out } = rig();
    for (const end of [undefined, 'tests failed: 3 of 120']) {
      health.ended('box/lane-1', START);
      health.ended('box/lane-1', START);
      health.ended('box/lane-1', end);
      health.ended('box/lane-1', START);
      expect(await out()).toEqual([[], []]);
      health.ended('box/lane-1', undefined);
    }
  });

  it('takes no new job until its time is out; then one start that fails the same way puts it out again at once', async () => {
    const { health, out, at } = rig(1000);
    for (let i = 0; i < LANE_START_FAILURES; i++) health.ended('box/lane-1', START);
    at(999);
    expect(await out()).toEqual([[['box/lane-1', 3]], []]);
    at(1000);
    expect(await out()).toEqual([[], []]);
    expect(health.ended('box/lane-1', START)).toMatchObject({ failures: 4 });
    expect(await out()).toEqual([[['box/lane-1', 4]], []]);
  });

  it('a lane of a machine with a similar name stays apart', async () => {
    const { health, out } = rig();
    for (let i = 0; i < LANE_START_FAILURES; i++) health.ended('box-2/lane-1', START);
    expect(await out()).toEqual([[], []]);
  });
});

describe('a rerun of a start failure avoids the lane it failed on (issue #2234)', () => {
  const failed = (over: Partial<Job>): Job => job('f', { status: 'failed', laneId: 'box/lane-1', error: START, ...over });

  it('names the failed job\'s lane for its rerun', () => {
    const jobs = new Map([['f', failed({})]]);
    expect(avoidLanesOf([job('r', { rerunOf: 'f' }), job('n')], (id) => jobs.get(id))).toEqual({ r: 'box/lane-1' });
  });

  it('not for a job that failed for its own reason, or has no lane', () => {
    const jobs = new Map([['f', failed({ error: 'tests failed: 3 of 120' })], ['g', failed({ id: 'g', laneId: undefined })]]);
    expect(avoidLanesOf([job('r', { rerunOf: 'f' }), job('s', { rerunOf: 'g' })], (id) => jobs.get(id))).toBeUndefined();
  });
});
