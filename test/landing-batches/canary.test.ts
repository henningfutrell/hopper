// Issue #1073 part 5: the canary. With a canary window set for a repository, each pass compares `stable` with `canary`:
// a new candidate starts the window; a bug report that names it holds it and files one issue; the window passed with no
// report, `stable` moves to it (a fast-forward). Fake GitHub at the LandingBatchGitHub seam.
//
// Feature: the canary step
//   Scenario: a new candidate on canary starts the window, with the merge commits it carries, then waits while it runs
//   Scenario: the window passed with no bug report: stable moves to the candidate
//   Scenario: a bug report names the candidate: held, and one issue filed for Intake
//   Scenario: nothing new on canary: no event
//   Scenario: no canary window set: canary is not read
//   Scenario: beta moved ahead of canary: one event with its tip and the merge commits it carries; none again for the same tip
//   Scenario: no beta branch: the canary step goes on
import { describe, expect, it } from 'vitest';
import type { LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';

const REPO = 'owner/app';
const TIP = 'abcdef0123456789abcdef0123456789abcdef01';
// The candidate's commits beyond stable: one batch run's merge (two parents) and a plain commit.
const MERGE = '0123456789abcdef0123456789abcdef01234567';
const COMMITS = [{ sha: MERGE, parents: ['p1', 'p2'], message: 'Merge pull request #900' }, { sha: TIP, parents: [MERGE], message: 'a plain commit' }];
const START = new Date('2026-10-14T00:00:00.000Z');
const later = (h: number) => new Date(START.getTime() + h * 3_600_000);

interface Compared { aheadBy: number; tip: string; commits: { sha: string; parents: string[]; message: string }[] }
interface World { aheadBy: number; reports: number[]; calls: string[]; issues: { title: string; body: string; labels: string[]; assignees: string[] }[]; beta?: Compared }

function fake(w: World): LandingBatchGitHub {
  const no = async (): Promise<never> => { throw new Error('not in this test'); };
  return {
    compare: async (_repo, base, head) => {
      w.calls.push(`compare ${base}...${head}`);
      if (head === 'beta') { if (!w.beta) throw new Error('GitHub answered 404: no beta branch'); return w.beta; }
      return base === 'stable' ? { aheadBy: w.aheadBy, tip: TIP, commits: COMMITS } : { aheadBy: 0, tip: 'landing', commits: [] };
    },
    createBranch: no, deleteBranch: no, openPullRequest: no, pullRequest: no, checkRuns: no, merge: no, close: no, mergeInto: no,
    openPullRequests: async () => [], retarget: no, findIssue: async () => undefined, comment: no, pullRequestOf: no, revert: no, checkLog: no,
    fileIssue: async (_repo, issue) => { w.issues.push(issue); return { number: 90, url: `https://github.test/${REPO}/issues/90` }; },
    bugReports: async (_repo, sha, since) => { w.calls.push(`reports ${sha} ${since}`); return w.reports; },
    fastForward: async (_repo, branch, sha) => { w.calls.push(`fast-forward ${branch} ${sha}`); },
  };
}

function runner(w: World, settings: LandingBatchSettings) {
  const events: DomainEvent[] = [];
  let seq = 0;
  let now = START;
  const r = createLandingBatches({
    github: () => fake(w),
    login: () => 'me',
    settings: () => settings,
    events: () => events,
    record: (e: NewEvent) => { events.push({ ...e, seq: ++seq, id: `e${seq}`, at: now.toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => [],
    now: () => now,
    log: () => {},
  });
  return { r, events, at: (d: Date) => { now = d; } };
}

const withCanary: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 5, everyMinutes: 60, canaryHours: 24 } } };
const world = (): World => ({ aheadBy: 2, reports: [], calls: [], issues: [] });

describe('the canary step (issue #1073 part 5)', () => {
  it('a new candidate starts the window, then waits while it runs with no bug report', async () => {
    const w = world();
    const { r, events, at } = runner(w, withCanary);
    await r.pass();
    expect(events.map((e) => [e.type, e.data])).toEqual([['landing_batch.canary_started', { repo: REPO, canary: 'canary', stable: 'stable', tip: TIP, hours: 24, mergeCommits: [MERGE] }]]);
    at(later(20));
    await r.pass();
    expect(w.calls).toContain(`reports abcdef012345 ${START.toISOString()}`);
    expect(events).toHaveLength(1);
    expect(r.view().repos[0]!.canary).toMatchObject({ why: 'the canary abcdef012345 runs 4 more hours with no bug report' });
  });

  it('the window passed with no bug report: stable moves to the candidate', async () => {
    const w = world();
    const { r, events, at } = runner(w, withCanary);
    await r.pass();
    at(later(24));
    await r.pass();
    expect(w.calls).toContain(`fast-forward stable ${TIP}`);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.canary_started', 'landing_batch.canary_promoted']);
    expect(events[1]!.data).toEqual({ repo: REPO, canary: 'canary', stable: 'stable', tip: TIP, why: 'no bug report named it in 24 hours' });
    expect(r.view().repos[0]!.state.canary).toMatchObject({ tip: TIP, state: 'promoted' });
  });

  it('a bug report names the candidate: held, and one issue filed for Intake', async () => {
    const w = world();
    const { r, events, at } = runner(w, withCanary);
    await r.pass();
    w.reports = [41];
    at(later(2));
    await r.pass();
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.canary_started', 'landing_batch.canary_held', 'landing_batch.canary_issue_filed']);
    expect(events[1]!.data).toMatchObject({ repo: REPO, tip: TIP, reports: [41], reason: 'bug reports name it: #41' });
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0]).toMatchObject({ labels: ['hopper'], assignees: ['me'], title: 'The canary abcdef012345 is held: bug reports name it' });
    expect(w.calls.filter((c) => c.startsWith('fast-forward'))).toEqual([]);
  });

  it('nothing new on canary: no event', async () => {
    const w = world();
    w.aheadBy = 0;
    const { r, events } = runner(w, withCanary);
    await r.pass();
    expect(events).toEqual([]);
    expect(r.view().repos[0]!.canary).toMatchObject({ why: 'nothing new on canary beyond stable' });
  });

  it('beta moved ahead of canary: one event with its tip and the merge commits it carries; none again for the same tip', async () => {
    const w = world();
    const BETA = 'beta0123456789abcdef0123456789abcdef0123';
    w.beta = { aheadBy: 2, tip: BETA, commits: COMMITS };
    const { r, events } = runner(w, withCanary);
    await r.pass();
    expect(w.calls).toContain('compare canary...beta');
    const moved = () => events.filter((e) => e.type === 'landing_batch.beta_moved');
    expect(moved().map((e) => e.data)).toEqual([{ repo: REPO, beta: 'beta', canary: 'canary', tip: BETA, mergeCommits: [MERGE] }]);
    await r.pass();
    expect(moved()).toHaveLength(1);
    w.beta = { aheadBy: 3, tip: TIP, commits: COMMITS };
    await r.pass();
    expect(moved().map((e) => e.data.tip)).toEqual([BETA, TIP]);
    expect(r.view().repos[0]!.state.beta).toMatchObject({ tip: TIP });
    // Nothing on beta beyond canary: no event.
    w.beta = { aheadBy: 0, tip: 'other', commits: [] };
    await r.pass();
    expect(moved()).toHaveLength(2);
  });

  it('no beta branch: the canary step goes on', async () => {
    const w = world();
    const { r, events } = runner(w, withCanary);
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.canary_started']);
    expect(r.view().repos[0]!.canary).not.toHaveProperty('problem');
  });

  it('no canary window set: canary is not read', async () => {
    const w = world();
    const { r } = runner(w, { repos: { [REPO]: { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } });
    await r.pass();
    expect(w.calls).toEqual(['compare dev...main']);
    expect(r.view().repos[0]!.canary).toBeUndefined();
  });
});
