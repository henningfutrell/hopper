import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { AdviceAction } from '../../src/domain/types.ts';
import { advice, inputs, job } from './support.ts';

const adv = (id: string, action: AdviceAction, over = {}) => job(id, { advice: advice(action), ...over });

describe.each(['ask_human', 'reuse_cache', 'stop_retry'] as const)('router %s', (action) => {
  it('holds with a router reason and records the divergence', () => {
    const d = decide(inputs({ waiting: [adv('a', action)] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: expect.stringContaining(`router ${action}`) }]);
    expect(d.advice).toEqual([expect.objectContaining({ jobId: 'a', advice: action, native: 'start', withAdvice: 'hold' })]);
  });

  it('approved overrides the hold', () => {
    const d = decide(inputs({ waiting: [adv('a', action, { approved: true })] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.advice).toEqual([]);
  });
});

it('ask_human reason says awaiting approval', () => {
  const d = decide(inputs({ waiting: [adv('a', 'ask_human')] }), 'd1');
  expect(d.hold[0]!.reason).toBe('router ask_human: awaiting approval');
});

describe.each(['chat_only', 'run_deterministic'] as const)('router %s boost', (action) => {
  it('boosted by routerCheapBoost, runs first, and records the order divergence', () => {
    const waiting = [adv('plain', 'proceed_full', { priority: 55 }), adv('cheap', action, { priority: 50 })];
    const d = decide(inputs({ waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['cheap', 'plain']);
    expect(d.start[0]!.effectivePriority).toBe(60);
    expect(d.advice).toEqual([expect.objectContaining({ jobId: 'cheap', advice: action, native: 'start', withAdvice: 'start' })]);
  });
});

describe('unclassified jobs', () => {
  it('held awaiting router advice', () => {
    const d = decide(inputs({ waiting: [job('a', { advice: undefined })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'awaiting router advice' }]);
  });

  it('an approved unclassified job still starts', () => {
    const d = decide(inputs({ waiting: [job('a', { approved: true, advice: undefined })] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
  });
});

it('proceed_full / allow_subagent / research_capped: no divergence, no boost', () => {
  const waiting = (['proceed_full', 'allow_subagent', 'research_capped'] as const).map((a) => adv(a, a));
  const d = decide(inputs({ waiting }), 'd1');
  expect(d.start).toHaveLength(3);
  expect(d.start.every((s) => s.effectivePriority === 50)).toBe(true);
  expect(d.advice).toEqual([]);
});

it('the reasons name no mode', () => {
  const d = decide(inputs({ waiting: [adv('a', 'proceed_full')] }), 'd1');
  expect(d.reasons).toContain('1 waiting, 1 start, 0 held');
  expect(d).not.toHaveProperty('routerMode');
  expect(d.inputs).not.toHaveProperty('routerMode');
});

it('a router-held job does not consume lane room', () => {
  const waiting = [adv('held', 'ask_human', { priority: 99 }), job('ok', { priority: 10, advice: advice('proceed_full') })];
  const d = decide(inputs({ waiting, machines: [{ id: 'local', label: 'l', maxLanes: 1, online: true, executors: ['test'] }] }), 'd1');
  expect(d.start.map((s) => s.jobId)).toEqual(['ok']);
});
