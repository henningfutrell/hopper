import { describe, expect, it } from 'vitest';
import type { Job, JobSpec } from '../../src/domain/types.ts';
import { createFakeRouter } from './fake-router.ts';

const router = createFakeRouter({ clock: { now: () => new Date('2026-10-02T12:00:00.000Z') } });

const makeJob = (spec: Partial<JobSpec> = {}): Job => ({
  id: 'job-1', spec: { executor: 'noop', payload: {}, ...spec }, priority: 50, status: 'queued', approved: false,
  createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', attempts: 0,
});

const table: [string, Partial<JobSpec>, string, boolean][] = [
  ['bypass marker in goal', { goal: 'Please BYPASS JEV now', kind: 'account' }, 'proceed_full', false],
  ['"no jev" in meta.notes', { kind: 'chat', meta: { notes: 'no jev here' } }, 'proceed_full', false],
  ['bypass beats cached artifact', { goal: 'no jev', meta: { cached_artifact: 'x' } }, 'proceed_full', false],
  ['cached artifact', { kind: 'chat', meta: { cached_artifact: 'a.md' } }, 'reuse_cache', true],
  ['cached artifact beats stop_retry', { meta: { cached_artifact: 'a', prior_error: 'e', same_error_count: 2 } }, 'reuse_cache', true],
  ['prior error repeated', { kind: 'lookup', meta: { prior_error: 'boom', same_error_count: 1 } }, 'stop_retry', true],
  ['prior error not repeated', { meta: { prior_error: 'boom', same_error_count: 0 } }, 'proceed_full', true],
  ['lookup', { kind: 'lookup' }, 'run_deterministic', true],
  ['chat', { kind: 'chat' }, 'chat_only', true],
  ['account', { kind: 'account', meta: { needs_subagent: true } }, 'ask_human', true],
  ['needs_subagent', { kind: 'research', meta: { needs_subagent: true } }, 'allow_subagent', true],
  ['research', { kind: 'research' }, 'research_capped', true],
  ['browser', { kind: 'browser' }, 'research_capped', true],
  ['coding falls through', { kind: 'coding' }, 'proceed_full', true],
  ['no kind', {}, 'proceed_full', true],
];

describe('fake router precedence (test double at the Router seam)', () => {
  it('is named fake', () => expect(router.name).toBe('fake'));

  it.each(table)('%s', async (_name, spec, action, jevUsed) => {
    const advice = await router.advise(makeJob(spec));
    expect(advice.action).toBe(action);
    expect(advice.details.jevUsed).toBe(jevUsed);
    expect(advice.source).toBe('fake');
    expect(advice.at).toBe('2026-10-02T12:00:00.000Z');
    expect(advice.reason).not.toBe('');
  });
});
