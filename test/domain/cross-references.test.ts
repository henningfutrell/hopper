// Cross-reference detection (issue #430), pure: the closing references a text makes — each of GitHub's closing keywords,
// before `#N`, `owner/repo#N` or an issue URL — and the links of an issue: what GitHub confirms closes it, with the keyword
// its text used. A reference GitHub does not treat as closing is never linked.
import { describe, expect, it } from 'vitest';
import { CLOSING_KEYWORDS, closingReferences, linksOf, type IssueCrossReferences } from '../../src/domain/cross-references.ts';

const REPO = 'owner/app';

describe('closing references in a text', () => {
  it.each(CLOSING_KEYWORDS.map((k) => [k]))('%s #12, any case, with or without a colon', (keyword) => {
    expect(closingReferences(`${keyword} #12`, REPO)).toEqual([{ repo: REPO, number: 12, keyword }]);
    expect(closingReferences(`${keyword.toUpperCase()}: #12`, REPO)).toEqual([{ repo: REPO, number: 12, keyword }]);
  });

  it('another repository: owner/repo#N, and the issue URL of any repository', () => {
    expect(closingReferences('Closes other/lib#45', REPO)).toEqual([{ repo: 'other/lib', number: 45, keyword: 'closes' }]);
    expect(closingReferences('fixes https://github.com/other/lib/issues/7.', REPO)).toEqual([{ repo: 'other/lib', number: 7, keyword: 'fixes' }]);
    expect(closingReferences('Resolves https://github.com/owner/app/issues/3', REPO)).toEqual([{ repo: REPO, number: 3, keyword: 'resolves' }]);
  });

  it('each reference needs its own keyword: "closes #1, #2" closes #1 only', () => {
    expect(closingReferences('closes #1, #2', REPO)).toEqual([{ repo: REPO, number: 1, keyword: 'closes' }]);
    expect(closingReferences('Fixes #1, fixes other/lib#2\nResolved #3', REPO)).toEqual([
      { repo: REPO, number: 1, keyword: 'fixes' }, { repo: 'other/lib', number: 2, keyword: 'fixes' }, { repo: REPO, number: 3, keyword: 'resolved' },
    ]);
  });

  it('one reference once, its first keyword', () => {
    expect(closingReferences('Fixes #4. Also closes #4.', REPO)).toEqual([{ repo: REPO, number: 4, keyword: 'fixes' }]);
  });

  it.each([
    ['a mention', 'See #12'],
    ['a part', 'Part of #12'],
    ['another word', 'Refs #12, relates to #12'],
    ['a keyword inside a word', 'prefixes #12, unfixed #12'],
    ['a pull request URL', 'fixes https://github.com/owner/app/pull/12'],
    ['inline code', 'Run `fixes #12` to see'],
    ['a code block', '```\ncloses #12\n```'],
    ['an HTML comment', '<!-- closes #12 -->'],
  ])('%s is no closing reference', (_n, text) => {
    expect(closingReferences(text, REPO)).toEqual([]);
  });
});

describe('the links of an issue', () => {
  const issue = { repo: REPO, number: 12 };
  const pr = (repo: string, n: number, text: string) => ({ kind: 'pull_request' as const, repo, url: `https://github.com/${repo}/pull/${n}`, text });

  it('a mention GitHub confirms closes the issue is linked, with the keyword its text used; same and other repository', () => {
    const refs: IssueCrossReferences = {
      mentions: [pr(REPO, 20, 'Fixes #12'), pr('other/lib', 3, 'closes owner/app#12')],
      closing: [{ kind: 'pull_request', repo: REPO, url: `https://github.com/${REPO}/pull/20` }, { kind: 'pull_request', repo: 'other/lib', url: 'https://github.com/other/lib/pull/3' }],
    };
    expect(linksOf(issue, refs)).toEqual([
      { kind: 'pull_request', repo: REPO, url: `https://github.com/${REPO}/pull/20`, keyword: 'fixes' },
      { kind: 'pull_request', repo: 'other/lib', url: 'https://github.com/other/lib/pull/3', keyword: 'closes' },
    ]);
  });

  it('a closing text GitHub does not confirm is not linked; a mention that closes another issue is not either', () => {
    const refs: IssueCrossReferences = { mentions: [pr(REPO, 20, 'Fixes #12'), pr(REPO, 21, 'Fixes #13, see #12')], closing: [] };
    expect(linksOf(issue, refs)).toEqual([]);
  });

  it('linked on GitHub with no closing keyword in its text (by hand): linked, no keyword', () => {
    const refs: IssueCrossReferences = { mentions: [pr(REPO, 20, 'See #12')], closing: [{ kind: 'pull_request', repo: REPO, url: `https://github.com/${REPO}/pull/20` }] };
    expect(linksOf(issue, refs)).toEqual([{ kind: 'pull_request', repo: REPO, url: `https://github.com/${REPO}/pull/20` }]);
  });

  it('a commit that closed it: linked, with its message\'s keyword', () => {
    const url = `https://github.com/${REPO}/commit/abc123`;
    const refs: IssueCrossReferences = { mentions: [{ kind: 'commit', repo: REPO, url, text: 'Resolve #12: the thing' }], closing: [{ kind: 'commit', repo: REPO, url }] };
    expect(linksOf(issue, refs)).toEqual([{ kind: 'commit', repo: REPO, url, keyword: 'resolve' }]);
  });

  it('the repository compares without case, and a link is kept once', () => {
    const url = `https://github.com/${REPO}/pull/20`;
    const refs: IssueCrossReferences = {
      mentions: [pr(REPO, 20, 'fixes Owner/App#12')],
      closing: [{ kind: 'pull_request', repo: REPO, url }, { kind: 'pull_request', repo: REPO, url }],
    };
    expect(linksOf({ repo: 'OWNER/app', number: 12 }, refs)).toEqual([{ kind: 'pull_request', repo: REPO, url, keyword: 'fixes' }]);
  });
});
