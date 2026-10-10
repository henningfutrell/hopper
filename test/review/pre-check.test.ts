// The structural pre-check (issue #631): before the reviewer levels, a review item's newest version is checked for
// structure, with no model call — every part present, the summary (the first part) present, its links well formed, and
// a next version changed from the one sent back. Each gap is one fixed line of the list the job is sent back with.
import { describe, expect, it } from 'vitest';
import { reviewSections, type ReviewKind, type ReviewVersion } from '../../src/domain/types.ts';
import { preCheck } from '../../src/review/pre-check.ts';

const PROPOSAL = [
  'Goal: paint the shed',
  'Approach: two coats with a brush',
  'Alternatives considered: a spray gun',
  'Risks: rain on the second day',
  'Effort: an afternoon',
  'Context: the shed is bare wood',
].join('\n');
const REPORT = [
  'Question: which paint lasts longest',
  'Findings: oil paint',
  'Sources and evidence: the label',
  'Confidence: medium',
  'Open threads: none',
  'Next step: buy it',
].join('\n');

const version = (kind: ReviewKind, text: string, number = 1): ReviewVersion =>
  ({ number, text, ...reviewSections(kind, text), recentOutput: '', at: '2026-10-10T00:00:00.000Z' });
const gaps = (kind: ReviewKind, ...texts: string[]) => preCheck(kind, texts.map((t, i) => version(kind, t, i + 1)));

describe('the structural pre-check', () => {
  it('passes a complete proposal and a complete research report', () => {
    expect(gaps('proposal', PROPOSAL)).toEqual([]);
    expect(gaps('research', REPORT)).toEqual([]);
  });

  it('names each required part that is missing, in order', () => {
    expect(gaps('proposal', 'Goal: paint the shed\nApproach: a brush\nEffort: an hour')).toEqual([
      'Missing part: Alternatives considered.',
      'Missing part: Risks.',
      'Missing part: Context.',
    ]);
  });

  it('names a missing summary: the first part', () => {
    expect(gaps('proposal', PROPOSAL.replace('Goal: paint the shed\n', ''))).toEqual(['Missing summary: write the Goal: part.']);
    expect(gaps('research', REPORT.replace('Question: which paint lasts longest\n', ''))).toEqual(['Missing summary: write the Question: part.']);
  });

  it('names each broken link: an empty target, an anchor with no heading, a URL that does not parse', () => {
    const text = [
      PROPOSAL,
      'See [the plan]() and [the notes](#notes) and [the issue](https://) and [ok](https://example.com/a).',
      'Also <http://exa mple.com> and https://example.com/b.',
    ].join('\n');
    expect(gaps('proposal', text)).toEqual([
      'Broken link: [the plan]() has no target.',
      'Broken link: [the notes](#notes) names no heading in the document.',
      'Broken link: [the issue](https://) is not a valid URL.',
      'Broken link: <http://exa mple.com> is not a valid URL.',
    ]);
  });

  it('accepts an anchor that names a heading, and a relative path', () => {
    expect(gaps('proposal', `${PROPOSAL}\n## Notes on paint\nSee [the notes](#notes-on-paint) and [the file](docs/paint.md).`)).toEqual([]);
  });

  it('names a next version that is the same as the one sent back: it does not answer the notes', () => {
    expect(gaps('proposal', PROPOSAL, `${PROPOSAL}\n`)).toEqual(['No change: version 2 is the same as version 1, so it does not answer the notes on version 1.']);
    expect(gaps('proposal', PROPOSAL, `${PROPOSAL}\nRevised: oil paint.`)).toEqual([]);
  });

  it('checks only the newest version', () => {
    expect(gaps('proposal', 'Goal: x', PROPOSAL)).toEqual([]);
  });
});
