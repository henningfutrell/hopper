// Issue #655 part 13: Jev's sandbox check (the decision point `sandbox-request`), the second stage of gate 2. Jev allows,
// holds or denies a request the approvals would approve with no person; a pick that is no option, or no sure pick, holds
// it for a person (fail closed). Jev checks only under sandbox strictness `standard`, for a template not of low blast
// radius. A deny by Jev lowers the job's trust as a person's deny does, and counts toward the quarantine. Pure.
import { describe, expect, it } from 'vitest';
import {
  ALLOW, checkedVerdict, jevChecks, pickedVerdict, SANDBOX_CHECK_REASONS, sandboxCheckOptions, sandboxCheckState, sandboxCheckText,
} from '../../src/domain/sandbox-check.ts';
import { DEFAULT_SANDBOX_STRICTNESS, type SandboxStrictness } from '../../src/domain/sandbox-strictness.ts';
import { DENY_REASON, deniedStamp, JEV_DENY_REASON, ruleCeiling, signStamp, stampHold, trustApprovable, type TrustStamp } from '../../src/domain/trust-stamp.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { job } from '../decider/support.ts';

const rated = (level: 'low' | 'medium' | 'high') => ({ name: `t-${level}`, radius: { level } });

describe('the options of sandbox-request', () => {
  it('are allow, and hold or deny with each reason; nothing else', () => {
    const ids = sandboxCheckOptions().map((o) => o.id);
    expect(ids[0]).toBe(ALLOW);
    expect(ids).toHaveLength(1 + 2 * SANDBOX_CHECK_REASONS.length);
    expect(ids).toContain('hold:novel_target');
    expect(ids).toContain('deny:pattern_suspicious');
  });

  it('a pick that is no option gives no verdict: Jev cannot invent one', () => {
    expect(pickedVerdict(ALLOW)).toEqual({ verdict: 'allow' });
    expect(pickedVerdict('hold:rate_spike')).toEqual({ verdict: 'hold', reason: 'rate_spike' });
    expect(pickedVerdict('deny:out_of_scope')).toEqual({ verdict: 'deny', reason: 'out_of_scope' });
    for (const forged of ['approve', 'allow:write', 'deny:because', 'widen:all', '']) expect(pickedVerdict(forged)).toBeUndefined();
  });
});

describe('Jev\'s answer, applied', () => {
  it('a sure pick is the verdict', () => {
    expect(checkedVerdict({ asked: true, pickId: 'p', pick: 'deny:history_denied', confidence: 0.9, applied: true })).toEqual({ verdict: 'deny', reason: 'history_denied' });
    expect(checkedVerdict({ asked: true, pickId: 'p', pick: ALLOW, confidence: 0.9, applied: true })).toEqual({ verdict: 'allow' });
  });

  it('fails closed: no ask, no answer, not sure or a forged pick holds the request for a person', () => {
    expect(checkedVerdict({ asked: false })).toEqual({ verdict: 'hold', reason: 'skipped' });
    expect(checkedVerdict({ asked: true, pickId: 'p', applied: false, notApplied: 'no_pick' })).toEqual({ verdict: 'hold', reason: 'no_answer' });
    expect(checkedVerdict({ asked: true, pickId: 'p', pick: ALLOW, confidence: 0.4, applied: false, notApplied: 'below_threshold' })).toEqual({ verdict: 'hold', reason: 'not_sure' });
    expect(checkedVerdict({ asked: true, pickId: 'p', pick: 'approve', confidence: 0.99, applied: true })).toEqual({ verdict: 'hold', reason: 'no_answer' });
    expect(sandboxCheckText('skipped')).toBe('Jev could not be asked');
  });
});

describe('when Jev checks', () => {
  it('under standard, for a medium, high or unrated template; never a low one', () => {
    const s = DEFAULT_SANDBOX_STRICTNESS;
    expect(jevChecks(s, rated('medium'))).toBe(true);
    expect(jevChecks(s, rated('high'))).toBe(true);
    expect(jevChecks(s, { name: 'unrated' })).toBe(true);
    expect(jevChecks(s, undefined)).toBe(true);
    expect(jevChecks(s, rated('low'))).toBe(false);
  });

  it('relaxed keeps the approvals alone; strict and locked ask a person already', () => {
    for (const level of ['relaxed', 'strict', 'locked'] as const) expect(jevChecks({ ...DEFAULT_SANDBOX_STRICTNESS, default: level }, rated('high'))).toBe(false);
    const s: SandboxStrictness = { default: 'relaxed', radius: { high: 'standard' }, templates: { 't-medium': 'standard' } };
    expect(jevChecks(s, rated('high'))).toBe(true);
    expect(jevChecks(s, rated('medium'))).toBe(true);
  });
});

describe('what Jev reads', () => {
  it('the request, the template\'s profiles and radius, the job and its other requests; the job\'s words marked untrusted, no secret names', () => {
    const t = { name: 'aws-dev', secrets: ['DB_PASSWORD'], profiles: [{ operation: 'write', asset: { kind: 'aws-role', name: '1/dev' } }], radius: { level: 'high', reasons: ['write aws-role/1/dev'] } } as unknown as TemplateView;
    const state = sandboxCheckState({
      request: { id: 'r1', template: 'aws-dev', purpose: 'Deploy', plan: 'terraform apply', askedAt: '2026-10-17T10:00:00.000Z' },
      template: t, approver: 'the auto-approve policy', job: { ...job('j1'), level: 'approved', reasons: ['source:configured'] },
      history: [{ template: 'aws-read', state: 'declined', by: 'Ada', askedAt: '2026-10-17T09:00:00.000Z' }],
    });
    expect(state).toMatchObject({
      request: { id: 'r1', template: 'aws-dev', approver: 'the auto-approve policy' },
      template: { name: 'aws-dev', profiles: ['write aws-role/1/dev'], secrets: 1, radius: { level: 'high' } },
      job: { id: 'j1', level: 'approved', reasons: ['source:configured'] },
      untrustedText: 'Purpose: Deploy\nPlan: terraform apply',
    });
    expect((state.history as unknown[])).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('DB_PASSWORD');
  });
});

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1, author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});
const stamped = (j: Job): Job => ({ ...j, stamp: signStamp(KEY, j, { level: ruleCeiling(j).level, reasons: ruleCeiling(j).reasons, by: 'intake', at: AT }) });
const denied = (j: Job, by: 'person' | 'jev'): Job & { stamp: TrustStamp } => ({ ...j, stamp: deniedStamp(KEY, j, AT, by)! });

describe('Jev\'s deny at gate 2', () => {
  it('lowers the job one level, by jev, with its own reason', () => {
    const j = denied(stamped(job('a', { source: github() })), 'jev');
    expect(j.stamp).toMatchObject({ level: 'trusted', by: 'jev', reasons: ['origin:trusted', 'author:assignee', JEV_DENY_REASON] });
  });

  it('counts with a person\'s deny: the second, either way, quarantines the job', () => {
    expect(denied(denied(stamped(job('a', { source: github() })), 'person'), 'jev').stamp).toMatchObject({ level: 'quarantined', was: 'trusted', by: 'jev' });
    expect(denied(denied(stamped(job('b', { source: github() })), 'jev'), 'person').stamp).toMatchObject({ level: 'quarantined', by: 'person' });
    expect(denied(denied(stamped(job('c', { source: github() })), 'jev'), 'jev').stamp.reasons).toEqual(expect.arrayContaining([JEV_DENY_REASON]));
    expect(DENY_REASON).not.toBe(JEV_DENY_REASON);
  });

  it('below approved, the job waits for a person, who sees that Jev denied it', () => {
    const j = denied(stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) })), 'jev');
    expect(j.stamp.level).toBe('screened');
    expect(stampHold(KEY, j)).toBe('trust stamp screened is below approved (Jev denied its sandbox request): held — a person approves its trust on the job, or cancels it');
    expect(trustApprovable(KEY, j)).toBe(true);
  });
});
