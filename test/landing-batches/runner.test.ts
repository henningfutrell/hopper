// Issue #1073 part 1: the batch runner. Each pass, for each repository with landing batches: open job pull requests on the
// tested branch move to the landing branch; a batch run at work is read, and promoted on green with one merge, or
// recorded failed on red; with none at work, one starts when due. Fake GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner
//   Scenario: a due batch starts a batch run: a branch at the tip, a pull request into the tested branch, one event
//   Scenario: nothing new: no branch, no pull request, no event
//   Scenario: a green batch run is merged into the tested branch at its tip, and its branch removed
//   Scenario: a merge that waits for its batch run is recorded pending once
//   Scenario: a red batch run is recorded failed, then closed; failing checks start a bisect; with none, the same tip does not run again
//   Scenario: a job's open pull request on the tested branch moves to the landing branch, and says so on it; another's does not
//   Scenario: the hopper's own batch pull request stays on the tested branch, even when its text closes a job's issue (issue #1311)
//   Scenario: a pull request GitHub refuses to move is skipped, logged once; the others move and the batch run goes on (issue #1311)
//   Scenario: the landing branch is the one the settings name, whatever the repository's default branch (issue #1142)
//   Scenario: a landing branch that is the tested branch runs nothing and says why
//   Scenario: a step that throws stops no other step: a green batch run is merged when every move or the list of pull requests fails (issue #1333)
//   Scenario: a pass that fails the same way on several passes in a row is recorded stuck once, with the error, and shown (issue #1333)
//   Scenario: a person restarts the batch: its pull request closed, its branch removed, a new batch run at the landing tip (issue #1333)
//   Scenario: a batch run's pull request closes the issues of the job pull requests in it (issue #1175)
import { describe, expect, it } from 'vitest';
import type { LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, LANDING_BATCH_STUCK_PASSES, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';
import { retargetNote } from '../../src/sources/github/pr-notes.ts';

const REPO = 'owner/app';
const SETTINGS: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60 } } };
const TIP = 'abcdef0123456789abcdef0123456789abcdef01';

interface World {
  aheadBy: number;
  tip: string;
  messages: string[];
  pulls: Map<number, { head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; url: string; headSha: string; body?: string }>;
  checks: { name: string; status: string; conclusion?: string }[];
  calls: string[];
  /** The pull requests whose base change GitHub refuses; `all`: every one. */
  refuseRetarget?: Set<number> | 'all';
  /** The error the list of open pull requests throws. */
  listFails?: string;
  /** The error a close throws. */
  closeFails?: string;
  /** The error the compare throws. */
  compareFails?: string;
  /** The pull requests whose text GitHub does not answer (issue #1356). */
  unreadable?: Set<number>;
}

function world(): World {
  return {
    aheadBy: 3, tip: TIP,
    messages: ['Merge pull request #12 from owner/issue-1-a', 'Merge pull request #14 from owner/issue-2-b'],
    pulls: new Map(), checks: [], calls: [],
  };
}

function fake(w: World): LandingBatchGitHub {
  // The next pull request's number: after the batch pull requests GitHub has, so a fake made for each pass goes on counting.
  let next = Math.max(99, ...[...w.pulls.keys()].filter((n) => n >= 100)) + 1;
  return {
    compare: async (_repo, base, head) => {
      w.calls.push(`compare ${base}...${head}`);
      if (w.compareFails) throw new Error(w.compareFails);
      return { aheadBy: w.aheadBy, tip: w.tip, commits: w.messages.map((message, i) => ({ sha: i === w.messages.length - 1 ? w.tip : `c${i}`, parents: i === 0 ? ['base'] : [`c${i - 1}`], message })) };
    },
    createBranch: async (_repo, name, sha) => { w.calls.push(`branch ${name} ${sha}`); },
    deleteBranch: async (_repo, name) => { w.calls.push(`delete ${name}`); },
    openPullRequest: async (_repo, p) => {
      const n = next++;
      w.pulls.set(n, { head: p.head, base: p.base, state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/${n}`, headSha: w.tip, body: p.body });
      w.calls.push(`open ${p.head} -> ${p.base}`);
      return { number: n, url: `https://github.test/${REPO}/pull/${n}` };
    },
    pullRequest: async (_repo, n) => {
      if (w.unreadable?.has(n)) throw new Error(`GitHub answered 404 to ${REPO}#${n}`);
      const p = w.pulls.get(n) ?? { state: 'closed' as const, merged: true, mergeable: null, headSha: '', base: 'main', url: '', body: '' };
      return { state: p.state, merged: p.merged, mergeable: p.mergeable, headSha: p.headSha, base: p.base, url: p.url, body: p.body ?? '' };
    },
    checkRuns: async () => w.checks,
    merge: async (_repo, n, sha) => { const p = w.pulls.get(n)!; p.merged = true; p.state = 'closed'; w.calls.push(`merge #${n} ${sha}`); return { sha: 'merge-sha' }; },
    close: async (_repo, n) => { if (w.closeFails) throw new Error(w.closeFails); w.pulls.get(n)!.state = 'closed'; w.calls.push(`close #${n}`); },
    mergeInto: async () => ({ kind: 'nothing' }),
    openPullRequests: async (_repo, base) => {
      if (w.listFails) throw new Error(w.listFails);
      return [...w.pulls.entries()].filter(([, p]) => p.state === 'open' && p.base === base).map(([number, p]) => ({ number, url: p.url, head: p.head, title: '' }));
    },
    retarget: async (_repo, n, base) => {
      w.calls.push(`retarget #${n} ${base}`);
      if (w.refuseRetarget === 'all' || w.refuseRetarget?.has(n)) throw new Error(`GitHub answered 422 to the base of ${REPO}#${n}: Validation Failed`);
      w.pulls.get(n)!.base = base;
    },
    comment: async (_repo, n, body) => { w.calls.push(`comment #${n} ${body}`); },
    pullRequestOf: async () => undefined,
    revert: async () => { throw new Error('no revert here'); },
    checkLog: async () => '',
    fileIssue: async () => { throw new Error('no issue here'); }, findIssue: async () => undefined,
    bugReports: async () => [],
    fastForward: async () => { throw new Error('no canary here'); },
  };
}

function runner(w: World, o: { jobPullRequests?: string[]; now?: Date; settings?: LandingBatchSettings; closingIssues?: (repo: string, merges: readonly number[]) => string[]; log?: string[] } = {}) {
  const events: DomainEvent[] = [];
  let seq = 0;
  const r = createLandingBatches({
    github: () => fake(w),
    login: () => 'me',
    settings: () => o.settings ?? SETTINGS,
    events: () => events,
    record: (e: NewEvent) => { events.push({ ...e, seq: ++seq, id: `e${seq}`, at: (o.now ?? new Date()).toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => o.jobPullRequests ?? [],
    ...(o.closingIssues ? { closingIssues: o.closingIssues } : {}),
    now: () => o.now ?? new Date(),
    log: (l) => { o.log?.push(l); },
  });
  return { r, events };
}

describe('the batch runner (issue #1073)', () => {
  it('starts a batch run when due: a branch at the tip, a pull request into dev, one event', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    expect(w.calls).toEqual(['compare dev...main', `branch hopper-batch/abcdef012345 ${TIP}`, 'open hopper-batch/abcdef012345 -> dev']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started']);
    expect(events[0]!.data).toEqual({ repo: REPO, landing: 'main', tested: 'dev', tip: TIP, branch: 'hopper-batch/abcdef012345', merges: [12, 14], closes: [], why: 'no batch run before' });
    expect(events[1]!.data).toMatchObject({ repo: REPO, landing: 'main', tested: 'dev', tip: TIP, branch: 'hopper-batch/abcdef012345', pullRequest: 100, merges: [12, 14] });
    expect(r.view().repos[0]).toMatchObject({ repo: REPO, state: { running: { pullRequest: 100 } } });
  });

  it('a batch run\'s pull request closes the issues of the job pull requests in it (issue #1175)', async () => {
    const w = world();
    const asked: [string, readonly number[]][] = [];
    const { r } = runner(w, { closingIssues: (repo, merges) => { asked.push([repo, merges]); return ['#1', '#2']; } });
    await r.pass();
    expect(asked).toEqual([[REPO, [12, 14]]]);
    expect(w.pulls.get(100)!.body).toMatch(/- #12\n- #14\n\nCloses #1\nCloses #2$/);
  });

  it('a batch run\'s pull request closes each issue its job pull requests\' own text closes, whatever the ledger knows (issue #1356)', async () => {
    const w: World = { ...world(), unreadable: new Set([12]) };
    w.pulls.set(14, { head: 'issue-2-b', base: 'main', state: 'closed', merged: true, mergeable: null, url: 'u14', headSha: 'h14', body: 'Closes #1\n\nFixes #1264\nPart of #3' });
    const log: string[] = [];
    await runner(w, { closingIssues: () => ['#1'], log }).r.pass();
    expect(w.pulls.get(100)!.body).toMatch(/- #12\n- #14\n\nCloses #1\nCloses #1264$/);
    expect(log).toEqual([`hopper: landing batches: the text of ${REPO}#12 was not read: GitHub answered 404 to ${REPO}#12`]);
  });

  it('nothing new: no branch, no pull request, no event', async () => {
    const w = { ...world(), aheadBy: 0 };
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
    expect(events).toHaveLength(2);
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    await r.pass();
    expect(w.calls.slice(-2)).toEqual([`merge #100 ${TIP}`, 'delete hopper-batch/abcdef012345']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.promoted']);
    expect(events[2]!.data).toMatchObject({ repo: REPO, tested: 'dev', tip: TIP, pullRequest: 100, merge: 'merge-sha' });
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
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.promoted', 'landing_batch.pending']);
    expect(events[3]!.data).toMatchObject({ repo: REPO, landing: 'main', tested: 'dev', tip: tip2, merges: [16] });
    expect(r.view().repos[0]!.state.pending).toEqual({ tip: tip2, merges: [16] });
  });

  it('red: records the batch run failed and its bisect, then closes it (red.test.ts)', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
    await r.pass();
    expect(w.calls.slice(-3)).toEqual(['compare dev...abcdef0123456789abcdef0123456789abcdef01', 'close #100', 'delete hopper-batch/abcdef012345']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.bisect_started']);
    expect(events[2]!.data).toMatchObject({ tip: TIP, reason: 'checks failed: test', checks: ['test'] });
  });

  it('red with merge conflicts: closed and recorded failed; the same tip does not run again', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.pulls.get(100)!.mergeable = false;
    await r.pass();
    // Nothing of dev to merge into the landing branch (part 4): the back-merge fails, and no issue is filed.
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_failed']);
    await r.pass();
    await r.pass();
    // Its pull requests wait for the next batch run again: recorded once (part 3).
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.failed', 'landing_batch.back_merge_failed', 'landing_batch.pending']);
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
    // The pull request shows it (issue #1143): the same fixed note as the follow's move.
    expect(w.calls.filter((c) => c.startsWith('comment'))).toEqual([`comment #7 ${retargetNote('dev', 'main')}`]);
  });

  it('leaves the hopper\'s own batch pull request on dev, even when its text closes a job\'s issue (issue #1311)', async () => {
    const w = world();
    w.aheadBy = 0;
    // A batch run, a bisect and a back-merge, each named by a job: its text closes or names the job's issue.
    for (const [n, head] of [[100, 'hopper-batch/abcdef012345'], [9, 'hopper-batch/bisect-abcdef012345'], [10, 'hopper-batch/back-merge-abcdef012345']] as const) {
      w.pulls.set(n, { head, base: 'dev', state: 'open', merged: false, mergeable: true, url: `https://github.test/${REPO}/pull/${n}`, headSha: TIP, body: 'Closes #1' });
    }
    const { r } = runner(w, { jobPullRequests: [100, 9, 10].map((n) => `https://github.test/${REPO}/pull/${n}`) });
    await r.pass();
    expect(w.pulls.get(100)!.base).toBe('dev');
    expect(w.pulls.get(9)!.base).toBe('dev');
    expect(w.pulls.get(10)!.base).toBe('dev');
    expect(w.calls.filter((c) => c.startsWith('retarget') || c.startsWith('comment'))).toEqual([]);
  });

  it('skips a pull request GitHub refuses to move, logged once; the others move and the batch run is merged (issue #1311)', async () => {
    const w = world();
    const log: string[] = [];
    const jobs = [6, 7].map((n) => `https://github.test/${REPO}/pull/${n}`);
    const { r, events } = runner(w, { jobPullRequests: jobs, log });
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    w.pulls.set(6, { head: 'issue-6', base: 'dev', state: 'open', merged: false, mergeable: true, url: jobs[0]!, headSha: 'x' });
    w.pulls.set(7, { head: 'issue-7', base: 'dev', state: 'open', merged: false, mergeable: true, url: jobs[1]!, headSha: 'y' });
    w.refuseRetarget = new Set([6]);
    await r.pass();
    expect(w.pulls.get(6)!.base).toBe('dev');
    expect(w.pulls.get(7)!.base).toBe('main');
    expect(w.pulls.get(100)!.merged).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.retargeted', 'landing_batch.promoted']);
    expect(w.calls.filter((c) => c.startsWith('comment'))).toEqual([`comment #7 ${retargetNote('dev', 'main')}`]);
    // Refused again on the next pass: not logged again.
    await r.pass();
    expect(log.filter((l) => l.includes('#6'))).toHaveLength(1);
    expect(log.filter((l) => l.includes('#6'))[0]).toMatch(/422/);
  });

  it('batches the landing branch the settings name, and reads no default branch (issue #1142)', async () => {
    const w = world();
    const { r, events } = runner(w, { settings: { repos: { [REPO]: { tested: 'dev', landing: 'trunk', everyMerges: 2, everyMinutes: 60 } } } });
    await r.pass();
    expect(w.calls).toEqual(['compare dev...trunk', `branch hopper-batch/abcdef012345 ${TIP}`, 'open hopper-batch/abcdef012345 -> dev']);
    expect(events[1]!.data).toMatchObject({ landing: 'trunk', tested: 'dev', tip: TIP });
  });

  it('runs nothing while the landing branch is the tested branch, and says why', async () => {
    const w = world();
    const { r, events } = runner(w, { settings: { repos: { [REPO]: { tested: 'dev', landing: 'dev', everyMerges: 2, everyMinutes: 60 } } } });
    await r.pass();
    expect(w.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(r.view().repos[0]!.problem).toBe('the landing branch of owner/app is dev, its tested branch: name another landing branch in Settings → Landing batches');
  });

  it('merges a green batch run when the move of every job pull request fails (issue #1333)', async () => {
    const w = world();
    const jobs = [6, 7, 100].map((n) => `https://github.test/${REPO}/pull/${n}`);
    const { r, events } = runner(w, { jobPullRequests: jobs });
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    w.pulls.set(6, { head: 'issue-6', base: 'dev', state: 'open', merged: false, mergeable: true, url: jobs[0]!, headSha: 'x' });
    w.pulls.set(7, { head: 'issue-7', base: 'dev', state: 'open', merged: false, mergeable: true, url: jobs[1]!, headSha: 'y' });
    w.refuseRetarget = 'all';
    await r.pass();
    expect(w.pulls.get(100)!.merged).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.promoted']);
  });

  it('merges a green batch run when the list of pull requests to move fails, and says the problem (issue #1333)', async () => {
    const w = world();
    const log: string[] = [];
    const { r, events } = runner(w, { log });
    await r.pass();
    w.checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    w.listFails = 'GitHub answered 502';
    await r.pass();
    expect(w.pulls.get(100)!.merged).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.promoted']);
    expect(r.view().repos[0]!.problem).toBe('the move of job pull requests to main: GitHub answered 502');
    expect(log.filter((l) => l.includes('502'))).toHaveLength(1);
  });

  it('a pass that fails the same way on several passes in a row is recorded stuck once, with the error, and shown (issue #1333)', async () => {
    const w = world();
    const log: string[] = [];
    const { r, events } = runner(w, { log });
    w.compareFails = 'GitHub answered 422: Validation Failed';
    for (let i = 1; i < LANDING_BATCH_STUCK_PASSES; i++) await r.pass();
    expect(events).toEqual([]);
    expect(r.view().repos[0]!.stuck).toBeUndefined();
    await r.pass();
    await r.pass();
    expect(events.map((e) => [e.type, e.data])).toEqual([['landing_batch.stuck', expect.objectContaining({ repo: REPO, error: 'the start of a batch run: GitHub answered 422: Validation Failed', passes: LANDING_BATCH_STUCK_PASSES })]]);
    expect(r.view().repos[0]!.stuck).toMatchObject({ error: 'the start of a batch run: GitHub answered 422: Validation Failed', passes: LANDING_BATCH_STUCK_PASSES + 1 });
    // Logged when it changes, not on every pass.
    expect(log).toHaveLength(1);
    // A pass with no problem ends it; a new run of failures is recorded again.
    delete w.compareFails;
    await r.pass();
    expect(r.view().repos[0]!.stuck).toBeUndefined();
  });

  it('a person restarts the batch: its pull request closed, its branch removed, a new batch run at the landing tip (issue #1333)', async () => {
    const w = world();
    const { r, events } = runner(w);
    await r.pass();
    w.calls.length = 0;
    await r.restart(REPO, 'admin').done;
    expect(w.calls).toEqual(['close #100', 'delete hopper-batch/abcdef012345', 'compare dev...main', `branch hopper-batch/abcdef012345 ${TIP}`, 'open hopper-batch/abcdef012345 -> dev']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.restarted', 'landing_batch.due', 'landing_batch.started']);
    expect(events[2]!.data).toEqual({ repo: REPO, tip: TIP, by: 'admin', closed: [100] });
    expect(events[4]!.data).toMatchObject({ tip: TIP, pullRequest: 101, why: 'a person restarted the landing batch' });
  });

  it('restarts the batch when GitHub refuses the close: logged, and the removed branch ends it (issue #1333)', async () => {
    const w = world();
    const log: string[] = [];
    const { r, events } = runner(w, { log });
    await r.pass();
    w.closeFails = 'GitHub answered 422';
    await r.restart(REPO, 'admin').done;
    expect(log).toEqual(['hopper: landing batches: #100 of owner/app not closed: GitHub answered 422']);
    expect(events.map((e) => e.type)).toEqual(['landing_batch.due', 'landing_batch.started', 'landing_batch.restarted', 'landing_batch.due', 'landing_batch.started']);
  });

  it('refuses to restart a repository with no landing batches', async () => {
    const { r } = runner(world());
    expect(() => r.restart('owner/other', 'admin')).toThrow('owner/other has no landing batches');
  });
});
