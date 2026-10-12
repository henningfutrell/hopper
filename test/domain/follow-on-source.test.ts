// Issue #859: the source item a job works on, and whether a proposal's job handed its item to follow-ons. Pure.
import { describe, expect, it } from 'vitest';
import type { FollowOnOf, Job } from '../../src/domain/types.ts';
import { following, handedToFollowOns, reconcilable, sourceItemOf } from '../../src/domain/types.ts';

const item = { source: 'github', kind: 'github-issue', key: 'https://github.com/octo/tools/issues/7', repo: 'octo/tools' };
const link: FollowOnOf = { jobId: 'p', proposalId: 'x', pathId: '1', title: 'Brush', text: 'Brush', siblings: [] };
const handed = { proposal: { id: 'x', version: 1, decision: 'accept', followOns: [{ path: '1', jobId: 'f' }] } };
const ended = (over: Partial<Job>): Job => ({ id: 'p', spec: { executor: 'test', payload: {} }, priority: 50, status: 'finished', approved: false, createdAt: '', updatedAt: '', attempts: 0, ...over }) as Job;

describe('the source item a job works on (issue #859)', () => {
  it('its own; else a fork\'s parent\'s; else the parent\'s that a follow-on queued before issue #859 kept on its link', () => {
    expect(sourceItemOf({ source: item, followOn: { ...link, source: { ...item, repo: 'octo/site' } } })?.repo).toBe('octo/tools');
    expect(sourceItemOf({ forkOf: { source: item } })).toEqual(item);
    expect(sourceItemOf({ followOn: { ...link, source: item } })).toEqual(item);
    expect(sourceItemOf({ followOn: link })).toBeUndefined();
  });

  it('a proposal\'s job whose follow-ons go on with its work follows no pull request, and is never reconciled with one', () => {
    expect(handedToFollowOns({ result: handed })).toBe(true);
    expect(handedToFollowOns({ result: { proposal: { id: 'x', version: 1, decision: 'reject' } } })).toBe(false);
    expect(handedToFollowOns({ result: 'done' })).toBe(false);
    expect(following(ended({ result: handed, sourceState: { source: { follow: 'open' } } }))).toBe(false);
    expect(following(ended({ sourceState: { source: { follow: 'open' } } }))).toBe(true);
    expect(reconcilable(ended({ result: handed }))).toBe(false);
    expect(reconcilable(ended({}))).toBe(true);
  });
});
