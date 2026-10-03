import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { JevAction } from '../../src/domain/types.ts';
import { advice, inputs, job } from './support.ts';

const adv = (id: string, action: JevAction, over = {}) => job(id, { jevAdvice: advice(action), ...over });

describe.each(['ask_human', 'reuse_cache', 'stop_retry'] as const)('jev %s', (action) => {
  it('shadow: starts natively and records the divergence', () => {
    const d = decide(inputs({ jevMode: 'shadow', waiting: [adv('a', action)] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.hold).toEqual([]);
    expect(d.jev).toEqual([expect.objectContaining({ jobId: 'a', advice: action, native: 'start', withJev: 'hold' })]);
  });

  it('active: holds with a jev reason and records the same divergence', () => {
    const d = decide(inputs({ jevMode: 'active', waiting: [adv('a', action)] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: expect.stringContaining(`jev ${action}`) }]);
    expect(d.jev).toEqual([expect.objectContaining({ jobId: 'a', advice: action, native: 'start', withJev: 'hold' })]);
  });

  it('active: approved overrides the hold', () => {
    const d = decide(inputs({ jevMode: 'active', waiting: [adv('a', action, { approved: true })] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.jev).toEqual([]);
  });
});

it('ask_human reason says awaiting approval', () => {
  const d = decide(inputs({ jevMode: 'active', waiting: [adv('a', 'ask_human')] }), 'd1');
  expect(d.hold[0]!.reason).toBe('jev ask_human: awaiting approval');
});

describe.each(['chat_only', 'run_deterministic'] as const)('jev %s boost', (action) => {
  it('shadow: priority unchanged, order divergence recorded', () => {
    const waiting = [adv('plain', 'proceed_full', { priority: 55 }), adv('cheap', action, { priority: 50 })];
    const d = decide(inputs({ jevMode: 'shadow', waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['plain', 'cheap']);
    expect(d.start[1]!.effectivePriority).toBe(50);
    expect(d.jev).toEqual([expect.objectContaining({ jobId: 'cheap', advice: action, native: 'start', withJev: 'start' })]);
  });

  it('active: boosted by jevCheapBoost and runs first', () => {
    const waiting = [adv('plain', 'proceed_full', { priority: 55 }), adv('cheap', action, { priority: 50 })];
    const d = decide(inputs({ jevMode: 'active', waiting }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['cheap', 'plain']);
    expect(d.start[0]!.effectivePriority).toBe(60);
  });
});

describe('unclassified jobs', () => {
  it('active: held awaiting Jev classification', () => {
    const d = decide(inputs({ jevMode: 'active', waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'awaiting Jev classification' }]);
  });

  it('shadow: started natively', () => {
    const d = decide(inputs({ jevMode: 'shadow', waiting: [job('a')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
    expect(d.hold).toEqual([]);
  });

  it('active: approved unclassified job still starts', () => {
    const d = decide(inputs({ jevMode: 'active', waiting: [job('a', { approved: true })] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['a']);
  });
});

it('proceed_full / allow_subagent / research_capped: no divergence, no boost', () => {
  const waiting = (['proceed_full', 'allow_subagent', 'research_capped'] as const).map((a) => adv(a, a));
  const d = decide(inputs({ jevMode: 'active', waiting }), 'd1');
  expect(d.start).toHaveLength(3);
  expect(d.start.every((s) => s.effectivePriority === 50)).toBe(true);
  expect(d.jev).toEqual([]);
});

it('a jev-held job does not consume lane room in active mode', () => {
  const waiting = [adv('held', 'ask_human', { priority: 99 }), job('ok', { priority: 10, jevAdvice: advice('proceed_full') })];
  const d = decide(inputs({ jevMode: 'active', waiting, machines: [{ id: 'local', label: 'l', maxLanes: 1, online: true, executors: ['test'] }] }), 'd1');
  expect(d.start.map((s) => s.jobId)).toEqual(['ok']);
});
