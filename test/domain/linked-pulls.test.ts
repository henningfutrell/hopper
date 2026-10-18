// Issue #655, part 19: the pull requests an issue's text names, which intake reads with its origin.
import { describe, expect, it } from 'vitest';
import { LINKED_MAX, linkedRefs } from '../../src/domain/linked-pulls.ts';

const ISSUE = { repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' };

describe('linkedRefs (issue #655, part 19)', () => {
  it('reads #N, owner/name#N and pull and issue URLs of the same GitHub, each once, in their order', () => {
    const body = 'Build on #12 and other-o/other.r#3.\nSee https://github.com/x/y/pull/9 and https://github.com/x/y/issues/4#issuecomment-1.\nAgain #12.';
    expect(linkedRefs(ISSUE, body)).toEqual([
      { repo: 'o/r', number: 12 }, { repo: 'other-o/other.r', number: 3 }, { repo: 'x/y', number: 9 }, { repo: 'x/y', number: 4 },
    ]);
  });

  it('skips the issue itself, a word joined to #, an anchor and another host', () => {
    const body = 'This is #7, o/r#7, abc#5, https://github.com/o/r/pull/8#discussion_r1 x, https://example.com/a/b/pull/2, page#top.';
    expect(linkedRefs(ISSUE, body)).toEqual([{ repo: 'o/r', number: 8 }]);
  });

  it('reads at most LINKED_MAX', () => {
    const body = Array.from({ length: LINKED_MAX + 5 }, (_, i) => `#${100 + i}`).join(' ');
    expect(linkedRefs(ISSUE, body)).toHaveLength(LINKED_MAX);
  });

  it('reads a GitHub Enterprise issue\'s own host', () => {
    expect(linkedRefs({ ...ISSUE, url: 'https://ghe.example.com/o/r/issues/7' }, 'https://ghe.example.com/a/b/pull/2 https://github.com/c/d/pull/3'))
      .toEqual([{ repo: 'a/b', number: 2 }]);
  });
});
