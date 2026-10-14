// Issue #1073 part 1: the batch runner. Each pass, for each repository with landing batches: open job pull requests on the
// tested branch move to the landing branch; a batch run at work is read, and promoted on green with one merge, or
// recorded failed on red; with none at work, one starts when due. Fake GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner
//   Scenario: a due batch starts a batch run: a branch at the tip, a pull request into the tested branch, one event
//   Scenario: nothing new: no branch, no pull request, no event
//   Scenario: a green batch run is merged into the tested branch at its tip, and its branch removed
//   Scenario: a red batch run is closed and recorded failed; the same tip does not run again
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
    defaultBranch: 'integration', aheadBy: 3, tip: TIP,
    messages: ['Merge pull request #12 from owner/issue-1-a', 'Merge pull request #14 from owner/issue-2-b'],
    pulls: new Map(), checks: [], calls: [],
  };
}

function fake(w: World): LandingBatchGitHub {
  let next = 100;
  return {
    defaultBranch: async () => w.defaultBranch,
    compare: async (_repo, base, head) => { w.calls.push(`compare ${base}...${head}`); return { aheadBy: w.aheadBy, tip: w.tip, messages: w.messages }; },
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
      return { state: p.state, merged: p.merged, mergeable: p.mergeable, headSha: p.headSha, base: p.base, url: p.url };
    },
    checkRuns: async () => w.checks,
    merge: async (_repo, n, sha) => { const p = w.pulls.get(n)!; p.merged = true; p.state = 'closed'; w.calls.push(`merge #${n} ${sha}`); return { sha: 'merge-sha' }; },
    close: async (_repo, n) => { w.pulls.get(n)!.state = 'closed'; w.calls.push(`close #${n}`); },
    retarget: async (_repo, n, base) => { w.pulls.get(n)!.base = base; w.calls.push(`retarget #${n} ${base}`); },
  };
}

function runner(w: World, o: { jobPullRequests?: string[]; now?: Date } = {}) {
  const events: DomainEvent[] = [];
  let seq = 0;
  const r = createLandingBatches({
    github: () => fake(w),
    settings: () => SETTINGS,
    events: () => events,
    record: (e: NewEvent) => { events.push({ ...e, seq: ++seq, id: `e${seq}`, at: (o.now ?? new Date()).toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => o.jobPullRequests ?? [],
    openPullRequests: async () => [...w.pulls.entries()].filter(([, p]) => p.state === 'open').map(([number, p]) => ({ number, base: p.base, url: p.url })),
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
    expect(w.calls).toEqual(['compare dev...integration', `branch hopper-batch/abcdef012345 ${TIP}`, 'open hopper-batch/abcdef012345 -> dev']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started']);
    expect(events[0]!.data).toMatchObject({ repo: REPO, landing: 'integration', tested: 'dev', tip: TIP, branch: 'hopper-batch/abcdef012345', pullRequest: 100, merges: [12, 14] });
    expect(r.view().repos[0]).toMatchObject({ repo: REPO, state: { running: { pullRequest: 100 } } });
  });

  it('nothing new: no branch, no pull request, no event', async () => {
    const w = world();
    w.aheadBy = 0;
    const { r, events } = runner(w);
    await r.pass();
    expect(w.calls).toEqual(['compare dev...integration']);
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

  it('red: closes the batch run, records it failed, and does not run the same tip again', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
    await r.pass();
    expect(w.calls.slice(-2)).toEqual(['close #100', 'delete hopper-batch/abcdef012345']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.failed']);
    expect(events[1]!.data).toMatchObject({ tip: TIP, reason: 'checks failed: test', checks: ['test'] });
    await r.pass();
    expect(events).toHaveLength(2);
    expect(r.view().repos[0]!.why).toBe(`the landing branch tip ${TIP.slice(0, 12)} was tested already`);
  });

  it('moves a job\'s open pull request on dev to the landing branch; leaves another\'s', async () => {
    const w = world();
    w.aheadBy = 0;
    w.pulls.set(7, { head: 'issue-7', base: 'dev', state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/7`, headSha: 'x' });
    w.pulls.set(8, { head: 'someone', base: 'dev', state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/8`, headSha: 'y' });
    const { r, events } = runner(w, { jobPullRequests: [`https://github.test/${REPO}/pull/7`] });
    await r.pass();
    expect(w.pulls.get(7)!.base).toBe('integration');
    expect(w.pulls.get(8)!.base).toBe('dev');
    expect(events.map((e) => [e.type, e.data])).toEqual([['landing_batch.retargeted', { repo: REPO, pullRequest: 7, url: `https://github.test/${REPO}/pull/7`, from: 'dev', to: 'integration' }]]);
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
