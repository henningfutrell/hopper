// Own PR checks red (issue #1230): a job that ended done while the checks of its own pull request were red is the hopper's
// to finish. The cause wins over Not complete; the assessor sends it back while under the retry limit, never grouped; its
// Continue runs the failed checks again once for each head commit, waits while they run, and red again goes on in the
// job's own session, told the failed checks and their logs.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAILURE_SETTINGS, type DomainEvent, type FailedCheck, type FailureRecord, type Job, type OwnPullRequestChecks } from '../../src/domain/types.ts';
import type { RerunResult } from '../../src/domain/ports.ts';
import { assess, type AssessInput } from '../../src/failures/assess.ts';
import { matchCause, OWN_PR_CHECKS_RED } from '../../src/failures/causes.ts';
import { signatureOf } from '../../src/failures/signature.ts';
import { CHECKS_WAIT_MS, createChecksRed, MAX_CHECKS_WAIT_MS, type ChecksRedDeps } from '../../src/failures/checks-red.ts';

const PR = 'https://github.com/o/r/pull/1226';
const RED = `not complete: the issue https://github.com/o/r/issues/1194 is open, and PR #1226: checks failed: test (node 24)`;

function input(error: string, over: Partial<AssessInput> = {}): AssessInput {
  const { signature } = signatureOf(error);
  return {
    error, signature, cause: matchCause(error, signature, []), job: { executor: 'herdr-claude', machineId: 'desk', pinned: false },
    attempt: 1, recent: [], settings: { ...DEFAULT_FAILURE_SETTINGS, maxAttempts: 3 }, ...over,
  };
}

describe('the cause Own PR checks red', () => {
  it('matches a miss that names its pull request\'s failed checks, ahead of Not complete', () => {
    expect(input(RED).cause).toMatchObject({ id: OWN_PR_CHECKS_RED, name: 'Own PR checks red', decision: 'continue' });
    expect(input('not complete: the issue x is open, and no pull request in o/r closes or references it').cause?.id).toBe('not-complete');
  });

  it('goes on to fix them, not a person, while under the retry limit; then a person, saying so', () => {
    expect(assess(input(RED, { checksFixes: 0 }))).toMatchObject({ cls: 'transient', decision: 'continue', auto: true });
    expect(assess(input(RED, { checksFixes: 2 })).summary).toMatch(/^Continues: it fixes the red checks of its pull request\./);
    const spent = assess(input(RED, { checksFixes: 3 }));
    expect(spent).toMatchObject({ decision: 'person' });
    expect(spent.reasons.join(' ')).toMatch(/retry limit reached: sent back 3 times for red checks/);
  });

  it('never grouped, nor joined to an open problem of its signature', () => {
    const recent = [{ jobId: 'a', machineId: 'desk', executor: 'herdr-claude' }, { jobId: 'b', machineId: 'desk', executor: 'herdr-claude' }];
    const a = assess(input(RED, { recent, open: { id: 'p1', title: 'Recurring', decision: 'hold' } }));
    expect(a).toMatchObject({ decision: 'continue' });
    expect(a.problem).toBeUndefined();
  });
});

describe('its Continue, step by step', () => {
  const job = { id: 'j1', workTree: '/work/j1', createdAt: '2026-10-15T10:00:00.000Z' } as unknown as Job;
  const record = { id: 'f1', jobId: 'j1', at: '2026-10-15T11:00:00.000Z', causeId: OWN_PR_CHECKS_RED, pending: 'continue' } as FailureRecord;
  const failed: FailedCheck[] = [{ name: 'test (node 24)', url: 'https://github.com/o/r/actions/runs/7/job/71' }];

  function harness(o: { checks: () => OwnPullRequestChecks | undefined; rerun?: ChecksRedDeps['rerunChecks']; now?: string; resumable?: boolean }) {
    const events: DomainEvent[] = [];
    const continued: { brief: string }[] = [];
    const reruns: { brief?: string }[] = [];
    const reran: string[][] = [];
    const ok = (): RerunResult => ({ ok: true, job });
    const d: ChecksRedDeps = {
      store: {
        jobs: { get: (id: string) => (id === job.id ? job : undefined) },
        events: {
          append: (e: { type: string; jobId?: string; data: Record<string, unknown> }) => { const ev = { ...e, seq: events.length + 1, at: '' } as unknown as DomainEvent; events.unshift(ev); return ev; },
          recent: (_n?: number, types?: string[], jobId?: string) => events.filter((e) => (!types || types.includes(e.type)) && (!jobId || e.jobId === jobId)),
        },
      } as unknown as ChecksRedDeps['store'],
      ownPullRequestChecks: async () => o.checks(),
      rerunChecks: o.rerun ?? (async (_j, f) => { reran.push(f.map((c) => c.name)); return { rerun: f.map((c) => c.name) }; }),
      checkLogs: async (_j, f) => f.map((c) => ({ ...c, log: ['FAIL test/landing.test.ts > answers in 200 ms: took 210.6 ms'] })),
      resumable: () => o.resumable ?? true,
      continueJob: async (_id, brief) => { continued.push({ brief }); return ok(); },
      rerun: async (_id, _by, brief) => { reruns.push({ ...(brief ? { brief } : {}) }); return ok(); },
      now: () => new Date(o.now ?? '2026-10-15T11:01:00.000Z'),
    };
    return { steps: createChecksRed(d), events, continued, reruns, reran };
  }

  it('red: the failed checks run again once, recorded; red again: the job goes on in its own session, told the failure', async () => {
    let state: OwnPullRequestChecks = { pullRequest: PR, headOid: 'abc1234', checks: 'failing', failed };
    const h = harness({ checks: () => state });
    expect(await h.steps.step(record)).toEqual({ kind: 'wait', ms: CHECKS_WAIT_MS, note: 'its failed checks run again: test (node 24)' });
    expect(h.reran).toEqual([['test (node 24)']]);
    expect(h.events.map((e) => [e.type, e.data])).toEqual([
      ['job.checks_rerun', { recordId: 'f1', pullRequest: PR, head: 'abc1234', checks: ['test (node 24)'] }],
      ['job.checks_rerun_asked', { recordId: 'f1', pullRequest: PR, head: 'abc1234', checks: ['test (node 24)'] }],
    ]);
    state = { ...state, checks: 'pending', failed: [] };
    expect(await h.steps.step(record)).toMatchObject({ kind: 'wait', note: `the checks of ${PR} are running` });
    state = { ...state, checks: 'failing', failed };
    const step = await h.steps.step(record);
    expect(step.kind).toBe('go');
    expect(h.reran).toHaveLength(1);
    if (step.kind === 'go') await step.go();
    expect(h.continued).toHaveLength(1);
    const brief = h.continued[0]!.brief;
    expect(brief).toMatch(/same session and work tree/);
    expect(brief).toContain(`The checks of your pull request ${PR} fail.`);
    expect(brief).toContain('- test (node 24): https://github.com/o/r/actions/runs/7/job/71');
    expect(brief).toContain('took 210.6 ms');
    expect(brief).toContain('The hopper ran the failed checks again once, and they failed again.');
    expect(brief).not.toContain('git commit --allow-empty');
  });

  it('the run again is recorded before it is asked: a stop while it is asked makes no second one (issue #1607)', async () => {
    const state: OwnPullRequestChecks = { pullRequest: PR, headOid: 'abc1234', checks: 'failing', failed };
    let asked = 0;
    const h = harness({ checks: () => state, rerun: async () => { asked += 1; throw new Error('the hopper stopped'); } });
    await expect(h.steps.step(record)).rejects.toThrow('the hopper stopped');
    expect(h.events.map((e) => e.type)).toEqual(['job.checks_rerun_asked']);
    const step = await h.steps.step(record);
    expect(asked).toBe(1);
    expect(step.kind).toBe('go');
    if (step.kind === 'go') await step.go();
    // Not known to have run again: the job may run them again itself.
    expect(h.continued[0]!.brief).toContain('git commit --allow-empty');
  });

  it('a new head commit with red checks gets its own run again', async () => {
    let state: OwnPullRequestChecks = { pullRequest: PR, headOid: 'abc1234', checks: 'failing', failed };
    const h = harness({ checks: () => state });
    await h.steps.step(record);
    state = { ...state, headOid: 'def5678' };
    expect(await h.steps.step(record)).toMatchObject({ kind: 'wait' });
    expect(h.reran).toHaveLength(2);
  });

  it('the run again refused: recorded with why, and the job goes on at once, allowed to run the checks again itself', async () => {
    const h = harness({ checks: () => ({ pullRequest: PR, checks: 'failing', failed }), rerun: async () => ({ rerun: [], refused: 'no Actions write permission' }) });
    const step = await h.steps.step(record);
    expect(h.events[0]!.data).toMatchObject({ checks: [], refused: 'no Actions write permission' });
    expect(step.kind).toBe('go');
    if (step.kind === 'go') await step.go();
    expect(h.continued[0]!.brief).toContain('git commit --allow-empty');
  });

  it('checks running past the longest wait: it goes on; no session to resume: a new job of its item, told the same', async () => {
    const h = harness({ checks: () => ({ pullRequest: PR, checks: 'pending', failed: [] }), now: new Date(Date.parse(record.at) + MAX_CHECKS_WAIT_MS).toISOString(), resumable: false });
    const step = await h.steps.step(record);
    expect(step.kind).toBe('go');
    if (step.kind === 'go') await step.go();
    expect(h.continued).toEqual([]);
    expect(h.reruns[0]!.brief).toMatch(/^The hopper runs this issue again: the checks of the earlier job's pull request/);
  });
});
