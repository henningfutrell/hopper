// Issue #1073 part 1: landing batches. A job's pull request merges into the landing branch (the repository's default
// branch, `main` for the hopper's own) after the fast checks only. The full suite runs on the landing branch's
// tip, as a batch run, after N merges or on a timer, and a green batch moves the tested branch (`dev`) in one merge.
// Nothing new, no run. Pure.
//
// Feature: landing batches — when a batch run starts, and what its checks say
//   Scenario: settings: a repository is added with defaults, changed in part, and removed with null
//   Scenario: nothing new on the landing branch beyond the tested branch: no run, whatever the timer says
//   Scenario: a tip already tested (a red batch, no new merge since): no run
//   Scenario: N merges since the last batch run start a run; fewer wait for the timer
//   Scenario: the timer starts a run of what is new; a first run starts at once
//   Scenario: a batch run at work holds the next one
//   Scenario: the batch run's checks: pending, green, red, no check in time, merge conflicts
//   Scenario: the state of each repository is reduced from its events
//   Scenario: the pull requests a landing branch merged are read from its merge commits
import { describe, expect, it } from 'vitest';
import {
  batchBody, batchBranch, batchChecks, batchDue, BATCH_NO_CHECKS_MINUTES, DEFAULT_LANDING_BATCHES, landingBatchStates, mergedPullRequests, patchLandingBatches,
  type LandingBatchRepo,
} from '../../src/domain/landing-batches.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

const REPO = 'owner/app';
const CFG: LandingBatchRepo = { tested: 'dev', everyMerges: 3, everyMinutes: 60 };
const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = ago(0)): DomainEvent =>
  ({ seq: ++seq, id: `e${seq}`, type, at, data, v: 1 }) as unknown as DomainEvent;

describe('the landing batch settings (issue #1073)', () => {
  it('adds a repository with the defaults, changes one part, and removes it with null', () => {
    const added = patchLandingBatches(DEFAULT_LANDING_BATCHES, { repos: { 'Owner/App': { tested: 'dev' } } });
    expect(added).toEqual({ repos: { [REPO]: { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } });
    const changed = patchLandingBatches(added, { repos: { [REPO]: { everyMerges: 2 } } });
    expect(changed.repos[REPO]).toEqual({ tested: 'dev', everyMerges: 2, everyMinutes: 60 });
    expect(patchLandingBatches(changed, { repos: { [REPO]: null } })).toEqual({ repos: {} });
  });
});

describe('when a batch run starts (issue #1073)', () => {
  it('nothing new beyond the tested branch: no run, even when the timer is long past', () => {
    expect(batchDue(undefined, { tip: 'a1', aheadBy: 0, merges: 0 }, CFG, NOW)).toEqual({ due: false, why: 'nothing new on the landing branch beyond dev' });
  });

  it('a tip already tested: no run until a new merge', () => {
    const state = { repo: REPO, lastTestedTip: 'a1', lastStartedAt: ago(600) };
    expect(batchDue(state, { tip: 'a1', aheadBy: 4, merges: 9 }, CFG, NOW)).toEqual({ due: false, why: 'the landing branch tip a1 was tested already' });
  });

  it('N merges since the last run start a run; fewer wait for the timer', () => {
    const state = { repo: REPO, lastTestedTip: 'a0', lastStartedAt: ago(10) };
    expect(batchDue(state, { tip: 'a2', aheadBy: 6, merges: 3 }, CFG, NOW)).toEqual({ due: true, why: '3 merges since the last batch run' });
    expect(batchDue(state, { tip: 'a2', aheadBy: 4, merges: 2 }, CFG, NOW)).toEqual({ due: false, why: '2 of 3 merges, or 50 more minutes' });
  });

  it('the timer starts a run of what is new; with no run before, one starts at once', () => {
    const state = { repo: REPO, lastTestedTip: 'a0', lastStartedAt: ago(61) };
    expect(batchDue(state, { tip: 'a2', aheadBy: 1, merges: 1 }, CFG, NOW)).toEqual({ due: true, why: '61 minutes since the last batch run' });
    expect(batchDue(undefined, { tip: 'a2', aheadBy: 1, merges: 0 }, CFG, NOW)).toEqual({ due: true, why: 'no batch run before' });
  });

  it('a batch run at work holds the next one', () => {
    const state = { repo: REPO, lastStartedAt: ago(5), running: { tip: 'a1', branch: 'hopper-batch/a1', pullRequest: 9, url: 'u', startedAt: ago(5), merges: [] } };
    expect(batchDue(state, { tip: 'a2', aheadBy: 9, merges: 9 }, CFG, NOW)).toEqual({ due: false, why: 'batch run #9 is at work' });
  });
});

describe('what a batch run\'s checks say (issue #1073)', () => {
  const started = ago(5);
  it('pending while a check runs; green once all passed; red when one failed', () => {
    expect(batchChecks([{ name: 'test', status: 'in_progress' }], { mergeable: true }, started, NOW)).toEqual({ kind: 'pending' });
    expect(batchChecks([{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }], { mergeable: true }, started, NOW)).toEqual({ kind: 'green' });
    expect(batchChecks([{ name: 'test', status: 'completed', conclusion: 'failure', id: 7 }, { name: 'shard (3)', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress' }], { mergeable: true }, started, NOW))
      .toEqual({ kind: 'red', reason: 'checks failed: test, shard (3)', checks: [{ name: 'test', id: 7 }, { name: 'shard (3)' }] });
  });

  it('no check in time is red; so are merge conflicts with the tested branch', () => {
    expect(batchChecks([], { mergeable: true }, started, NOW)).toEqual({ kind: 'pending' });
    expect(batchChecks([], { mergeable: true }, ago(BATCH_NO_CHECKS_MINUTES), NOW)).toEqual({ kind: 'red', reason: `no check ran in ${BATCH_NO_CHECKS_MINUTES} minutes`, checks: [] });
    expect(batchChecks([{ name: 'test', status: 'completed', conclusion: 'success' }], { mergeable: false }, started, NOW)).toEqual({ kind: 'red', reason: 'the batch has merge conflicts with the tested branch', checks: [] });
  });
});

describe('the state of a repository, from its events (issue #1073)', () => {
  it('a run started, then promoted; a later run failed; each tip tested is kept', () => {
    const states = landingBatchStates([
      ev('landing_batch.started', { repo: 'Owner/App', landing: 'main', tested: 'dev', tip: 'a1', branch: 'hopper-batch/a1', pullRequest: 9, url: 'u9', merges: [3, 4] }, ago(50)),
      ev('landing_batch.promoted', { repo: REPO, tested: 'dev', tip: 'a1', pullRequest: 9, url: 'u9', merge: 'm1' }, ago(40)),
      ev('landing_batch.started', { repo: REPO, landing: 'main', tested: 'dev', tip: 'a2', branch: 'hopper-batch/a2', pullRequest: 10, url: 'u10', merges: [5] }, ago(30)),
    ]);
    expect(states[REPO]).toMatchObject({ lastTestedTip: 'a1', lastPromotedTip: 'a1', lastStartedAt: ago(30), running: { tip: 'a2', pullRequest: 10, merges: [5] } });
    const after = landingBatchStates([
      ev('landing_batch.started', { repo: REPO, landing: 'main', tested: 'dev', tip: 'a2', branch: 'hopper-batch/a2', pullRequest: 10, url: 'u10', merges: [5] }, ago(30)),
      ev('landing_batch.failed', { repo: REPO, tested: 'dev', tip: 'a2', pullRequest: 10, url: 'u10', reason: 'checks failed: test', checks: ['test'] }, ago(20)),
    ]);
    expect(after[REPO]!.running).toBeUndefined();
    expect(after[REPO]).toMatchObject({ lastTestedTip: 'a2', last: { outcome: 'failed', tip: 'a2', reason: 'checks failed: test', at: ago(20) } });
  });
});

describe('the batch run\'s branch, pull requests and text (issue #1073)', () => {
  it('reads the merged pull requests from their merge commits, oldest first, once each', () => {
    expect(mergedPullRequests([
      'Merge pull request #12 from owner/issue-1-a\n\nAdd a',
      'Fix a typo',
      'Merge branch \'dev\' into issue-2-b',
      'Merge pull request #14 from owner/issue-2-b',
      'Merge pull request #12 from owner/issue-1-a',
    ])).toEqual([12, 14]);
  });

  it('names the branch by the tip, and writes a neutral body that lists the pull requests', () => {
    expect(batchBranch('0123456789abcdef0123')).toBe('hopper-batch/0123456789ab');
    const body = batchBody({ landing: 'main', tested: 'dev', tip: '0123456789abcdef', merges: [12, 14] });
    expect(body).toContain('#12');
    expect(body).toContain('#14');
    expect(body).toContain('main');
    expect(body).toContain('Do not merge it by hand');
  });
});
