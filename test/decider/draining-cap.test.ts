// A draining lane still holds its running job (issue #1181): it counts against the machine's lane cap until its job
// ends and it closes. A waiting job at the cap waits, whatever lane drains; only an elbow-in goes past the cap.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Decision, Job, Lane } from '../../src/domain/types.ts';
import { busy, inputs, job, lane, machine } from './support.ts';

const SIX = machine({ maxLanes: 6 });
const running = (id: string, priority = 50): Job => job(id, { status: 'running', priority });
const draining = (n: number, jobId: string): Lane => busy(n, jobId, { state: 'draining' });
/** Lanes that hold a job: busy and draining. */
const held = (lanes: readonly Lane[]): number => lanes.filter((l) => l.state !== 'idle').length;

/** The engine's apply, as far as lanes go: drains, closes, and each start on its lane or a new one. */
function apply(lanes: Lane[], d: Decision): Lane[] {
  const plan = d.lanes.find((p) => p.machineId === 'local')!;
  let next = lanes.filter((l) => !plan.close.includes(l.id)).map((l) => (plan.drain.includes(l.id) ? { ...l, state: 'draining' as const } : l));
  for (const s of d.start) {
    if (s.laneId) next = next.map((l) => (l.id === s.laneId ? { ...l, state: 'busy' as const, jobId: s.jobId, idleSince: undefined } : l));
    else {
      let n = 1;
      while (next.some((l) => l.id === `local/lane-${n}`)) n += 1;
      next.push(busy(n, s.jobId));
    }
  }
  return next;
}

/** The job ends: a draining lane closes, a busy one goes idle. */
const end = (lanes: Lane[], jobId: string): Lane[] =>
  lanes.flatMap((l) => (l.jobId !== jobId ? [l] : l.state === 'draining' ? [] : [lane(Number(l.id.split('-').pop()), { idleSince: '2026-10-02T11:59:59.000Z' })]));

describe('a draining lane counts against the lane cap (issue #1181)', () => {
  it('at the cap with one lane draining, an ordinary priority-75 job waits: no lane opens', () => {
    const lanes = [draining(1, 'r1'), busy(3, 'r3'), busy(4, 'r4'), busy(5, 'r5'), busy(6, 'r6'), busy(7, 'r7')];
    const d = decide(inputs({
      machines: [SIX], lanes, running: ['r1', 'r3', 'r4', 'r5', 'r6', 'r7'].map((id) => running(id)), waiting: [job('w', { priority: 75 })],
    }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'w', reason: expect.stringContaining('lane cap is 6, all 6 in use') }]);
    expect(d.lanes[0]).toMatchObject({ open: 0, drain: [] });
  });

  it('one under the cap with one lane draining, one job starts and the next waits', () => {
    const lanes = [draining(1, 'r1'), busy(3, 'r3'), busy(4, 'r4'), busy(5, 'r5'), busy(6, 'r6')];
    const d = decide(inputs({
      machines: [SIX], lanes, running: ['r1', 'r3', 'r4', 'r5', 'r6'].map((id) => running(id)), waiting: [job('a', { priority: 75 }), job('b', { priority: 75 })],
    }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.wait.map((w) => w.jobId)).toEqual(['b']);
  });

  it('lanes holding a job never pass the cap across start, drain and end', () => {
    const m = machine({ maxLanes: 3 });
    let lanes: Lane[] = [];
    const jobs = new Map<string, Job>();
    let waiting = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => job(id, { priority: 40 + i * 10 }));
    let at = 0;
    const step = (over: Partial<Parameters<typeof inputs>[0]> = {}): Decision => {
      at += 1;
      const d = decide(inputs({ machines: [m], lanes, running: [...jobs.values()], waiting, ...over }), `d${at}`);
      lanes = apply(lanes, d);
      for (const s of d.start) jobs.set(s.jobId, running(s.jobId, waiting.find((w) => w.id === s.jobId)!.priority));
      waiting = waiting.filter((w) => !d.start.some((s) => s.jobId === w.id));
      expect(held(lanes)).toBeLessThanOrEqual(m.maxLanes);
      return d;
    };
    step();
    expect(held(lanes)).toBe(3);
    // Usage pacing takes the cap to 2: the lowest-priority lane drains, and nothing starts while it does.
    step({ machines: [machine({ maxLanes: 2 })] });
    expect(lanes.filter((l) => l.state === 'draining')).toHaveLength(1);
    step();
    const drained = lanes.find((l) => l.state === 'draining')!.jobId!;
    // A job on a busy lane ends: its lane goes idle and one job takes it; the draining lane still counts.
    const other = lanes.find((l) => l.state === 'busy')!.jobId!;
    lanes = end(lanes, other);
    jobs.delete(other);
    step();
    expect(held(lanes)).toBe(3);
    // The draining lane's job ends: the lane closes, and one more job starts in its place.
    lanes = end(lanes, drained);
    jobs.delete(drained);
    expect(held(lanes)).toBe(2);
    step();
    expect(held(lanes)).toBe(3);
  });

  it('a lane a reattach opened past the cap drains first, before an older lane of a lower-priority job', () => {
    const lanes = [busy(1, 'low'), busy(2, 'mid'), busy(3, 'back', { pastCap: true })];
    const d = decide(inputs({
      machines: [machine({ maxLanes: 2 })], lanes, running: [running('low', 10), running('mid', 50), running('back', 75)],
    }), 'd1');
    expect(d.lanes[0]!.drain).toEqual(['local/lane-3']);
  });
});
