// Issue #2846 part 2: the bug-report recommendations of completion reviews wait on a person. Needs you's Bug reports row
// names each that waits, with how many jobs found it, and links to Your reports; an approved or dismissed one is not there.
import { describe, expect, it } from 'vitest';
import type { BugReportRecommendation } from '../../src/domain/review-defects.ts';
import { openRecommendationLines, recommendationState } from '../../ui/src/model/completion-review.ts';
import { needsYouRows, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';

const rec = (o: Partial<BugReportRecommendation>): BugReportRecommendation => ({
  signature: 's', title: 'A defect', description: 'd', jobId: 'j1', state: 'open', jobs: 1, at: '2026-10-26T00:00:00Z', lastAt: '2026-10-26T00:00:00Z', ...o,
});
const none = { n: 0, high: 0 };

describe('bug-report recommendations on Needs you (issue #2846 part 2)', () => {
  it('one line per recommendation that waits, on a Bug reports row that links to Your reports', () => {
    const lines = openRecommendationLines({ recommendations: [rec({ title: 'Loop', jobs: 3 }), rec({ title: 'Sweep' }), rec({ title: 'Gone', state: 'dismissed' })] });
    expect(lines).toEqual(['Loop · found in 3 jobs', 'Sweep']);
    const counts: NeedsYouCounts = { intake: 0, access: 0, plans: 0, signedOut: [], notReady: [], gaveUp: [], checksUnread: [], stuckLanding: [], tagged: 0, sorting: 0, recommended: lines,
      sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none } };
    expect(needsYouRows(counts).find((r) => r.kind === 'bug-reports')).toMatchObject({ label: 'Bug reports', href: '#reports', n: 2, details: lines });
    expect(openRecommendationLines(undefined)).toEqual([]);
    expect(openRecommendationLines({} as { recommendations?: BugReportRecommendation[] })).toEqual([]);
  });

  it('says what became of each', () => {
    expect(recommendationState(rec({}))).toContain('Nothing is filed before you approve it');
    expect(recommendationState(rec({ state: 'approved', by: 'Pat' }))).toBe('Approved by Pat: it went to Your reports.');
    expect(recommendationState(rec({ state: 'dismissed', by: 'Pat', reason: 'fixed' }))).toBe('Dismissed by Pat: fixed. It is not recommended again.');
  });
});
