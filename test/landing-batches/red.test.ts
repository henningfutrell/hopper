// Issue #1073 part 2: the batch runner on a red batch. A batch run whose checks fail starts a bisect within the batch;
// each pass takes one step: a bisect run of one point, read and closed; the culprit found; GitHub's revert of its pull
// request opened on the landing branch, then merged; a fix issue filed with the hopper label and assigned to the user,
// so Intake takes it; then a batch run of the landing branch with the culprit reverted, which promotes the rest. Fake
// GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner on a red batch
//   Scenario: a red batch of three pull requests: bisect, culprit, revert, fix issue, and the rest promoted
//   Scenario: a red batch of one direct commit: the culprit at once, no revert, a fix issue that says why
//   Scenario: a bisect run with no check in time ends the bisect, with no culprit and no issue
//   Scenario: a red batch with no failing check (merge conflicts) starts no bisect
import { describe, expect, it } from 'vitest';
import type { LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';

const REPO = 'owner/app';
const SETTINGS: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60 } } };

interface Pull { head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; url: string; headSha: string; body: string; mergeSha?: string }
interface Commit { sha: string; parents: string[]; message: string }

interface World {
  tip: string;
  commits: Commit[];
  pulls: Map<number, Pull>;
  /** Check runs per sha. */
  checks: Map<string, { name: string; status: string; conclusion?: string; id?: number }[]>;
  logs: Map<number, string>;
  issues: { title: string; body: string; labels: string[]; assignees: string[] }[];
  calls: string[];
}

const merged = (n: number, sha: string, body = ''): [number, Pull] =>
  [n, { head: `issue-${n}`, base: 'main', state: 'closed', merged: true, mergeable: null, url: `https://github.test/${REPO}/pull/${n}`, headSha: `h${n}`, body, mergeSha: sha }];

function world(commits: Commit[], pulls: [number, Pull][] = []): World {
  return { tip: commits.at(-1)!.sha, commits, pulls: new Map(pulls), checks: new Map(), logs: new Map(), issues: [], calls: [] };
}

function fake(w: World): LandingBatchGitHub {
  let next = 100;
  const url = (n: number): string => `https://github.test/${REPO}/pull/${n}`;
  return {
    defaultBranch: async () => 'main',
    compare: async () => ({ aheadBy: w.commits.length, tip: w.tip, commits: w.commits }),
    createBranch: async (_repo, name, sha) => { w.calls.push(`branch ${name} ${sha}`); },
    deleteBranch: async (_repo, name) => { w.calls.push(`delete ${name}`); },
    openPullRequest: async (_repo, p) => {
      const n = next++;
      const sha = p.head.startsWith('hopper-batch/bisect-') ? w.commits.find((c) => p.head.endsWith(c.sha.slice(0, 12)))!.sha : w.tip;
      w.pulls.set(n, { head: p.head, base: p.base, state: 'open', merged: false, mergeable: true, url: url(n), headSha: sha, body: p.body });
      w.calls.push(`open #${n} ${p.head} -> ${p.base}`);
      return { number: n, url: url(n) };
    },
    pullRequest: async (_repo, n) => {
      const p = w.pulls.get(n)!;
      return { state: p.state, merged: p.merged, mergeable: p.mergeable, headSha: p.headSha, base: p.base, url: p.url, body: p.body, ...(p.mergeSha ? { mergeSha: p.mergeSha } : {}) };
    },
    checkRuns: async (_repo, sha) => w.checks.get(sha) ?? [],
    merge: async (_repo, n, sha) => {
      const p = w.pulls.get(n)!;
      p.merged = true; p.state = 'closed';
      w.calls.push(`merge #${n} ${sha}`);
      if (p.base === 'main') {
        // A revert lands on the landing branch: its tip moves.
        const c = { sha: `revert${n}`.padEnd(16, '0'), parents: [w.tip, p.headSha], message: `Merge pull request #${n} from owner/revert` };
        w.commits.push(c);
        w.tip = c.sha;
        return { sha: c.sha };
      }
      return { sha: `m${n}` };
    },
    close: async (_repo, n) => { w.pulls.get(n)!.state = 'closed'; w.calls.push(`close #${n}`); },
    openPullRequests: async () => [],
    retarget: async () => {},
    pullRequestOf: async (_repo, sha) => [...w.pulls.entries()].find(([, p]) => p.merged && p.mergeSha === sha)?.[0],
    revert: async (_repo, n, t) => {
      const r = next++;
      w.pulls.set(r, { head: `revert-${n}`, base: 'main', state: 'open', merged: false, mergeable: true, url: url(r), headSha: `rh${r}`, body: t.body });
      w.calls.push(`revert #${n} as #${r}: ${t.title}`);
      return { number: r, url: url(r) };
    },
    checkLog: async (_repo, id) => { const l = w.logs.get(id); if (l === undefined) throw new Error('no log'); return l; },
    fileIssue: async (_repo, issue) => { w.issues.push(issue); w.calls.push(`issue ${issue.title}`); return { number: 900 + w.issues.length, url: `https://github.test/${REPO}/issues/${900 + w.issues.length}` }; },
  };
}

function runner(w: World, clock: { now: Date }) {
  const events: DomainEvent[] = [];
  let seq = 0;
  const r = createLandingBatches({
    github: () => fake(w),
    login: () => 'me',
    settings: () => SETTINGS,
    events: () => events,
    record: (e: NewEvent) => { events.push({ ...e, seq: ++seq, id: `e${seq}`, at: clock.now.toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => [],
    now: () => clock.now,
    log: () => {},
  });
  return { r, events };
}

const fail = (id: number) => [{ name: 'test', status: 'completed', conclusion: 'failure', id }];
const pass = [{ name: 'test', status: 'completed', conclusion: 'success', id: 1 }];
const P1 = 'p1aaaaaaaaaaaaaaaa';
const P2 = 'p2bbbbbbbbbbbbbbbb';
const P3 = 'p3cccccccccccccccc';

describe('the batch runner on a red batch (issue #1073)', () => {
  it('bisects, finds the culprit, reverts it, files a fix issue, and promotes the rest', async () => {
    const w = world([
      { sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' },
      { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' },
      { sha: P3, parents: [P2, 'h13'], message: 'Merge pull request #13 from owner/issue-6' },
    ], [merged(11, P1, 'Closes #4'), merged(12, P2, 'Closes #5'), merged(13, P3, 'Closes #6')]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    const types = (): string[] => events.map((e) => e.type);

    await r.pass(); // the batch run #100 of P3
    w.checks.set(P3, fail(7));
    await r.pass(); // red: closed, and a bisect of three points starts
    expect(types()).toEqual(['landing_batch.started', 'landing_batch.failed', 'landing_batch.bisect_started']);
    expect(events[2]!.data).toMatchObject({ tip: P3, points: [{ sha: P1, pullRequest: 11 }, { sha: P2, pullRequest: 12 }, { sha: P3, pullRequest: 13 }], checks: [{ name: 'test', id: 7 }] });

    await r.pass(); // a bisect run of the middle point
    expect(w.calls.slice(-2)).toEqual([`branch hopper-batch/bisect-${P2.slice(0, 12)} ${P2}`, `open #101 hopper-batch/bisect-${P2.slice(0, 12)} -> dev`]);
    await r.pass(); // its checks are pending
    expect(types().at(-1)).toBe('landing_batch.bisect_run');
    w.checks.set(P2, fail(9));
    w.logs.set(9, 'FAIL test/a.test.ts\nexpected 1 to be 2');
    await r.pass(); // P2 fails
    expect(w.calls.slice(-2)).toEqual(['close #101', `delete hopper-batch/bisect-${P2.slice(0, 12)}`]);
    expect(events.at(-1)!.data).toMatchObject({ index: 1, sha: P2, outcome: 'bad', checks: [{ name: 'test', id: 9 }] });

    await r.pass(); // a bisect run of P1
    w.checks.set(P1, pass);
    await r.pass(); // P1 passes
    expect(events.at(-1)!.data).toMatchObject({ index: 0, sha: P1, outcome: 'good' });

    await r.pass(); // the culprit: P2, #12; its revert opened; the fix issue filed
    expect(types().slice(-3)).toEqual(['landing_batch.culprit', 'landing_batch.revert_opened', 'landing_batch.fix_filed']);
    expect(events.at(-3)!.data).toMatchObject({ tip: P3, sha: P2, pullRequest: 12, checks: [{ name: 'test', id: 9 }] });
    expect(w.calls).toContain('revert #12 as #103: Revert #12: it fails the full test suite');
    expect(w.issues).toHaveLength(1);
    expect(w.issues[0]).toMatchObject({ title: 'Fix the full test suite after #12', labels: ['hopper'], assignees: ['me'] });
    expect(w.issues[0]!.body).toContain('#5');
    expect(w.issues[0]!.body).toContain('#103');
    expect(w.issues[0]!.body).toContain('expected 1 to be 2');

    await r.pass(); // the revert merged into main; a batch run of the new tip starts at once
    expect(types().slice(-2)).toEqual(['landing_batch.reverted', 'landing_batch.started']);
    expect(events.at(-1)!.data).toMatchObject({ why: 'the culprit #12 was reverted', tip: w.tip });
    w.checks.set(w.tip, pass);
    await r.pass(); // green: the rest of the batch reaches dev
    expect(types().at(-1)).toBe('landing_batch.promoted');
    await r.pass();
    expect(w.issues).toHaveLength(1);
    expect(r.view().repos[0]!.state.culprit).toMatchObject({ sha: P2, revert: { state: 'merged' }, fix: { issue: 901 } });
  });

  it('a red batch of one direct commit: the culprit at once, no revert, and a fix issue that says why', async () => {
    const w = world([{ sha: P1, parents: ['base'], message: 'Fix a typo' }]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.checks.set(P1, fail(7));
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.failed', 'landing_batch.culprit']);
    await r.pass();
    expect(events.map((e) => e.type).slice(-2)).toEqual(['landing_batch.revert_failed', 'landing_batch.fix_filed']);
    expect(w.issues[0]!.title).toBe(`Fix the full test suite after ${P1.slice(0, 12)}`);
    expect(w.issues[0]!.body).toContain('a direct commit');
    expect(w.issues[0]!.body).toContain('no output could be read');
  });

  it('a bisect run with no check in time ends the bisect, with no culprit and no issue', async () => {
    const w = world([
      { sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' },
      { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' },
    ], [merged(11, P1), merged(12, P2)]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.checks.set(P2, fail(7));
    await r.pass();
    await r.pass(); // a bisect run of P1
    clock.now = new Date('2026-10-14T12:31:00.000Z');
    await r.pass();
    expect(events.at(-1)!.type).toBe('landing_batch.bisect_tested');
    expect(events.at(-1)!.data).toMatchObject({ outcome: 'unknown', reason: 'no check ran in 30 minutes' });
    await r.pass();
    expect(w.issues).toEqual([]);
    expect(r.view().repos[0]!.state.bisectEnded).toMatchObject({ reason: 'no check ran in 30 minutes' });
  });

  it('a red batch with no failing check (merge conflicts) starts no bisect', async () => {
    const w = world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }, { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-5' }]);
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    const { r, events } = runner(w, clock);
    await r.pass();
    w.pulls.get(100)!.mergeable = false;
    await r.pass();
    expect(events.map((e) => e.type)).toEqual(['landing_batch.started', 'landing_batch.failed']);
  });
});
