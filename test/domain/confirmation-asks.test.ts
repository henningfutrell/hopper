// Issue #909: an agent's API token approves what waits, but a high-risk plan and a write profile need a person. The
// hopper does not do such an approval for an API token: it asks a person to confirm it, and says so
// (design.md "A person confirms what an agent asks").
//
// Feature: a person confirms a high-risk approval that an API token asks for
//   Scenario: a low-risk plan needs no person; a high-risk plan, and a plan with no summary, need one
//   Scenario: a read profile needs no person; a write, sync or apply profile needs one
//   Scenario: the ask says what to approve, and who asked
//   Scenario: the latest ask of each item is kept, by kind; an ask is not sent again within the quiet time
import { describe, expect, it } from 'vitest';
import {
  ASK_QUIET_MINUTES, askedRecently, latestAsks, planAsk, planNeedsPerson, profileAsk, profileNeedsPerson, waitingWords,
} from '../../src/domain/confirmation-asks.ts';
import type { PlanSummary } from '../../src/domain/infra-plan-summary.ts';

const ROLE = { kind: 'aws-role', name: '123456789012/deploy' } as const;
const summary = (level: 'low' | 'high', words = 'Adds 1 security group rule in uat'): PlanSummary => ({
  words, level, counts: { create: 1, update: 0, replace: 0, delete: 0 }, environments: ['uat'], risks: [], blastRadius: '', checks: [], failed: false,
});
const PLAN = { id: '11111111-2222-4333-8444-555555555555', target: 'prod-network' };

describe('what needs a person', () => {
  it('a low-risk plan needs no person; a high-risk plan, and a plan with no summary, need one', () => {
    expect(planNeedsPerson({ summary: summary('low') })).toBe(false);
    expect(planNeedsPerson({ summary: summary('high') })).toBe(true);
    expect(planNeedsPerson({})).toBe(true);
  });

  it('a read profile needs no person; a write, sync or apply profile needs one', () => {
    expect(profileNeedsPerson({ operation: 'read' })).toBe(false);
    for (const operation of ['write', 'sync', 'apply'] as const) expect(profileNeedsPerson({ operation }), operation).toBe(true);
  });
});

describe('the ask', () => {
  it('names the plan, its target, its risk and its summary, and who asked', () => {
    const ask = planAsk({ ...PLAN, summary: summary('high', 'Destroys 1 database in prod') }, 'Grok Bot');
    expect(ask).toEqual({
      kind: 'infra-plan', ref: PLAN.id, plan: PLAN.id, asker: 'Grok Bot',
      words: 'approve plan 11111111 for prod-network (high risk): Destroys 1 database in prod',
    });
    expect(planAsk(PLAN, 'Grok Bot').words).toBe('approve plan 11111111 for prod-network (risk not known)');
  });

  it('names the template and the profile, and who asked', () => {
    expect(profileAsk('deploy', { operation: 'apply', asset: ROLE }, 'Grok Bot')).toEqual({
      kind: 'vault-profile', ref: 'deploy:apply/aws-role/123456789012/deploy', template: 'deploy', operation: 'apply', asset: ROLE, asker: 'Grok Bot',
      words: 'approve apply on aws-role 123456789012/deploy for template deploy',
    });
  });

  it('says that a person confirms it, in the UI', () => {
    expect(waitingWords(profileAsk('deploy', { operation: 'apply', asset: ROLE }, 'Grok Bot'))).toMatch(/^a person confirms this: approve apply on aws-role .* An API token does not approve a high-risk plan or a write, sync or apply profile.*approves it in the UI/);
  });
});

describe('the asks made', () => {
  const event = (at: string, data: Record<string, unknown>) => ({ at, data });
  const plan = (asker: string) => ({ kind: 'infra-plan', ref: PLAN.id, plan: PLAN.id, words: 'w', asker });

  it('keeps the latest ask of each item of a kind', () => {
    const asks = latestAsks([
      event('2026-10-12T10:00:00.000Z', plan('Grok Bot')),
      event('2026-10-12T10:30:00.000Z', plan('Other bot')),
      event('2026-10-12T10:40:00.000Z', { ...profileAsk('deploy', { operation: 'apply', asset: ROLE }, 'Grok Bot') }),
    ], 'infra-plan');
    expect([...asks]).toEqual([[PLAN.id, { asker: 'Other bot', at: '2026-10-12T10:30:00.000Z' }]]);
  });

  it('is not sent again within the quiet time', () => {
    const last = { asker: 'Grok Bot', at: '2026-10-12T10:00:00.000Z' };
    expect(askedRecently(undefined, new Date('2026-10-12T10:01:00Z'))).toBe(false);
    expect(askedRecently(last, new Date('2026-10-12T10:59:00Z'))).toBe(true);
    expect(askedRecently(last, new Date(Date.parse(last.at) + ASK_QUIET_MINUTES * 60_000))).toBe(false);
  });
});
