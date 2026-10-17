// Issue #1589: the batch runner records each GitHub write's intent before it makes the call. For each scenario, the hopper
// stops after each GitHub call in turn — the call went through, and nothing after it ran or was recorded — and a new
// hopper starts on the same events. Each pull request, revert and issue exists once, no batch or bisect run that ended
// stays open, and the batch goes on to its end. Fake GitHub at the LandingBatchGitHub seam; it refuses a second open pull
// request from one branch, as GitHub does.
//
// Feature: a stop between a GitHub call and its record
//   Scenario: a red batch: batch run, bisect runs, culprit, revert, fix issue, and the rest promoted
//   Scenario: merge conflicts: the back-merge, and the batch promoted after it
//   Scenario: a real conflict: one issue
//   Scenario: a person restarts the batch: the old batch run closed, one new batch run
//   Scenario: the canary's window passed: stable moved, and the promotion recorded once
//   Scenario: the canary held: one issue
import { describe, expect, it } from 'vitest';
import { batchBranch, landingBatchStates, type LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, type LandingBatches, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';

const REPO = 'owner/app';
const SETTINGS: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60 } } };
const STOPPED = 'the hopper stopped';
const P1 = 'p1aaaaaaaaaaaaaaaa';
const P2 = 'p2bbbbbbbbbbbbbbbb';
const P3 = 'p3cccccccccccccccc';
const CANARY = 'abcdef0123456789abcdef0123456789abcdef01';

interface Pull { head: string; base: string; title: string; state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; url: string; headSha: string; body: string; mergeSha?: string }
interface Commit { sha: string; parents: string[]; message: string }

interface World {
  tip: string;
  commits: Commit[];
  pulls: Map<number, Pull>;
  next: number;
  /** The shas whose checks fail; every other sha's pass. */
  failing: Set<string>;
  /** The batch runs (by branch) that have merge conflicts with the tested branch. */
  conflicting: Set<string>;
  backMerge: 'merged' | 'conflict' | 'nothing';
  issues: { title: string; labels: string[] }[];
  reports: number[];
  stable: string;
  canary: string;
  /** GitHub calls made, and the call after which the hopper stops. */
  calls: number;
  stopAt?: number;
  stopped: boolean;
}

const url = (n: number): string => `https://github.test/${REPO}/pull/${n}`;
const merged = (n: number, sha: string): [number, Pull] =>
  [n, { head: `issue-${n}`, base: 'main', title: `Change ${n}`, state: 'closed', merged: true, mergeable: null, url: url(n), headSha: `h${n}`, body: `Closes #${n - 10}`, mergeSha: sha }];

function world(commits: Commit[], pulls: [number, Pull][] = []): World {
  return {
    tip: commits.at(-1)?.sha ?? 'base', commits, pulls: new Map(pulls), next: 100, failing: new Set(), conflicting: new Set(), backMerge: 'merged',
    issues: [], reports: [], stable: 'stable0', canary: 'stable0', calls: 0, stopped: false,
  };
}

/** GitHub as the hopper sees it, with the stop: after call number `stopAt` went through, every call throws. */
function fake(w: World): LandingBatchGitHub {
  const gh: LandingBatchGitHub = {
    compare: async (_repo, base) => base === 'stable'
      ? { aheadBy: w.stable === w.canary ? 0 : 1, tip: w.canary, commits: [] }
      : { aheadBy: w.commits.length, tip: w.tip, commits: w.commits },
    createBranch: async () => {},
    deleteBranch: async () => {},
    openPullRequest: async (_repo, p) => {
      if ([...w.pulls.values()].some((x) => x.state === 'open' && x.head === p.head && x.base === p.base)) throw new Error('GitHub answered 422: a pull request already exists');
      const n = w.next++;
      const sha = p.head.startsWith('hopper-batch/bisect-') ? w.commits.find((c) => p.head.endsWith(c.sha.slice(0, 12)))!.sha
        : p.head.startsWith('hopper-batch/back-merge-') ? 'backmerge0000000' : w.tip;
      w.pulls.set(n, { head: p.head, base: p.base, title: p.title, state: 'open', merged: false, mergeable: !w.conflicting.has(p.head), url: url(n), headSha: sha, body: p.body });
      return { number: n, url: url(n) };
    },
    pullRequest: async (_repo, n) => {
      const p = w.pulls.get(n)!;
      return { state: p.state, merged: p.merged, mergeable: p.mergeable, headSha: p.headSha, base: p.base, url: p.url, body: p.body, ...(p.mergeSha ? { mergeSha: p.mergeSha } : {}) };
    },
    checkRuns: async (_repo, sha) => [{ name: 'test', status: 'completed', conclusion: w.failing.has(sha) ? 'failure' : 'success', id: 7 }],
    merge: async (_repo, n) => {
      const p = w.pulls.get(n)!;
      if (p.state !== 'open') throw new Error('GitHub answered 405: the pull request is not open');
      Object.assign(p, { merged: true, state: 'closed', mergeSha: `m${n}` });
      if (p.base === 'main') {
        // A revert or a back-merge lands on the landing branch: its tip moves.
        const c = { sha: `landed${n}`.padEnd(16, '0'), parents: [w.tip, p.headSha], message: `Merge pull request #${n} from owner/${p.head}` };
        w.commits.push(c);
        w.tip = c.sha;
      }
      return { sha: `m${n}` };
    },
    close: async (_repo, n) => { w.pulls.get(n)!.state = 'closed'; },
    mergeInto: async () => (w.backMerge === 'merged' ? { kind: 'merged', sha: 'backmerge0000000' } : { kind: w.backMerge }),
    openPullRequests: async (_repo, base) => [...w.pulls.entries()].filter(([, p]) => p.state === 'open' && p.base === base).map(([number, p]) => ({ number, url: p.url, head: p.head, title: p.title })),
    retarget: async () => {},
    comment: async () => {},
    pullRequestOf: async (_repo, sha) => [...w.pulls.entries()].find(([, p]) => p.merged && p.mergeSha === sha)?.[0],
    revert: async (_repo, n, t) => {
      // GitHub reverts the same pull request again when asked again: a second revert.
      const r = w.next++;
      w.pulls.set(r, { head: `revert-${n}-${r}`, base: 'main', title: t.title, state: 'open', merged: false, mergeable: true, url: url(r), headSha: `rh${r}`, body: t.body });
      return { number: r, url: url(r) };
    },
    checkLog: async () => 'FAIL test/a.test.ts',
    fileIssue: async (_repo, issue) => { w.issues.push(issue); return { number: 900 + w.issues.length, url: `https://github.test/${REPO}/issues/${900 + w.issues.length}` }; },
    findIssue: async (_repo, f) => {
      const i = w.issues.findIndex((x) => x.title === f.title && x.labels.includes(f.label));
      return i < 0 ? undefined : { number: 901 + i, url: `https://github.test/${REPO}/issues/${901 + i}` };
    },
    bugReports: async () => w.reports,
    fastForward: async (_repo, _branch, sha) => { w.stable = sha; },
  };
  return new Proxy(gh, {
    get(target, key: keyof LandingBatchGitHub) {
      const f = target[key] as (...a: unknown[]) => Promise<unknown>;
      return async (...a: unknown[]) => {
        if (w.stopped) throw new Error(STOPPED);
        const out = await f(...a);
        if (++w.calls === w.stopAt) { w.stopped = true; throw new Error(STOPPED); }
        return out;
      };
    },
  });
}

/** A hopper on the events: a stopped one records nothing more. Its clock moves 3 minutes at each pass. */
function boot(w: World, events: DomainEvent[], clock: { now: Date }, settings = SETTINGS): LandingBatches {
  const r = createLandingBatches({
    github: () => fake(w),
    login: () => 'me',
    settings: () => settings,
    events: () => events,
    record: (e: NewEvent) => { if (!w.stopped) events.push({ ...e, seq: events.length + 1, id: `e${events.length + 1}`, at: clock.now.toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => [],
    now: () => clock.now,
    log: () => {},
  });
  const pass = r.pass;
  return { ...r, pass: async () => { clock.now = new Date(clock.now.getTime() + 3 * 60_000); await pass(); } };
}

interface Scenario {
  world(): World;
  settings?: LandingBatchSettings;
  /** What the first hopper does; it may stop on the way. */
  drive(r: LandingBatches): Promise<void>;
  /** The end the batch reaches, after the second hopper's passes. */
  end(w: World, events: DomainEvent[]): void;
}

/** Each pull request, revert and issue once; no run that ended stays open; every open one of the hopper is at work. */
function once(w: World, events: DomainEvent[]): void {
  const pulls = [...w.pulls.values()];
  const open = pulls.filter((p) => p.state === 'open');
  for (const p of open) expect(open.filter((x) => x.head === p.head && x.base === p.base)).toHaveLength(1);
  const titles = pulls.filter((p) => p.head.startsWith('revert-')).map((p) => p.title);
  expect(new Set(titles).size).toBe(titles.length);
  expect(new Set(w.issues.map((i) => i.title)).size).toBe(w.issues.length);
  const s = landingBatchStates(events)[REPO];
  const atWork = [s?.running?.pullRequest, s?.bisect?.running?.pullRequest, s?.backMerge?.state === 'open' ? s.backMerge.pullRequest : undefined];
  for (const [n, p] of w.pulls) if (p.state === 'open' && p.head.startsWith('hopper-batch/')) expect(atWork).toContain(n);
}

const passes = async (r: LandingBatches, n: number): Promise<void> => { for (let i = 0; i < n; i++) await r.pass(); };

/** The scenario with the hopper stopped after each GitHub call of its clean run in turn, then a new hopper's passes. */
async function everyStop(s: Scenario): Promise<number> {
  const clean = s.world();
  const cleanEvents: DomainEvent[] = [];
  const cleanClock = { now: new Date('2026-10-14T12:00:00.000Z') };
  await s.drive(boot(clean, cleanEvents, cleanClock, s.settings));
  const calls = clean.calls;
  await passes(boot(clean, cleanEvents, cleanClock, s.settings), 25);
  s.end(clean, cleanEvents);
  once(clean, cleanEvents);
  for (let stopAt = 1; stopAt <= calls; stopAt++) {
    const w = s.world();
    w.stopAt = stopAt;
    const events: DomainEvent[] = [];
    const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
    await s.drive(boot(w, events, clock, s.settings));
    expect(w.stopped, `the stop after call ${stopAt}`).toBe(true);
    w.stopped = false;
    delete w.stopAt;
    await passes(boot(w, events, clock, s.settings), 25);
    try {
      s.end(w, events);
      once(w, events);
    } catch (e) {
      throw new Error(`the stop after call ${stopAt}: ${(e as Error).message}`, { cause: e });
    }
  }
  return calls;
}
const types = (events: DomainEvent[]): string[] => events.map((e) => e.type);
const count = (events: DomainEvent[], type: string): number => events.filter((e) => e.type === type).length;

describe('a stop between a GitHub call and its record (issue #1589)', () => {
  it('a red batch: each batch run, bisect run, revert and fix issue once, and the rest promoted', async () => {
    const calls = await everyStop({
      world: () => {
        const w = world([
          { sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' },
          { sha: P2, parents: [P1, 'h12'], message: 'Merge pull request #12 from owner/issue-2' },
          { sha: P3, parents: [P2, 'h13'], message: 'Merge pull request #13 from owner/issue-3' },
        ], [merged(11, P1), merged(12, P2), merged(13, P3)]);
        w.failing = new Set([P2, P3]);
        return w;
      },
      drive: (r) => passes(r, 12),
      end: (w, events) => {
        const s = landingBatchStates(events)[REPO]!;
        expect(s.culprit).toMatchObject({ sha: P2, pullRequest: 12, revert: { state: 'merged' }, fix: { issue: 901 } });
        expect(w.issues).toHaveLength(1);
        expect([...w.pulls.values()].filter((p) => p.head.startsWith('revert-'))).toHaveLength(1);
        expect(s.last).toMatchObject({ outcome: 'promoted', tip: w.tip });
        expect(count(events, 'landing_batch.failed')).toBe(1);
        expect(count(events, 'landing_batch.bisect_started')).toBe(1);
        expect(count(events, 'landing_batch.culprit')).toBe(1);
      },
    });
    expect(calls).toBeGreaterThan(20);
  });

  it('merge conflicts: one back-merge, and the batch promoted after it', async () => {
    await everyStop({
      world: () => {
        const w = world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }], [merged(11, P1)]);
        w.conflicting = new Set([batchBranch(P1)]);
        return w;
      },
      drive: (r) => passes(r, 4),
      end: (w, events) => {
        const s = landingBatchStates(events)[REPO]!;
        expect(s.backMerge).toMatchObject({ state: 'merged' });
        expect([...w.pulls.values()].filter((p) => p.head.startsWith('hopper-batch/back-merge-'))).toHaveLength(1);
        expect(s.last).toMatchObject({ outcome: 'promoted', tip: w.tip });
        expect(w.issues).toEqual([]);
      },
    });
  });

  it('a real conflict: one issue', async () => {
    await everyStop({
      world: () => {
        const w = world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }], [merged(11, P1)]);
        w.conflicting = new Set([batchBranch(P1)]);
        w.backMerge = 'conflict';
        return w;
      },
      drive: (r) => passes(r, 4),
      end: (w, events) => {
        expect(landingBatchStates(events)[REPO]).toMatchObject({ backMerge: { state: 'failed', conflict: true }, backMergeIssue: { issue: 901 } });
        expect(w.issues).toHaveLength(1);
      },
    });
  });

  it('a person restarts the batch: the old batch run closed, one new batch run', async () => {
    await everyStop({
      world: () => world([{ sha: P1, parents: ['base', 'h11'], message: 'Merge pull request #11 from owner/issue-1' }], [merged(11, P1)]),
      drive: async (r) => {
        await r.pass();
        await r.restart(REPO, 'admin').done.catch(() => undefined);
        await r.pass();
      },
      end: (w, events) => {
        // A stop before the restart leaves none to record.
        expect(count(events, 'landing_batch.restarted')).toBeLessThanOrEqual(1);
        expect([...w.pulls.values()].filter((p) => p.head === batchBranch(P1) && p.state === 'open')).toEqual([]);
        expect(landingBatchStates(events)[REPO]!.last).toMatchObject({ outcome: 'promoted', tip: P1 });
      },
    });
  });

  it('the canary\'s window passed: stable moved, and the promotion recorded once', async () => {
    await everyStop({
      world: () => Object.assign(world([]), { canary: CANARY }),
      settings: { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60, canaryHours: 1 } } },
      drive: (r) => passes(r, 25),
      end: (w, events) => {
        expect(w.stable).toBe(CANARY);
        expect(types(events).filter((t) => t.startsWith('landing_batch.canary_'))).toEqual(['landing_batch.canary_started', 'landing_batch.canary_promoted']);
      },
    });
  });

  it('the canary held: one issue', async () => {
    await everyStop({
      world: () => Object.assign(world([]), { canary: CANARY, reports: [41] }),
      settings: { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60, canaryHours: 1 } } },
      drive: (r) => passes(r, 3),
      end: (w, events) => {
        expect(w.issues).toHaveLength(1);
        expect(landingBatchStates(events)[REPO]!.canary).toMatchObject({ state: 'held', issue: { issue: 901 } });
        expect(w.stable).toBe('stable0');
      },
    });
  });
});
