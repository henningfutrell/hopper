// Issue #655 part 19: the job view's line of a job's links — its repository's visibility and the pull requests its item's
// text names — in plain words; one of a fork that no trusted actor wrote, or one not read, is marked.
import { describe, expect, it } from 'vitest';
import { linkLines } from '../../ui/src/model/trust.ts';

const src = { source: 'github', kind: 'github-account', key: 'k' };

describe('linkLines', () => {
  it('says the visibility, then each pull request', () => {
    expect(linkLines({ source: { ...src, visibility: 'public', linkedPulls: [
      { url: 'https://github.com/o/r/pull/3', author: 'stranger', fork: true, trusted: false },
      { url: 'https://github.com/o/r/pull/4', author: 'owner', fork: false, trusted: true },
      { url: 'https://github.com/o/r/issues/5', trusted: false, unread: true },
    ] } })).toEqual([
      { text: 'public repository', warn: false },
      { text: 'names o/r#3, of a fork, by stranger (not a trusted actor)', warn: true, url: 'https://github.com/o/r/pull/3' },
      { text: 'names o/r#4, by owner', warn: false, url: 'https://github.com/o/r/pull/4' },
      { text: 'names o/r#5, which could not be read', warn: true, url: 'https://github.com/o/r/issues/5' },
    ]);
  });

  it('a private repository with no names is one line; a job with none kept has none', () => {
    expect(linkLines({ source: { ...src, visibility: 'private', linkedPulls: [] } })).toEqual([{ text: 'private repository', warn: false }]);
    expect(linkLines({ source: src })).toEqual([]);
    expect(linkLines({})).toEqual([]);
  });
});
