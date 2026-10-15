// Auto-approval's rules (issue #1268): which request cards the hopper approves itself, and which wait for a person.
import { describe, expect, it } from 'vitest';
import { appSlug, autoApproval, autoApprovedReason, DEFAULT_INTAKE_AUTO_APPROVAL, type AutoApproveFacts } from '../../src/domain/intake-auto-approve.ts';
import type { OriginActor } from '../../src/domain/intake-origin.ts';

const act = (role: OriginActor['role'], login: string, trusted: boolean, app?: string): OriginActor => ({ role, login, trusted, ...(app ? { app } : {}) });
const facts = (over: Partial<AutoApproveFacts> = {}): AutoApproveFacts => ({
  actors: [act('author', 'stranger', false), act('labelled', 'owner', true), act('assigned', 'owner', true)],
  reopenedCard: false, editors: [], textApproved: false, guards: [], ...over,
});
const on = DEFAULT_INTAKE_AUTO_APPROVAL;
const withApps = { on: true, apps: ['helper'] };

describe('auto-approval rules (issue #1268)', () => {
  it('is on by default, with no app listed', () => {
    expect(DEFAULT_INTAKE_AUTO_APPROVAL).toEqual({ on: true, apps: [] });
  });

  it('a trusted author approves, whoever labelled or assigned it', () => {
    const f = facts({ actors: [act('author', 'owner', true), act('labelled', 'ci[bot]', false, 'ci[bot]'), act('assigned', 'stranger', false)] });
    expect(autoApproval(f, on)).toEqual({ rule: 'author', actor: 'owner' });
  });

  it('a listed app as author approves; the same app not listed does not', () => {
    const f = facts({ actors: [act('author', 'helper[bot]', false, 'helper[bot]'), act('labelled', 'owner', true), act('assigned', 'owner', true)] });
    expect(autoApproval(f, withApps)).toEqual({ rule: 'app', actor: 'helper[bot]' });
    expect(autoApproval(f, on)).toBeUndefined();
  });

  it('hopper:high added by a trusted actor approves a stranger\'s issue; added by someone else it does not', () => {
    expect(autoApproval(facts({ high: act('labelled', 'owner', true) }), on)).toEqual({ rule: 'high-label', actor: 'owner' });
    expect(autoApproval(facts({ high: act('labelled', 'stranger', false) }), on)).toBeUndefined();
    expect(autoApproval(facts(), on)).toBeUndefined();
  });

  it('a reopened card approves only when a trusted actor or a listed app reopened it', () => {
    const reopened = (a?: OriginActor) => facts({ actors: [], reopenedCard: true, ...(a ? { reopened: a } : {}) });
    expect(autoApproval(reopened(act('author', 'owner', true)), on)).toEqual({ rule: 'reopened', actor: 'owner' });
    expect(autoApproval(reopened(act('author', 'helper', false, 'helper')), withApps)).toEqual({ rule: 'reopened', actor: 'helper' });
    expect(autoApproval(reopened(act('author', 'stranger', false)), on)).toBeUndefined();
    expect(autoApproval(reopened(), on)).toBeUndefined();
  });

  it('a guard, or an edit by someone not trusted, keeps the card waiting', () => {
    const trusted = facts({ actors: [act('author', 'owner', true)] });
    expect(autoApproval({ ...trusted, guards: ['a job filed it'] }, on)).toBeUndefined();
    expect(autoApproval({ ...trusted, editors: [act('author', 'stranger', false)] }, on)).toBeUndefined();
    expect(autoApproval({ ...trusted, editors: [act('author', 'owner', true)] }, on)).toEqual({ rule: 'author', actor: 'owner' });
    // An edit before a person approved this same text does not count.
    expect(autoApproval({ ...trusted, editors: [act('author', 'stranger', false)], textApproved: true }, on)).toEqual({ rule: 'author', actor: 'owner' });
  });

  it('off: every card waits', () => {
    expect(autoApproval(facts({ actors: [act('author', 'owner', true)] }), { on: false, apps: [] })).toBeUndefined();
  });

  it('an app is listed by its slug, lowercased, with no [bot]; the reason names the rule and the actor', () => {
    expect(appSlug(' Helper[bot] ')).toBe('helper');
    expect(autoApprovedReason({ rule: 'high-label', actor: 'owner' })).toBe('approved by the hopper: labelled hopper:high by owner; taken at the next sync');
  });
});
