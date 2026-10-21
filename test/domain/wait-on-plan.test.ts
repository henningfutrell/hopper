// Issue #2205: a job that waits on a person's approval of an infra plan names the plan, and the hopper knows it. The wait
// is typed as the plan's (also when the job wrote it as a gated outside event), its approval wakes the job, and a plan no
// person can see or approve — not recorded, stale, failed its checks — ends the wait at once with why. Pure.
import { describe, expect, it } from 'vitest';
import { planWaitEnd, settledBy, waitOnLabel, waitOnOf, waitsFor, type WaitOn } from '../../src/domain/wait-on.ts';
import type { Job } from '../../src/domain/types.ts';

const ID = 'cc564657-1bd7-4a54-8484-958975d94524';
const OTHER = '0f0e0d0c-0b0a-4908-8706-050403020100';
const now = new Date('2026-10-20T02:12:00.000Z');
const plan = { id: ID, expiresAt: '2026-10-20T03:00:00.000Z', summary: undefined };

describe('a wait on an infra plan (issue #2205)', () => {
  it.each<[string, string]>([
    ['the on: line the job rules name', `infra plan ${ID}`],
    ['plan and its id', `plan ${ID.toUpperCase()}`],
    ['a gated outside event that names the plan', `outside: gated: admin approval of infra plan ${ID} (Keycloak statefulset restart, production)`],
  ])('is read from %s', (_, on) => {
    expect(waitOnOf({ for: 'admin approval', on })).toEqual({ kind: 'plan', planId: ID });
  });

  it('is read from what the job wrote when it has no on: line; a sandbox plan with no id is not one', () => {
    expect(waitOnOf({ for: `admin approval of infra plan ${ID}` })).toEqual({ kind: 'plan', planId: ID });
    expect(waitOnOf({ for: 'the plan of the box', on: 'outside: gated: the apply' })).toEqual({ kind: 'outside', what: 'the apply', why: 'gated' });
  });

  it('is said with the plan\'s id', () => {
    expect(waitOnLabel({ kind: 'plan', planId: ID })).toBe(`approval of infra plan ${ID}`);
  });

  it('the plan\'s approval wakes the jobs that wait on it, and no other', () => {
    const waiting = (id: string, on: WaitOn): Job => ({ id, status: 'waiting_on', wait: { for: 'x', since: now.toISOString(), on } }) as unknown as Job;
    const jobs = [waiting('on-plan', { kind: 'plan', planId: ID }), waiting('on-other', { kind: 'plan', planId: OTHER }), waiting('outside', { kind: 'outside', what: ID })];
    const s = settledBy({ type: 'infra.plan_approved', jobId: 'recorder', data: { plan: ID, by: 'Ada (ada@example.com)', tool: 'helm' } });
    expect(s).toEqual({ kind: 'plan', planId: ID, note: `infra plan ${ID} was approved by Ada (ada)` });
    expect(jobs.filter((j) => waitsFor(j, s!)).map((j) => j.id)).toEqual(['on-plan']);
    expect(settledBy({ type: 'infra.plan_approved', data: {} })).toBeUndefined();
  });

  it('a plan that waits for a person keeps the wait', () => {
    expect(planWaitEnd(ID, plan, undefined, now)).toBeUndefined();
  });

  it('a plan approved already settles it at once', () => {
    expect(planWaitEnd(ID, plan, { by: 'Ada' }, now)).toEqual({ settled: { kind: 'plan', planId: ID, note: `infra plan ${ID} was approved by Ada` } });
  });

  it('a plan not recorded where Infra and Needs you read it ends the wait, and the job is told so', () => {
    const end = planWaitEnd(ID, undefined, undefined, now);
    expect(end).toEqual({ told: expect.stringContaining(`no infra plan ${ID} is recorded on this hopper, so no person can see or approve it`) });
    expect((end as { told: string }).told).toContain('POST /job/infra-plans');
  });

  it('a stale plan, or one that failed its checks, ends the wait: nobody approves it', () => {
    expect(planWaitEnd(ID, { ...plan, expiresAt: '2026-10-20T02:00:00.000Z' }, undefined, now)).toEqual({ told: expect.stringContaining('is stale since 2026-10-20T02:00:00.000Z, so nobody approves it') });
    const failed = { ...plan, summary: { failed: true, checks: [{ ok: false, words: 'aws_instance.a has no map-migrated tag' }] } } as unknown as typeof plan;
    expect(planWaitEnd(ID, failed, undefined, now)).toEqual({ told: expect.stringContaining('failed its checks, so nobody approves it: aws_instance.a has no map-migrated tag') });
  });

  it('the plan\'s rejection wakes the jobs that wait on it, with its note (issue #2368)', () => {
    const s = settledBy({ type: 'infra.plan_rejected', jobId: 'recorder', data: { plan: ID, by: 'Ada (ada@example.com)', note: 'Keep the statefulset' } });
    expect(s).toEqual({ kind: 'plan', planId: ID, note: expect.stringContaining(`infra plan ${ID} was rejected by Ada (ada): Keep the statefulset`) });
    expect(s!.note).toContain('never approved');
  });

  it('a plan rejected already ends the wait at once, and the job is told who rejected it and why (issue #2368)', () => {
    expect(planWaitEnd(ID, plan, undefined, now, { by: 'Ada', note: 'Keep the statefulset' })).toEqual({ told: expect.stringContaining(`infra plan ${ID} was rejected by Ada: Keep the statefulset`) });
  });
});
