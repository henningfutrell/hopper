// Issue #558: the Vault settings page's pure model. A secret is only its metadata: the page says what it is, who set
// it and when — never a value — and checks a name before anything is sent.
import { describe, expect, it } from 'vitest';
import { approvalText, giveProblem, kindChoices, nameProblem, requestWaiting, secretFacts } from '../../ui/src/model/vault.ts';

describe('a vault secret on the page', () => {
  it('says its scope, who set it and who last changed it; never a value', () => {
    const facts = secretFacts({ id: 'a', name: 'KUBE_TOKEN', scope: 'k3s lab, namespace default', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Bo', changedAt: '2026-10-09T11:00:00Z' });
    expect(facts.map((f) => f.label)).toEqual(['Scope', 'Set by', 'Changed by']);
    expect(facts[0]!.value).toBe('k3s lab, namespace default');
    expect(facts[2]!.value).toContain('Bo');
  });

  it('without a scope or a change since it was set: only who set it', () => {
    const facts = secretFacts({ id: 'a', name: 'X', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z' });
    expect(facts.map((f) => f.label)).toEqual(['Set by']);
  });
});

describe('a name', () => {
  it('is a letter, then letters, digits, `_`, `.`, `-`, at most 64', () => {
    expect(nameProblem('KUBE_TOKEN')).toBeUndefined();
    expect(nameProblem('aws.prod-ro')).toBeUndefined();
    expect(nameProblem('')).toMatch(/name/);
    expect(nameProblem('1x')).toMatch(/letter/);
    expect(nameProblem('a b')).toMatch(/letter/);
    expect(nameProblem('x'.repeat(65))).toMatch(/64/);
  });
});

describe('a template on the page', () => {
  const base = { name: 'kube', image: 'img', secrets: ['A', 'B'], savedBy: 'Ada', savedAt: '2026-10-09T10:00:00Z' };
  it('never approved: its boxes get nothing', () => {
    expect(approvalText({ ...base, pending: { secrets: ['A', 'B'], image: true }, gives: [] })).toMatch(/not approved yet/);
  });
  it('approved as it is', () => {
    expect(approvalText({ ...base, approval: { image: 'img', secrets: ['A', 'B'], by: 'Ada', at: '' }, pending: { secrets: [], image: false }, gives: ['A', 'B'] })).toBe('approved');
  });
  it('widened or a new image: says what waits', () => {
    expect(approvalText({ ...base, approval: { image: 'old', secrets: ['A'], by: 'Ada', at: '' }, pending: { secrets: ['B'], image: true }, gives: [] })).toBe('waits for approval: a new image; B added');
  });
});

describe('a delivered secret on the page', () => {
  it('says when it was last delivered, to which machine and job', () => {
    const facts = secretFacts({ id: 'a', name: 'KUBE_TOKEN', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z', lastUsed: { at: '2026-10-09T12:00:00Z', machine: 'hopper-sandbox-kube', job: 'f3b1c2d4-0000-4000-8000-000000000001' } });
    expect(facts.map((f) => f.label)).toEqual(['Set by', 'Last delivered']);
    expect(facts[1]!.value).toContain('hopper-sandbox-kube');
    expect(facts[1]!.value).toContain('f3b1c2d4');
  });
});

describe('a credential request on the page (issue #583)', () => {
  const request = {
    id: 'r1', skill: 'render', title: 'Render', known: true, template: 'web', secret: 'render', setup: 'Account Settings → API Keys',
    kinds: [{ id: 'api-key', title: 'A Render API key' }, { id: 'deploy-hook', title: 'A deploy hook URL of one service' }],
    asked: [{ job: 'f3b1c2d4-0000-4000-8000-000000000001', machine: 'hopper-sandbox-web', why: 'deploy the web service', at: '2026-10-09T10:00:00Z' }],
    existing: [], createdAt: '2026-10-09T10:00:00Z',
  };

  it('says who waits — the job, its box and why — and offers the suggested kinds first, then something else', () => {
    expect(requestWaiting(request)).toEqual(['job f3b1c2d4 on hopper-sandbox-web: deploy the web service']);
    expect(kindChoices(request).map((k) => k.id)).toEqual(['api-key', 'deploy-hook', 'other']);
  });

  it('something else needs the user\'s words; a value is needed unless a secret the vault holds is given', () => {
    expect(giveProblem({ name: 'render', kind: 'api-key', note: '', value: 'x' }, request)).toBeUndefined();
    expect(giveProblem({ name: 'render', kind: 'other', note: '', value: 'x' }, request)).toMatch(/say what/);
    expect(giveProblem({ name: 'render', kind: 'api-key', note: '', value: '' }, request)).toMatch(/value/);
    expect(giveProblem({ name: 'render', kind: 'api-key', note: '', value: '' }, { ...request, existing: ['render'] })).toBeUndefined();
    expect(giveProblem({ name: '1x', kind: 'api-key', note: '', value: 'x' }, request)).toMatch(/letter/);
  });
});
