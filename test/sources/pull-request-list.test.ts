// The Pull requests list's card states (issue #677): why a pull request waits, in the order that holds first, and a
// pull request with no checks in a yolo repository — waiting for checks to start in the grace window, then ready.
import { describe, expect, it } from 'vitest';
import { NO_CHECKS_GRACE_MS, pullRequestList, type Job, type PullRequestSeen } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from './fixtures/github-support.ts';

const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const PR = `https://github.com/${REPO}/pull/7`;

function waits(seen: PullRequestSeen | undefined, o: { yolo?: boolean; pullRequest?: string | null } = {}) {
  const pullRequest = o.pullRequest === null ? {} : { pullRequest: o.pullRequest ?? PR };
  const job: Job = jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open', ...pullRequest, ...(seen ? { seen } : {}) } } });
  const v = pullRequestList([job], () => job, { on: o.yolo ?? true, repos: {} }, [REPO], NOW);
  return v.repos[0]!.pullRequests[0]!;
}

const seen = (over: Partial<PullRequestSeen> = {}): PullRequestSeen => ({ draft: false, conflicting: false, checks: 'passing', base: 'dev', ...over });
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('why a pull request waits (issue #677)', () => {
  it('no pull request found yet: says so, not "not checked yet"', () => {
    expect(waits(undefined, { pullRequest: null }).waits).toBe('no pull request');
  });

  it('a named pull request not seen yet: not checked yet', () => {
    expect(waits(undefined).waits).toBe('not checked yet');
  });

  it('merge conflicts: the card carries the base branch', () => {
    expect(waits(seen({ conflicting: true }))).toMatchObject({ waits: 'conflicts', base: 'dev' });
  });

  it('yolo on, checks passed, no refusal: ready, merging', () => {
    expect(waits(seen()).waits).toBe('ready');
  });

  it('yolo on, checks running: checks pending', () => {
    expect(waits(seen({ checks: 'pending' })).waits).toBe('checks pending');
  });

  it('yolo on, no checks, pushed inside the grace window: checks not started', () => {
    expect(waits(seen({ checks: 'none', pushedAt: ago(NO_CHECKS_GRACE_MS - 1000) })).waits).toBe('checks not started');
  });

  it('yolo on, no checks after the grace window: ready, merging', () => {
    expect(waits(seen({ checks: 'none', pushedAt: ago(NO_CHECKS_GRACE_MS + 1000) })).waits).toBe('ready');
    expect(waits(seen({ checks: 'none' })).waits).toBe('ready');
  });

  it('a refused merge says so', () => {
    expect(waits(seen({ checks: 'none', mergeError: 'Required status check "test" is expected' })).waits).toBe('merge refused');
  });

  it('yolo off: it waits for a person', () => {
    expect(waits(seen({ checks: 'none' }), { yolo: false }).waits).toBe('yolo off');
  });
});
