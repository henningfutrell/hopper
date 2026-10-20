// Issue #655, part 19: the pull requests an issue's text names, which intake reads with its origin.
import { describe, expect, it } from 'vitest';
import { issueText, LINKED_MAX, linkedRefs, namesItem } from '../../src/domain/linked-pulls.ts';

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

describe('names in code and in the title (issue #2227)', () => {
  it('skips a bare #N in a fenced block or a code span; owner/name#N and URLs there still name', () => {
    const body = 'Log:\n```\nerror at #21\nsee x/y#22 and https://github.com/x/y/pull/23\n```\nand `#24` but #25.';
    expect(linkedRefs(ISSUE, body)).toEqual([{ repo: 'x/y', number: 22 }, { repo: 'x/y', number: 23 }, { repo: 'o/r', number: 25 }]);
  });

  it('reads the title with the body', () => {
    expect(linkedRefs(ISSUE, issueText({ title: 'Update PR #8', body: 'And #9.' }))).toEqual([{ repo: 'o/r', number: 8 }, { repo: 'o/r', number: 9 }]);
  });
});

describe('namesItem (issue #2227)', () => {
  const names = (title: string, body: string, repo = 'o/r', number = 8) => namesItem(ISSUE, issueText({ title, body }), repo, number);

  it('takes #N, PR #N, pull request #N and the URL, in the title or the body', () => {
    for (const text of ['#8', 'PR #8', 'pull request #8', 'Pull Request #8.', 'https://github.com/o/r/pull/8', 'o/r#8']) {
      expect(names(text, '')).toBe(true);
      expect(names('Edit a description', `Please update ${text} so it references this issue.`)).toBe(true);
    }
  });

  it('takes a name past the first LINKED_MAX', () => {
    const many = Array.from({ length: LINKED_MAX + 3 }, (_, i) => `#${100 + i}`).join(' ');
    expect(names('t', `${many} and PR #8`)).toBe(true);
  });

  it('refuses a number only in code, and says so', () => {
    expect(names('t', 'The log says `#8`.')).toBe('its issue o/r#7 names #8 only in code');
    expect(names('t', '```\nPR #8\n```')).toBe('its issue o/r#7 names #8 only in code');
  });

  it('refuses another repository\'s pull request named as a bare #N; takes owner/name#N or its URL', () => {
    expect(names('t', 'PR #8', 'x/y')).toBe('its issue o/r#7 does not name it (a pull request of another repository only as x/y#8 or by its URL)');
    expect(names('t', 'PR x/y#8', 'x/y')).toBe(true);
    expect(names('t', '`x/y#8`', 'x/y')).toBe(true);
    expect(names('t', 'https://github.com/x/y/pull/8', 'x/y')).toBe(true);
  });

  it('refuses a number not named, a near one, and the issue itself', () => {
    expect(names('t', 'PR #80, #8a, abc#8')).toBe('its issue o/r#7 does not name it');
    expect(names('t', 'This is #7.', 'o/r', 7)).toBe('its issue o/r#7 does not name it');
  });
});
