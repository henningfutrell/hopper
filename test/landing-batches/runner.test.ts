// Issue #1073 part 1: the batch runner. Each pass, for each repository with landing batches: open job pull requests on the
// tested branch move to the landing branch; a batch run at work is read, and promoted on green with one merge, or
// recorded failed on red; with none at work, one starts when due. Fake GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner
//   Scenario: a due batch starts a batch run: a branch at the tip, a pull request into the tested branch, one event
//   Scenario: nothing new: no branch, no pull request, no event
//   Scenario: a green batch run is merged into the tested branch at its tip, and its branch removed
//   Scenario: a merge that waits for its batch run is recorded pending once
//   Scenario: a red batch run is closed and recorded failed; failing checks start a bisect; with none, the same tip does not run again
//   Scenario: a job's open pull request on the tested branch moves to the landing branch; another's does not
//   Scenario: a repository whose default branch is the tested branch runs nothing and says why
import { describe, expect, it } from 'vitest';
import type { LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';

const REPO = 'owner/app';
const SETTINGS: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60 } } };
const TIP = 'abcdef0123456789abcdef0123456789abcdef01';

interface World {
  defaultBranch: string;
  aheadBy: number;
  tip: string;
  messages: string[];
  pulls: Map<number, { head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; url: string; headSha: string }>;
  checks: { name: string; status: string; conclusion?: string }[];
  calls: string[];
}

function world(): World {
  return {
    defaultBranch: 'main', aheadBy: 3, tip: TIP,
    messages: ['Merge pull request #12 from owner/issue-1-a', 'Merge pull request #14 from owner/issue-2-b'],
    pulls: new Map(), checks: [], calls: [],
  };
}

function fake(w: World): LandingBatchGitHub {
  let next = 100;
  return {
    defaultBranch: async () => w.defaultBranch,
    compare: async (_repo, base, head) => {
      w.calls.push(`compare ${base}...${head}`);
      return { aheadBy: w.aheadBy, tip: w.tip, commits: w.messages.map((message, i) => ({ sha: i === w.messages.length - 1 ? w.tip : `c${i}`, parents: i === 0 ? ['base'] : [`c${i - 1}`], message })) };
    },
    createBranch: async (_repo, name, sha) => { w.calls.push(`branch ${name} ${sha}`); },
    deleteBranch: async (_repo, name) => { w.calls.push(`delete ${name}`); },
    openPullRequest: async (_repo, p) => {
      const n = next++;
      w.pulls.set(n, { head: p.head, base: p.base, state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/${n}`, headSha: w.tip });
      w.calls.push(`open ${p.head} -> ${p.base}`);
      return { number: n, url: `https://github.test/${REPO}/pull/${n}` };
    },
    pullRequest: async (_repo, n) => {
      const p = w.pulls.get(n)!;
      return { state: p.state, merged: p.merged, mergeable: p.mergeable, headSha: p.headSha, base: p.base, url: p.url, body: '' };
    },
    checkRuns: async () => w.checks,
    merge: async (_repo, n, sha) => { const p = w.pulls.get(n)!; p.merged = true; p.state = 'closed'; w.calls.push(`merge #${n} ${sha}`); return { sha: 'merge-sha' }; },
    close: async (_repo, n) => { w.pulls.get(n)!.state = 'closed'; w.calls.push(`close #${n}`); },
    mergeInto: async () => ({ kind: 'nothing' }),
    openPullRequests: async (_repo, base) => [...w.pulls.entries()].filter(([, p]) => p.state === 'open' && p.base === base).map(([number, p]) => ({ number, url: p.url })),
    retarget: async (_repo, n, base) => { w.pulls.get(n)!.base = base; w.calls.push(`retarget #${n} ${base}`); },
    pullRequestOf: async () => undefined,
    revert: async () => { throw new Error('no revert here'); },
    checkLog: async () => '',
    fileIssue: async () => { throw new Error('no issue here'); },
  };
}

function runner(w: World, o: { jobPullRequests?: string[]; now?: Date } = {}) {
  const events: DomainEvent[] = [];
  let seq = 0;
  const r = createLandingBatches({
    github: () => fake(w),
    login: () => 'me',
    settings: () => SETTINGS,
    events: () => events,
    record: (e: NewEvent) => { events.push({ ...e, seq: ++seq, id: `e${seq}`, at: (o.now ?? new Date()).toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => o.jobPullRequests ?? [],
    now: () => o.now ?? new Date(),
    log: () => {},
  });
  return { r, events };
}

describe('the batch runner (issue #1073)', () => {
  it('starts a batch run when due: a branch at the tip, a pull request into dev, one event', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    expect(w.calls).toEqual(['compare dev...main', `branch hopper-batch/abcdef012345 ${TIP}`, 'open hopper-batch/abcdef012345 -> dev']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started']);
    expect(events[0]!.data).toMatchObject({ repo: REPO, landing: 'main', tested: 'dev', tip: TIP, branch: 'hopper-batch/abcdef012345', pullRequest: 100, merges: [12, 14] });
    expect(r.view().repos[0]).toMatchObject({ repo: REPO, state: { running: { pullRequest: 100 } } });
  });

  it('nothing new: no branch, no pull request, no event', async () => {
    const w = world();
    w.aheadBy = 0;
    const { r, events } = runner(w);
    await r.pass();
    expect(w.calls).toEqual(['compare dev...main']);
    expect(events).toEqual([]);
    expect(r.view().repos[0]!.why).toBe('nothing new on the landing branch beyond dev');
  });

  it('green: merges the batch run into dev at its tip, removes its branch, records the promotion', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.checks = [{ name: 'test', status: 'in_progress' }];
    await r.pass();
    expect(events).toHaveLength(1);
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    await r.pass();
    expect(w.calls.slice(-2)).toEqual([`merge #100 ${TIP}`, 'delete hopper-batch/abcdef012345']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.promoted']);
    expect(events[1]!.data).toMatchObject({ repo: REPO, tested: 'dev', tip: TIP, pullRequest: 100, merge: 'merge-sha' });
  });

  it('a merge that waits for its batch run is recorded pending once, for the work-item ledger (part 3)', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    await r.pass();
    // One merge since: fewer than N, and the timer has not run out.
    const tip2 = '1111111111111111111111111111111111111111';
    Object.assign(w, { tip: tip2, aheadBy: 1, messages: ['Merge pull request #16 from owner/issue-3-c'] });
    await r.pass();
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.promoted', 'landing_batch.pending']);
    expect(events[2]!.data).toMatchObject({ repo: REPO, landing: 'main', tested: 'dev', tip: tip2, merges: [16] });
    expect(r.view().repos[0]!.state.pending).toEqual({ tip: tip2, merges: [16] });
  });

  it('red: closes the batch run, records it failed, and bisects within the batch (red.test.ts)', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
    await r.pass();
    expect(w.calls.slice(-3)).toEqual(['close #100', 'delete hopper-batch/abcdef012345', 'compare dev...abcdef0123456789abcdef0123456789abcdef01']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.failed', 'landing_batch.bisect_started']);
    expect(events[1]!.data).toMatchObject({ tip: TIP, reason: 'checks failed: test', checks: ['test'] });
  });

  it('red with merge conflicts: closed and recorded failed; the same tip does not run again', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.pulls.get(100)!.mergeable = false;
    await r.pass();
    // Nothing of dev to merge into the landing branch (part 4): the back-merge fails, and no issue is filed.
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_failed']);
    await r.pass();
    await r.pass();
    // Its pull requests wait for the next batch run again: recorded once (part 3).
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_failed', 'landing_batch.pending']);
    expect(r.view().repos[0]!.why).toBe(`the landing branch tip ${TIP.slice(0, 12)} was tested already`);
  });

  it('moves a job\'s open pull request on dev to the landing branch; leaves another\'s', async () => {
    const w = world();
    w.aheadBy = 0;
    w.pulls.set(7, { head: 'issue-7', base: 'dev', state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/7`, headSha: 'x' });
    w.pulls.set(8, { head: 'someone', base: 'dev', state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/8`, headSha: 'y' });
    const { r, events } = runner(w, { jobPullRequests: [`https://github.test/${REPO}/pull/7`] });
    await r.pass();
    expect(w.pulls.get(7)!.base).toBe('main');
    expect(w.pulls.get(8)!.base).toBe('dev');
    expect(events.map((e) => [e.type, e.data])).toEqual([['landing_batch.retargeted', { repo: REPO, pullRequest: 7, url: `https://github.test/${REPO}/pull/7`, from: 'dev', to: 'main' }]]);
  });

  it('runs nothing while the default branch is the tested branch, and says why', async () => {
    const w = world();
    w.defaultBranch = 'dev';
    const { r, events } = runner(w);
    await r.pass();
    expect(w.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(r.view().repos[0]!.problem).toBe('the default branch of owner/app is dev, its tested branch: make the landing branch its default branch');
  });
});
