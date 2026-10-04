// Issue #18: the queue sorter. The engine asks the queue-sorter role for an order while gathering
// inputs and passes it in as `inputs.queueOrder`; decide() stays pure and orders admissible jobs
// by it (step 6). Jobs the order leaves out follow, by today's rule. No order: today's rule.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { effectivePriority } from '../../src/decider/assign.ts';
import { advice, inputs, job, machine, policy } from './support.ts';

const at = (min: number) => `2026-10-02T11:0${min}:00.000Z`;
const three = () => [
  job('low-old', { priority: 10, createdAt: at(1) }),
  job('high-new', { priority: 90, createdAt: at(3) }),
  job('mid', { priority: 50, createdAt: at(2) }),
];
const started = (d: ReturnType<typeof decide>) => d.start.map((s) => s.jobId);

describe('step 6 with a queue order', () => {
  it('no order: effective priority desc, createdAt asc, id (unchanged)', () => {
    expect(started(decide(inputs({ waiting: three() }), 'd1'))).toEqual(['high-new', 'mid', 'low-old']);
  });

  it('an order: admissible jobs start in that order', () => {
    const d = decide(inputs({ waiting: three(), queueOrder: { sorter: 'oldest', jobIds: ['low-old', 'mid', 'high-new'] } }), 'd1');
    expect(started(d)).toEqual(['low-old', 'mid', 'high-new']);
  });

  it('with one lane, the first in the order is the one that starts', () => {
    const d = decide(inputs({
      machines: [machine({ maxLanes: 1 })], waiting: three(),
      queueOrder: { sorter: 'oldest', jobIds: ['low-old', 'mid', 'high-new'] },
    }), 'd1');
    expect(started(d)).toEqual(['low-old']);
    expect(d.hold.map((h) => h.jobId).sort()).toEqual(['high-new', 'mid']);
  });

  it('jobs the order leaves out come after the ordered ones, by today\'s rule; unknown ids are ignored', () => {
    const d = decide(inputs({
      waiting: [...three(), job('other-high', { priority: 95, createdAt: at(4) })],
      queueOrder: { sorter: 'partial', jobIds: ['ghost', 'low-old'] },
    }), 'd1');
    expect(started(d)).toEqual(['low-old', 'other-high', 'high-new', 'mid']);
  });

  it('the order never admits a job: a held job stays held', () => {
    const d = decide(inputs({
      routerMode: 'active',
      waiting: [job('asks', { advice: advice('ask_human') }), job('ok', { advice: advice('proceed_full') })],
      queueOrder: { sorter: 's', jobIds: ['asks', 'ok'] },
    }), 'd1');
    expect(started(d)).toEqual(['ok']);
    expect(d.hold).toEqual([{ jobId: 'asks', reason: 'router ask_human: awaiting approval' }]);
  });

  it('names the sorter in the reasons', () => {
    const d = decide(inputs({ waiting: three(), queueOrder: { sorter: 'oldest', jobIds: [] } }), 'd1');
    expect(d.reasons).toContain('queue order by oldest');
  });

  it('is pure: same inputs, same Decision; the inputs are not mutated', () => {
    const i = inputs({ waiting: three(), queueOrder: { sorter: 'newest', jobIds: ['high-new', 'mid', 'low-old'] } });
    const copy = structuredClone(i);
    expect(decide(i, 'd1')).toEqual(decide(i, 'd1'));
    expect(i).toEqual(copy);
  });
});

describe('effectivePriority (the decider\'s notion, exported for the engine)', () => {
  it('shadow: the job\'s priority', () => {
    expect(effectivePriority(job('a', { priority: 40, advice: advice('chat_only') }), 'shadow', policy)).toBe(40);
  });
  it('active: plus the cheap boost for cheap advice', () => {
    expect(effectivePriority(job('a', { priority: 40, advice: advice('chat_only') }), 'active', policy)).toBe(40 + policy.routerCheapBoost);
    expect(effectivePriority(job('a', { priority: 40, advice: advice('proceed_full') }), 'active', policy)).toBe(40);
  });
  it('a resuming job: plus the resume boost, either mode', () => {
    expect(effectivePriority(job('a', { priority: 40, pendingAnswer: 'yes' }), 'shadow', policy)).toBe(40 + policy.resumeBoost);
    expect(effectivePriority(job('a', { priority: 40, pendingAnswer: 'yes', advice: advice('chat_only') }), 'active', policy)).toBe(40 + policy.resumeBoost);
  });
  it('the decider starts jobs with that effective priority', () => {
    const d = decide(inputs({ routerMode: 'active', waiting: [job('a', { priority: 40, advice: advice('chat_only') })] }), 'd1');
    expect(d.start[0]!.effectivePriority).toBe(50);
  });
});
