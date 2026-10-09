// Issue #558: the Vault settings page's pure model. A secret is only its metadata: the page says what it is, who set
// it and when — never a value — and checks a name before anything is sent.
import { describe, expect, it } from 'vitest';
import { approvalText, explicitApprovals, profileText, radiusText, keptText, nameProblem, referenceHint, secretFacts } from '../../ui/src/model/vault.ts';

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

describe('a vault secret kept in a vault backend (issue #585)', () => {
  const kept = { id: 'a', name: 'DB_PASS', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z', backend: { name: 'my-vault', reference: 'apps/db#password' } };

  it('says where it is kept and that it is read there at each use; the hopper holds no value', () => {
    expect(secretFacts(kept).find((f) => f.label === 'Kept in')!.value).toBe('my-vault · apps/db#password');
    expect(keptText(kept)).toBe('kept in my-vault · read at each use');
    expect(keptText({ ...kept, backend: undefined })).toBe('value set · write-only');
  });

  it('the reference field shows the form each backend reads', () => {
    expect(referenceHint('hashicorp-vault')).toBe('apps/db#password');
    expect(referenceHint('1password')).toBe('op://Infra/db/password');
    expect(referenceHint('bitwarden')).toMatch(/^[0-9a-f-]{36}$/);
    expect(referenceHint('a-custom-plugin')).toBe('');
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
  const radius = { level: 'low' as const, reasons: [], profiles: [] };
  const base = { name: 'kube', image: 'img', secrets: ['A', 'B'], profiles: [], savedBy: 'Ada', savedAt: '2026-10-09T10:00:00Z', radius };
  it('never approved: its boxes get nothing', () => {
    expect(approvalText({ ...base, pending: { secrets: ['A', 'B'], image: true, profiles: [] }, gives: [] })).toMatch(/not approved yet/);
  });
  it('approved as it is', () => {
    expect(approvalText({ ...base, approval: { image: 'img', secrets: ['A', 'B'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, profiles: [] }, gives: ['A', 'B'] })).toBe('approved');
  });
  it('widened or a new image: says what waits', () => {
    expect(approvalText({ ...base, approval: { image: 'old', secrets: ['A'], by: 'Ada', at: '' }, pending: { secrets: ['B'], image: true, profiles: [] }, gives: [] })).toBe('waits for approval: a new image; B added');
  });
  // Issue #584: a profile added waits too; a write, sync or apply profile waits for its own explicit approval.
  const READ = { operation: 'read' as const, asset: { kind: 'cluster' as const, name: 'x' } };
  const WRITE = { operation: 'write' as const, asset: { kind: 'cluster' as const, name: 'x' } };
  it('a profile added: says which, and which needs an explicit approval', () => {
    const t = { ...base, profiles: [READ, WRITE], approval: { image: 'img', secrets: ['A', 'B'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, profiles: [READ, WRITE] }, gives: ['A', 'B'] };
    expect(approvalText(t)).toBe('waits for approval: read on cluster x; write on cluster x (explicit)');
    expect(explicitApprovals(t)).toEqual([WRITE]);
    expect(profileText(WRITE)).toBe('write on cluster x');
  });
  it('the rating in a few words, its level first', () => {
    expect(radiusText({ level: 'high', reasons: ['write on cluster x: it changes the asset; approved'], profiles: [] })).toBe('high radius: write on cluster x: it changes the asset; approved');
    expect(radiusText({ level: 'low', reasons: ['a', 'b'], profiles: [] })).toBe('low radius: a; b');
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
