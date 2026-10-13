// Issue #946: Promote to GitHub. What a finished direct job carries to GitHub when a person promotes it: a cleaned-up
// brief, the results, its artifacts as links that need a hopper sign-in, its routing labels but never the hopper's own,
// who promoted it, and the requester only when asked. The scan before posting: a secret is never posted; personal
// data only on a private repository, and only when the person says so. Pure.
//
// Feature: Promote to GitHub — what carries over
//   Scenario: the draft cleans the brief and the results, and leaves out the requester by default
//   Scenario: the footer links the hopper only on its public URL
//   Scenario: the hopper's own labels never carry over
//   Scenario: a secret is refused; personal data needs a private repository and the person's word
//   Scenario: an artifact changed after the promotion is stale
//   Scenario: a finished job is offered for promotion: asked at submit, or because it made an artifact
import { describe, expect, it } from 'vitest';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';
import { carriedLabels, promotionOffer, promotionText, staleArtifacts, type Promotion } from '../../src/domain/promotions.ts';
import { cleanText, postRefusal, scanText } from '../../src/promotions/scan.ts';

const ARTIFACT = { id: 'a1', title: 'Lockout timeline', summary: 'When each sign-in failed', revision: 2 };

describe('the promoted text (issue #946)', () => {
  it('cleans secrets and personal data out of the text', () => {
    const text = cleanText(`Reset for ada@example.com from 10.1.2.3, token ghp_${'a1B2'.repeat(9)}, call +44 20 7946 0958.`);
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('10.1.2.3');
    expect(text).not.toContain('ghp_a1B2');
    expect(text).not.toContain('7946');
    expect(text).toContain('[email, masked]');
  });

  it('composes the body, the artifacts and the footer; links the hopper only on its public URL', () => {
    const withUrl = promotionText({
      body: 'What was found.', artifacts: [ARTIFACT], directJobId: 'd1', publicUrl: 'https://hopper.example.com', promotedBy: 'octocat',
    });
    expect(withUrl).toContain('What was found.');
    expect(withUrl).toContain('[Lockout timeline](https://hopper.example.com/#artifacts/a1) — When each sign-in failed (revision 2)');
    expect(withUrl).toContain('https://hopper.example.com/#direct-jobs');
    expect(withUrl).toContain('a hopper sign-in');
    expect(withUrl).toContain('Promoted by octocat.');
    expect(withUrl).not.toContain('Requested by');

    const noUrl = promotionText({ body: 'x', artifacts: [ARTIFACT], directJobId: 'd1', promotedBy: 'octocat', requester: 'ops' });
    expect(noUrl).not.toContain('http');
    expect(noUrl).toContain('Lockout timeline — When each sign-in failed (revision 2, artifact a1 in the hopper)');
    expect(noUrl).toContain('Requested by ops.');
  });

  it('carries the routing labels, never the hopper\'s own', () => {
    expect(carriedLabels(['sme:identity', 'hopper', 'hopper:high', 'Hopper', 'bug', 'sme:identity'])).toEqual(['sme:identity', 'bug']);
  });
});

describe('the scan before posting (issue #946)', () => {
  it('finds a secret, and personal data', () => {
    expect(scanText('plain words')).toEqual([]);
    expect(scanText(`key AKIA${'A'.repeat(16)}`).map((f) => f.kind)).toEqual(['secret']);
    expect(scanText('mail ada@example.com').map((f) => f.kind)).toEqual(['personal']);
    expect(scanText('from 192.168.1.20').map((f) => f.kind)).toEqual(['personal']);
  });

  it('refuses a secret always; personal data unless the repository is private and the person allows it', () => {
    const secret = scanText(`ghp_${'a1B2'.repeat(9)}`);
    expect(postRefusal(secret, { visibility: 'private', allowPersonalData: true })).toMatch(/secret/);
    const personal = scanText('ada@example.com');
    expect(postRefusal(personal, { visibility: 'private' })).toMatch(/personal data/);
    expect(postRefusal(personal, { visibility: 'public', allowPersonalData: true })).toMatch(/public/);
    expect(postRefusal(personal, { visibility: 'private', allowPersonalData: true })).toBeUndefined();
    expect(postRefusal([], { visibility: 'public' })).toBeUndefined();
  });
});

const promotion: Promotion = {
  id: 'p1', directJobId: 'd1', repo: 'octo-org/hello', kind: 'issue', number: 3, url: 'https://github.invalid/octo-org/hello/issues/3',
  artifacts: [{ id: 'a1', title: 'Lockout timeline', revision: 2 }], promotedBy: 'octocat', promotedAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z',
};

describe('after the promotion (issue #946)', () => {
  it('marks an artifact changed since as stale', () => {
    expect(staleArtifacts(promotion, [{ id: 'a1', revision: 2 }])).toEqual([]);
    expect(staleArtifacts(promotion, [{ id: 'a1', revision: 3 }])).toEqual(['a1']);
  });

  const view = (more: Partial<DirectJobView>): DirectJobView => ({
    id: 'd1', title: 't', brief: 'b', labels: [], authorizations: [], submittedBy: { person: 'ops', via: 'ui' }, submittedAt: '2026-10-12T09:00:00.000Z',
    job: { id: 'j1', status: 'finished', questions: [] }, artifacts: [], ...more,
  });

  it('offers a finished job: asked at submit, or because it made an artifact; never one promoted, or not finished', () => {
    expect(promotionOffer(view({ promoteWhenDone: true }))).toBe('asked');
    expect(promotionOffer(view({ artifacts: [{ ...ARTIFACT, kind: 'svg', url: 'u' }] }))).toBe('suggested');
    expect(promotionOffer(view({}))).toBeUndefined();
    expect(promotionOffer(view({ promoteWhenDone: true, job: { id: 'j1', status: 'running', questions: [] } }))).toBeUndefined();
    expect(promotionOffer(view({ promoteWhenDone: true, promotion: { ...promotion, stale: [] } }))).toBeUndefined();
  });
});
