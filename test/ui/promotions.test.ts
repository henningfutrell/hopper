// Promote to GitHub in the UI (issue #946), pure: the form starts from the live promotion or the direct job's repository;
// a preview fills the text, labels and artifacts; nothing is posted before the public repository is confirmed; the
// lines a direct job shows — the offer, and where it was promoted with what changed since.
import { describe, expect, it } from 'vitest';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';
import type { PromotionDraft } from '../../src/domain/promotions.ts';
import { fromPreview, offerLine, previewProblem, previewRequest, promoteProblem, promoteRequest, promotionLine, startEdits } from '../../ui/src/model/promotions.ts';

const ART = { id: 'a1', title: 'Timeline', kind: 'svg', revision: 2, url: 'u' };
const d = (more: Partial<DirectJobView> = {}): DirectJobView => ({
  id: 'd1', title: 't', brief: 'b', labels: [], authorizations: [], submittedBy: { person: 'ops', via: 'ui' }, submittedAt: '2026-10-12T09:00:00.000Z',
  job: { id: 'j1', status: 'finished', questions: [] }, artifacts: [], repo: 'octo-org/hello', ...more,
});
const draft: PromotionDraft = {
  repo: 'octo-org/hello', visibility: 'public', target: { kind: 'issue' }, title: 'T', body: 'B', labels: ['sme:identity'], artifacts: [ART],
  includeRequester: false, footer: 'f', findings: [], notes: [],
};
const promotion = { id: 'p1', directJobId: 'd1', repo: 'octo-org/ops', kind: 'comment' as const, number: 4, commentId: 9, url: 'u', artifacts: [], promotedBy: 'ada', promotedAt: 'x', updatedAt: 'x', stale: [] };

describe('the promote form (issue #946)', () => {
  it('starts from the direct job\'s repository, or the live promotion\'s place', () => {
    expect(startEdits(d())).toMatchObject({ repo: 'octo-org/hello', target: 'issue', number: '' });
    expect(startEdits(d({ promotion }))).toMatchObject({ repo: 'octo-org/ops', target: 'comment', number: '4' });
  });

  it('asks for a preview only with a repository as owner/name, and an issue number for a comment', () => {
    expect(previewProblem({ ...startEdits(d()), repo: 'nope' })).toMatch(/owner\/name/);
    expect(previewProblem({ ...startEdits(d()), target: 'comment', number: '' })).toMatch(/number/);
    expect(previewRequest({ ...startEdits(d()), target: 'comment', number: '4', includeRequester: true })).toEqual({ repo: 'octo-org/hello', target: { kind: 'comment', number: 4 }, includeRequester: true });
  });

  it('fills the edits from the preview, and posts nothing to a public repository before it is confirmed', () => {
    const e = fromPreview(startEdits(d()), draft);
    expect(e).toMatchObject({ title: 'T', body: 'B', labels: 'sme:identity', artifacts: ['a1'], confirmPublic: false });
    expect(promoteProblem(e, draft)).toMatch(/public/);
    expect(promoteProblem({ ...e, confirmPublic: true }, draft)).toBeUndefined();
    expect(promoteProblem({ ...e, body: ' ' }, draft)).toMatch(/what to post/);
    expect(promoteRequest({ ...e, confirmPublic: true, labels: 'a, b, a' })).toEqual({
      repo: 'octo-org/hello', target: { kind: 'issue' }, title: 'T', body: 'B', labels: ['a', 'b'], artifacts: ['a1'], confirmPublic: true,
    });
  });

  it('says what is offered, and where it was promoted with what changed since', () => {
    expect(offerLine(d({ offer: 'asked' }))).toMatch(/asked to promote/);
    expect(offerLine(d({ offer: 'suggested', artifacts: [ART, ART] }))).toContain('2 artifacts');
    expect(offerLine(d())).toBeUndefined();
    expect(promotionLine(d({ promotion }))).toBe('Promoted as a comment on octo-org/ops#4');
    expect(promotionLine(d({ promotion: { ...promotion, kind: 'issue', stale: ['a1', 'a2'] } }))).toBe('Promoted as issue octo-org/ops#4 · 2 artifacts changed since: promote again to update it');
  });
});
