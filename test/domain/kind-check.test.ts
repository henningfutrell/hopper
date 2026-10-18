// Jev's kind check (issue #655, the decision point `intake-kind`): Jev can only ask a work job for research or a
// proposal before it starts, never the reverse; a check with no sure pick keeps the job as it is. Pure.
import { describe, expect, it } from 'vitest';
import { checkedKind, kindCheckDue, kindCheckState, kindOptions, KIND_CHECK_TEXT_MAX } from '../../src/domain/kind-check.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', labels: ['hopper'], ...over,
});
const fromSource = (over: Partial<Job> = {}): Job => job('a', { source: github(), ...over });
const applied = (pick: string, confidence = 0.95) => ({ asked: true as const, pickId: 'p', pick, confidence, applied: true });

describe('the options of intake-kind', () => {
  it('are keep, research and proposal: never a kind that does more than the work', () => {
    expect(kindOptions().map((o) => o.id)).toEqual(['keep', 'research', 'proposal']);
  });
});

describe('when a kind check is due', () => {
  it('is due for a work job from a job source that never started, on an executor that writes reviews', () => {
    expect(kindCheckDue(fromSource(), true)).toBe(true);
  });

  it('is not due for a job that asks for research or a proposal already, or was checked', () => {
    expect(kindCheckDue(fromSource({ spec: { executor: 'test', payload: {}, research: true } }), true)).toBe(false);
    expect(kindCheckDue(fromSource({ spec: { executor: 'test', payload: {}, proposal: true } }), true)).toBe(false);
    expect(kindCheckDue(fromSource({ kindCheck: { applied: true, pick: 'keep', confidence: 0.9 } }), true)).toBe(false);
  });

  it('is not due for a job with no source, a fork, a follow-on, a tend job, or one that started before', () => {
    expect(kindCheckDue(job('a'), true)).toBe(false);
    expect(kindCheckDue(fromSource({ forkOf: { jobId: 'p', questionId: 'q', kind: 'research', question: 'why?' } }), true)).toBe(false);
    expect(kindCheckDue(fromSource({ followOn: { jobId: 'p', proposalId: 'x', pathId: '1' } as Job['followOn'] }), true)).toBe(false);
    expect(kindCheckDue(fromSource({ spec: { executor: 'test', payload: {}, tend: true } }), true)).toBe(false);
    expect(kindCheckDue(fromSource({ attempts: 1 }), true)).toBe(false);
    expect(kindCheckDue(fromSource({ pendingAnswer: 'yes' }), true)).toBe(false);
  });

  it('is not due on an executor that cannot write a research report or a proposal', () => {
    expect(kindCheckDue(fromSource(), false)).toBe(false);
  });
});

describe('what Jev reads', () => {
  it('the job\'s facts and its text, marked untrusted and cut', () => {
    const long = 'x'.repeat(KIND_CHECK_TEXT_MAX + 10);
    const s = kindCheckState(fromSource({ spec: { executor: 'test', payload: { prompt: long }, goal: 'Fix the parser' } }));
    expect(s).toMatchObject({ job: { id: 'a', goal: 'Fix the parser' }, source: { kind: 'github-account', repo: 'o/r', labels: ['hopper'] }, textCut: long.length });
    expect((s.untrustedText as string).length).toBe(KIND_CHECK_TEXT_MAX);
  });
});

describe('Jev\'s answer, applied', () => {
  it('research or proposal asks the job for it; keep keeps the work', () => {
    expect(checkedKind(applied('research'))).toEqual({ kind: 'research', check: { pick: 'research', confidence: 0.95, applied: true, kind: 'research' } });
    expect(checkedKind(applied('proposal'))).toEqual({ kind: 'proposal', check: { pick: 'proposal', confidence: 0.95, applied: true, kind: 'proposal' } });
    expect(checkedKind(applied('keep'))).toEqual({ check: { pick: 'keep', confidence: 0.95, applied: true } });
  });

  it('no sure pick keeps the work: no answer, not sure, Jev not there, or a pick that is no option', () => {
    expect(checkedKind({ asked: false })).toEqual({ check: { applied: false, fail: 'skipped' } });
    expect(checkedKind({ asked: true, pickId: 'p', applied: false, notApplied: 'no_pick' })).toEqual({ check: { applied: false, fail: 'no_answer' } });
    expect(checkedKind({ asked: true, pickId: 'p', pick: 'research', confidence: 0.4, applied: false, notApplied: 'below_threshold' }))
      .toEqual({ check: { pick: 'research', confidence: 0.4, applied: false, fail: 'not_sure' } });
    expect(checkedKind(applied('work-harder'))).toEqual({ check: { pick: 'work-harder', confidence: 0.95, applied: false, fail: 'no_answer' } });
  });
});
