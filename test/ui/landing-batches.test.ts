// Landing batches in the UI (issue #1073), pure: one line per configured repository saying where its batch runs stand,
// and the change a save sends — only what differs. A red batch (part 2): the bisect at work, the culprit, its revert
// and its fix issue, and the event lines of each step. A back-merge after merge conflicts (part 4). The canary of a stable candidate (part 5).
// A stuck landing pass, Restart batch, and their event lines (issue #1333).
import { describe, expect, it } from 'vitest';
import { canaryLine, canRestart, landingBatchLine, stuckLine, landingBatchPatch, redBatchDetail } from '../../ui/src/model/landing-batches.ts';
import type { LandingBatchRepoView } from '../../ui/src/model/wire.ts';

const row = (r: Partial<LandingBatchRepoView>): LandingBatchRepoView => ({ repo: 'owner/a', config: { tested: 'dev', everyMerges: 5, everyMinutes: 60 }, state: { repo: 'owner/a' }, ...r });

describe('landing batches model', () => {
  it('line: a problem first, then a batch run at work, then why no run started, with how the last one ended', () => {
    expect(landingBatchLine(row({ problem: 'no GitHub connection' }))).toBe('Cannot run: no GitHub connection');
    expect(landingBatchLine(row({ state: { repo: 'owner/a', running: { tip: '0123456789abcdef', branch: 'b', pullRequest: 9, url: 'u', startedAt: 's', merges: [1, 2] } } })))
      .toBe('Batch run #9 tests 0123456789ab (2 pull requests).');
    expect(landingBatchLine(row({ why: 'nothing new on the landing branch beyond dev', state: { repo: 'owner/a', last: { outcome: 'failed', tip: '0123456789abcdef', at: 'a', pullRequest: 9, url: 'u', reason: 'checks failed: test' } } })))
      .toBe('Waiting: nothing new on the landing branch beyond dev. Last batch run #9 failed: checks failed: test.');
    expect(landingBatchLine(row({ state: { repo: 'owner/a', last: { outcome: 'promoted', tip: '0123456789abcdef', at: 'a', pullRequest: 8, url: 'u' } } })))
      .toBe('Waiting for the next pass. Last batch run #8 moved dev to 0123456789ab.');
  });

  it('patch: only what changed; a removed repository is null; a new one names its tested branch', () => {
    const settings = { repos: { 'owner/a': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } };
    expect(landingBatchPatch(settings, settings)).toBeUndefined();
    expect(landingBatchPatch(settings, { repos: { 'owner/a': { tested: 'dev', everyMerges: 3, everyMinutes: 60 } } })).toEqual({ repos: { 'owner/a': { everyMerges: 3 } } });
    expect(landingBatchPatch(settings, { repos: { 'owner/b': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } }))
      .toEqual({ repos: { 'owner/a': null, 'owner/b': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } });
    // The landing branch (issue #1142): `main` when a record saved before it has none, so only a real change is sent.
    expect(landingBatchPatch(settings, { repos: { 'owner/a': { ...settings.repos['owner/a']!, landing: 'main' } } })).toBeUndefined();
    expect(landingBatchPatch(settings, { repos: { 'owner/a': { ...settings.repos['owner/a']!, landing: 'trunk' } } })).toEqual({ repos: { 'owner/a': { landing: 'trunk' } } });
  });

  it('line: a bisect at work, then the culprit with its revert and fix issue', () => {
    const bisect = { tip: '0123456789abcdef', tested: 'dev', points: [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }, { sha: 'd' }], good: 0, bad: 3, checks: {}, reason: 'checks failed: test', startedAt: 's', results: [] };
    expect(landingBatchLine(row({ state: { repo: 'owner/a', bisect } }))).toBe('Bisecting the batch at 0123456789ab: 2 changes left to test.');
    expect(landingBatchLine(row({ state: { repo: 'owner/a', bisect: { ...bisect, running: { index: 1, sha: 'fedcba9876543210', branch: 'b', pullRequest: 12, url: 'u', startedAt: 's' } } } })))
      .toBe('Bisecting the batch at 0123456789ab: bisect run #12 tests fedcba987654.');
    const culprit = { tip: '0123456789abcdef', sha: 'fedcba9876543210', pullRequest: 7, checks: [], reason: 'r', at: 'a', results: [] };
    expect(landingBatchLine(row({ why: 'w', state: { repo: 'owner/a', culprit: { ...culprit, revert: { pullRequest: 13, url: 'u', state: 'open' }, fix: { issue: 14, url: 'u' } } } })))
      .toBe('Waiting: w. Culprit #7: revert #13 open, fix issue #14.');
    expect(landingBatchLine(row({ why: 'w', state: { repo: 'owner/a', culprit: { ...culprit, revertProblem: 'closed', revert: { pullRequest: 13, url: 'u', state: 'open' } } } })))
      .toBe('Waiting: w. Culprit #7: not reverted (closed), no fix issue yet.');
  });

  it('event lines: each step of a red batch', () => {
    expect(redBatchDetail('landing_batch.bisect_started', { repo: 'owner/a', tip: '0123456789abcdef', points: [{}, {}, {}] })).toBe('owner/a: bisecting the batch at 0123456789ab (3 changes)');
    expect(redBatchDetail('landing_batch.bisect_run', { repo: 'owner/a', sha: 'fedcba9876543210', pullRequest: 12 })).toBe('owner/a: bisect run #12 tests fedcba987654');
    expect(redBatchDetail('landing_batch.bisect_tested', { repo: 'owner/a', sha: 'fedcba9876543210', outcome: 'bad' })).toBe('owner/a: fedcba987654 failed');
    expect(redBatchDetail('landing_batch.bisect_tested', { repo: 'owner/a', sha: 'fedcba9876543210', outcome: 'unknown', reason: 'no check' })).toBe('owner/a: the bisect ended: no check');
    expect(redBatchDetail('landing_batch.culprit', { repo: 'owner/a', sha: 'fedcba9876543210', pullRequest: 7 })).toBe('owner/a: culprit #7');
    expect(redBatchDetail('landing_batch.culprit', { repo: 'owner/a', sha: 'fedcba9876543210' })).toBe('owner/a: culprit fedcba987654');
    expect(redBatchDetail('landing_batch.revert_opened', { repo: 'owner/a', culpritPullRequest: 7, pullRequest: 13 })).toBe('owner/a: revert #13 of #7 opened');
    expect(redBatchDetail('landing_batch.reverted', { repo: 'owner/a', pullRequest: 13 })).toBe('owner/a: revert #13 merged');
    expect(redBatchDetail('landing_batch.revert_failed', { repo: 'owner/a', reason: 'a direct commit' })).toBe('owner/a: not reverted: a direct commit');
    expect(redBatchDetail('landing_batch.fix_filed', { repo: 'owner/a', issue: 14 })).toBe('owner/a: fix issue #14 filed');
  });

  it('line and event lines: a back-merge after merge conflicts (part 4)', () => {
    const open = { tip: '0123456789abcdef', state: 'open' as const, pullRequest: 15, url: 'u', at: 'a' };
    expect(landingBatchLine(row({ why: 'w', state: { repo: 'owner/a', backMerge: open } }))).toBe('Waiting: w. Merging dev into the landing branch: #15.');
    const failed = { tip: '0123456789abcdef', state: 'failed' as const, conflict: true, reason: 'r', at: 'a' };
    expect(landingBatchLine(row({ why: 'w', state: { repo: 'owner/a', backMerge: failed } }))).toBe('Waiting: w. Merge conflicts with dev: no issue yet.');
    expect(landingBatchLine(row({ why: 'w', state: { repo: 'owner/a', backMerge: failed, backMergeIssue: { tip: 't', issue: 16, url: 'u' } } }))).toBe('Waiting: w. Merge conflicts with dev: issue #16.');
    expect(redBatchDetail('landing_batch.back_merge_opened', { repo: 'owner/a', tested: 'dev', landing: 'main', pullRequest: 15 })).toBe('owner/a: merging dev into main: #15');
    expect(redBatchDetail('landing_batch.back_merged', { repo: 'owner/a', pullRequest: 15 })).toBe('owner/a: back-merge #15 merged');
    expect(redBatchDetail('landing_batch.back_merge_failed', { repo: 'owner/a', reason: 'nothing to merge' })).toBe('owner/a: no back-merge: nothing to merge');
    expect(redBatchDetail('landing_batch.back_merge_issue_filed', { repo: 'owner/a', issue: 16 })).toBe('owner/a: issue #16 filed for the merge conflicts');
  });

  it('the canary (part 5): its line, its event lines, and its window in the patch', () => {
    const tip = '0123456789abcdef';
    expect(canaryLine(row({}))).toBeUndefined();
    const config = { tested: 'dev', everyMerges: 5, everyMinutes: 60, canaryHours: 24 };
    expect(canaryLine(row({ config, canary: { problem: 'no canary branch', checkedAt: 'c' } }))).toBe('Canary: cannot run: no canary branch');
    expect(canaryLine(row({ config, canary: { why: 'nothing new on canary beyond stable', checkedAt: 'c' } }))).toBe('Canary: nothing new on canary beyond stable.');
    expect(canaryLine(row({ config, canary: { why: 'w', checkedAt: 'c' }, state: { repo: 'owner/a', canary: { tip, state: 'held', startedAt: 's', reports: [41], reason: 'bug reports name it: #41', issue: { issue: 50, url: 'u' }, at: 'a' } } })))
      .toBe('Canary: w. Candidate 0123456789ab held: bug reports name it: #41, issue #50.');
    expect(canaryLine(row({ config, canary: { why: 'w', checkedAt: 'c' }, state: { repo: 'owner/a', canary: { tip, state: 'promoted', startedAt: 's', reports: [], at: 'a' } } })))
      .toBe('Canary: w. Candidate 0123456789ab went to stable.');
    expect(redBatchDetail('landing_batch.canary_started', { repo: 'owner/a', tip, hours: 24 })).toBe('owner/a: canary candidate 0123456789ab, 24 hours');
    expect(redBatchDetail('landing_batch.canary_held', { repo: 'owner/a', tip, reason: 'bug reports name it: #41' })).toBe('owner/a: canary 0123456789ab held: bug reports name it: #41');
    expect(redBatchDetail('landing_batch.canary_issue_filed', { repo: 'owner/a', issue: 50 })).toBe('owner/a: issue #50 filed for the held canary');
    expect(redBatchDetail('landing_batch.canary_promoted', { repo: 'owner/a', tip })).toBe('owner/a: stable moved to 0123456789ab');
    const settings = { repos: { 'owner/a': { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } };
    expect(landingBatchPatch(settings, { repos: { 'owner/a': config } })).toEqual({ repos: { 'owner/a': { canaryHours: 24 } } });
    expect(landingBatchPatch({ repos: { 'owner/a': config } }, settings)).toEqual({ repos: { 'owner/a': { canaryHours: null } } });
  });

  it('a stuck landing pass (issue #1333): its line, Restart batch, and the event lines', () => {
    const stuck = { error: 'the start of a batch run: GitHub answered 422', since: '2026-10-15T13:44:00.000Z', passes: 3 };
    expect(stuckLine(row({ stuck }))).toBe('The landing pass is stuck: it failed the same way on 3 passes in a row since 2026-10-15 13:44Z: the start of a batch run: GitHub answered 422');
    expect(stuckLine(row({}))).toBeUndefined();
    expect(canRestart(row({ stuck }))).toBe(true);
    expect(canRestart(row({ state: { repo: 'owner/a', running: { tip: 't', branch: 'b', pullRequest: 9, url: 'u', startedAt: 's', merges: [] } } }))).toBe(true);
    expect(canRestart(row({}))).toBe(false);
    expect(redBatchDetail('landing_batch.stuck', { repo: 'owner/a', error: 'GitHub answered 422' })).toBe('owner/a: the landing pass is stuck: GitHub answered 422');
    expect(redBatchDetail('landing_batch.restarted', { repo: 'owner/a' })).toBe('owner/a: the landing batch was restarted');
  });
});
