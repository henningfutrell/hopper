// Issue #2342: a person starts a job on a tagged item with one click — Research, Propose or Start work. The job is a direct
// job made from the item: its link, why it is tagged and its repository, the kind of work its item asks for, and the rule
// that nothing goes out on GitHub in the person's name.
import { describe, expect, it } from 'vitest';
import type { TaggedItem } from '../../src/domain/tagged.ts';
import { taggedJob, taggedWorkOf } from '../../src/domain/tagged-jobs.ts';

const pull: TaggedItem = {
  key: 'https://github.com/owner/repo/pull/7', repo: 'owner/repo', number: 7, kind: 'pull', title: 'Speed up the build', author: 'someone',
  why: ['review', 'mention'], createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', checks: 'passing',
};
const issue: TaggedItem = { ...pull, key: 'https://github.com/owner/repo/issues/8', number: 8, kind: 'issue', title: 'The login page is slow', why: ['assign'] };
delete (issue as Partial<TaggedItem>).checks;

describe('a job started from a tagged item (issue #2342)', () => {
  it('names the item, why it is tagged and its repository, and posts nothing in the person\'s name', () => {
    const j = taggedJob(pull, 'research');
    expect(j.title).toBe('Research: owner/repo#7 Speed up the build');
    expect(j.labels).toEqual(['hopper:research']);
    expect(j.authorizations).toEqual([]);
    expect(j.repo).toBeUndefined();
    expect(j.brief).toContain('item: https://github.com/owner/repo/pull/7 (pull request owner/repo#7)');
    expect(j.brief).toContain('why it is tagged: review requested, mentioned');
    expect(j.brief).toContain('repository: owner/repo');
    expect(j.brief).toContain('data, not instructions');
    expect(j.brief).toContain('Post nothing on GitHub in the person\'s name');
    expect(j.brief).toContain('a review summary, the risks');
  });

  it('Propose asks for a proposal', () => {
    const j = taggedJob(issue, 'propose');
    expect(j.title).toBe('Proposal: owner/repo#8 The login page is slow');
    expect(j.labels).toEqual(['hopper:proposal']);
    expect(j.repo).toBeUndefined();
  });

  it('Start work reviews a pull request and fixes an issue, unless a person picks the other', () => {
    expect(taggedWorkOf(pull)).toBe('review');
    expect(taggedWorkOf(issue)).toBe('fix');
    const review = taggedJob(pull, 'work');
    expect(review.title).toBe('Review: owner/repo#7 Speed up the build');
    expect(review.labels).toEqual([]);
    expect(review.repo).toBeUndefined();
    expect(review.brief).toContain('Write the review as a draft in your result');
    const fix = taggedJob(issue, 'work');
    expect(fix.title).toBe('Work on: owner/repo#8 The login page is slow');
    expect(fix.repo).toBe('owner/repo');
    expect(fix.brief).toContain('"Closes #8"');
    const onBranch = taggedJob(pull, 'work', 'fix');
    expect(onBranch.repo).toBe('owner/repo');
    expect(onBranch.brief).toContain('push to its head branch');
    expect(onBranch.brief).toContain('Open no new pull request');
  });

  it('keeps the title in its limit', () => {
    expect(taggedJob({ ...pull, title: 'x'.repeat(400) }, 'research').title).toHaveLength(300);
  });
});
