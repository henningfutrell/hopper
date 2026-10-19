// Landing batches (issue #1073) under the crash harness (issue #1954 part 8, issue #1589): a first hopper runs the batch
// runner's passes and is killed with SIGKILL after one of its GitHub writes went through, before the event that records
// it. A second hopper on the same database takes the passes on. The landing batches' GitHub (`landing-github.ts`) is in
// the test process, so it holds what the killed hopper made: each pull request, revert and issue must exist once there,
// no branch of the hopper's may stay, and the batch must reach the end a clean run reaches. A test drives passes by
// saving the same settings again, which runs a pass.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { batchBranch, type LandingBatchState } from '../../src/domain/landing-batches.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { waitFor } from '../support/wait.ts';
import { killedAt, startHost, stopHosts, type CrashHost } from './harness.ts';
import { createLandingGitHub, LANDING, LANDING_REPO as REPO, shaOf, TESTED, type LandingGitHub } from './landing-github.ts';

/** The most one scenario takes: two hoppers start, one is killed, and up to some 20 passes. */
export const SCENARIO_MS = 120_000;
const P1 = shaOf('p1'), P2 = shaOf('p2'), P3 = shaOf('p3');
const CANARY = shaOf('canary');
const merge = (n: number): { sha: string; message: string } => ({ sha: shaOf(`p${n - 10}`), message: `Merge pull request #${n} from owner/issue-${n}` });

/** The kill point after a write of the landing batches' GitHub, before its event: its nth in the process. */
export const landingPoint = (write: string, nth: number): string => `landing:${write}:after-call#${nth}`;
/** The kill points of a clean run's writes, in order. */
export const pointsOf = (writes: readonly string[]): string[] => {
  const seen = new Map<string, number>();
  return writes.map((w) => { seen.set(w, (seen.get(w) ?? 0) + 1); return landingPoint(w, seen.get(w)!); });
};

export interface LandingScenario {
  /** Names the scenario to `describeLanding`. */
  key: string;
  name: string;
  /** The fake GitHub: the landing branch's merges, and what fails. */
  github(): Promise<LandingGitHub>;
  canaryHours?: number;
  /** A canary candidate started 2 hours before, so its window of 1 hour passed. */
  canaryStarted?: boolean;
  /** The batch reached its end. */
  done(s: LandingBatchState | undefined, g: LandingGitHub): boolean;
  /** What the end holds, past `once`. */
  end(s: LandingBatchState, g: LandingGitHub, count: (type: string) => number): void;
  /** The kill points of the clean run's writes, in order: `pointsOf` of its writes. */
  points: string[];
}

export const LANDING_SCENARIOS: LandingScenario[] = [
  {
    key: 'red',
    name: 'a red batch: batch run, bisect runs, culprit, revert, fix issue, and the rest promoted',
    github: async () => {
      const g = await createLandingGitHub({ commits: [merge(11), merge(12), merge(13)], merged: [{ number: 11, sha: P1 }, { number: 12, sha: P2 }, { number: 13, sha: P3 }] });
      g.failing = new Set([P2, P3]);
      return g;
    },
    done: (s, g) => !!s?.culprit?.fix && s.last?.outcome === 'promoted' && s.last.tip === g.branches.get(LANDING),
    end: (s, g, count) => {
      expect(s.culprit).toMatchObject({ sha: P2, pullRequest: 12, revert: { state: 'merged' } });
      expect(g.issues).toHaveLength(1);
      expect([...g.pulls.values()].filter((p) => p.head.startsWith('revert-'))).toHaveLength(1);
      for (const t of ['failed', 'bisect_started', 'culprit', 'revert_opened', 'reverted', 'fix_filed']) expect(count(`landing_batch.${t}`), t).toBe(1);
      expect(count('landing_batch.promoted')).toBe(1);
    },
    points: pointsOf([
      'createBranch', 'openPullRequest', 'deleteBranch', 'close', 'createBranch', 'openPullRequest', 'deleteBranch', 'close', 'createBranch', 'openPullRequest',
      'deleteBranch', 'close', 'revert', 'fileIssue', 'merge', 'createBranch', 'openPullRequest', 'merge', 'deleteBranch',
    ]),
  },
  {
    key: 'back-merge',
    name: 'merge conflicts: one back-merge, and the batch promoted after it',
    github: async () => {
      const g = await createLandingGitHub({ commits: [merge(11)], merged: [{ number: 11, sha: P1 }] });
      g.conflicting = new Set([batchBranch(P1)]);
      return g;
    },
    done: (s, g) => s?.backMerge?.state === 'merged' && s.last?.outcome === 'promoted' && s.last.tip === g.branches.get(LANDING),
    end: (_s, g, count) => {
      expect([...g.pulls.values()].filter((p) => p.base === LANDING && p.head.startsWith('hopper-batch/back-merge-'))).toHaveLength(1);
      expect(g.issues).toEqual([]);
      for (const t of ['back_merge_opened', 'back_merged', 'promoted']) expect(count(`landing_batch.${t}`), t).toBe(1);
    },
    points: pointsOf([
      'createBranch', 'openPullRequest', 'deleteBranch', 'close', 'createBranch', 'mergeInto', 'openPullRequest', 'merge', 'deleteBranch', 'createBranch',
      'openPullRequest', 'merge', 'deleteBranch',
    ]),
  },
  {
    key: 'conflict',
    name: 'a real conflict: one issue',
    github: async () => {
      const g = await createLandingGitHub({ commits: [merge(11)], merged: [{ number: 11, sha: P1 }] });
      g.conflicting = new Set([batchBranch(P1)]);
      g.mergeInto = 'conflict';
      return g;
    },
    done: (s) => !!s?.backMergeIssue,
    end: (_s, g, count) => {
      expect(g.issues).toHaveLength(1);
      expect(count('landing_batch.back_merge_issue_filed')).toBe(1);
    },
    points: pointsOf(['createBranch', 'openPullRequest', 'deleteBranch', 'close', 'createBranch', 'mergeInto', 'deleteBranch', 'fileIssue']),
  },
  {
    key: 'canary-held',
    name: 'the canary held: one issue',
    github: async () => {
      const g = await createLandingGitHub({ commits: [], merged: [] });
      g.branches.set('canary', CANARY);
      g.reports = [41];
      return g;
    },
    canaryHours: 1,
    done: (s) => !!s?.canary?.issue,
    end: (s, g, count) => {
      expect(s.canary).toMatchObject({ state: 'held', tip: CANARY });
      expect(g.issues).toHaveLength(1);
      expect(g.branches.get('stable')).toBe(shaOf('base'));
      expect(count('landing_batch.canary_issue_filed')).toBe(1);
    },
    points: pointsOf(['fileIssue']),
  },
  {
    key: 'canary-passed',
    name: 'the canary\'s window passed: stable moved, and the promotion recorded once',
    github: async () => {
      const g = await createLandingGitHub({ commits: [], merged: [] });
      g.branches.set('canary', CANARY);
      return g;
    },
    canaryHours: 1,
    canaryStarted: true,
    done: (s) => s?.canary?.state === 'promoted',
    end: (_s, g, count) => {
      expect(g.branches.get('stable')).toBe(CANARY);
      expect(count('landing_batch.canary_started')).toBe(1);
      expect(count('landing_batch.canary_promoted')).toBe(1);
    },
    points: pointsOf(['fastForward']),
  },
];

export interface LandingWorld {
  github: LandingGitHub;
  host(o?: { killPoint?: string; connect?: boolean }): Promise<CrashHost>;
  /** Runs passes on `h` until `until` holds, or the host ended. */
  drive(h: CrashHost, until: () => Promise<boolean>, what: string): Promise<void>;
  state(h: CrashHost): Promise<LandingBatchState | undefined>;
  close(): Promise<void>;
}

export async function landingWorld(s: LandingScenario): Promise<LandingWorld> {
  const github = await s.github();
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const settings = { repos: { [REPO]: { tested: TESTED, everyMerges: 2, everyMinutes: 60, ...(s.canaryHours ? { canaryHours: s.canaryHours } : {}) } } };
  let seeded = false;
  const w: LandingWorld = {
    github,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { landing: github.url },
      ...(h.connect ? { connectGitHub: [REPO] } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    drive: async (h, until, what) => {
      // The canary started 2 hours before: kept in the store once the first host made its schema.
      if (s.canaryStarted && !seeded) {
        seeded = true;
        const store = openUserStore({ url: ownerSchemaUrlFor(db.dbPath), clock: { now: () => new Date(Date.now() - 2 * 3_600_000) }, idGen: randomUUID });
        try { store.events.append({ type: 'landing_batch.canary_started', data: { repo: REPO, canary: 'canary', stable: 'stable', tip: CANARY, hours: 1 } }); } finally { store.close(); }
      }
      let ended = false;
      void h.exited.then(() => (ended = true));
      await waitFor(async () => {
        if (ended || await until()) return true;
        await h.ui('/ui/api/landing-batches', settings);
        return undefined;
      }, { timeoutMs: 60_000, intervalMs: 150, what }).catch((e: unknown) => { throw new Error(`${(e as Error).message}: ${JSON.stringify(github.writes)}\n${h.stderr()}`); });
    },
    state: async (h) => (await h.get<{ repos: { state: LandingBatchState }[] }>('/api/landing-batches')).repos[0]?.state,
    close: async () => { await github.close(); db.cleanup(); },
  };
  return w;
}

const events = async (h: CrashHost, type: string): Promise<DomainEvent[]> => (await h.get<{ events: DomainEvent[] }>(`/api/events?types=${type}&limit=1000`)).events;

/** Each pull request, revert and issue once; no branch or pull request of the hopper's left; the scenario's own end. */
export async function endedOnce(w: LandingWorld, h: CrashHost, s: LandingScenario): Promise<void> {
  const g = w.github;
  await w.drive(h, async () => s.done(await w.state(h), g), `the end of "${s.name}"`);
  const state = (await w.state(h))!;
  const pulls = [...g.pulls.values()];
  for (const head of new Set(pulls.map((p) => p.head))) expect(pulls.filter((p) => p.head === head), `the pull requests from ${head}`).toHaveLength(1);
  expect(new Set(g.issues.map((i) => i.title)).size, 'one issue of each title').toBe(g.issues.length);
  expect(pulls.filter((p) => p.state === 'open'), 'no pull request left open').toEqual([]);
  expect([...g.branches.keys()].filter((b) => b.startsWith('hopper-batch/')), 'no branch of the hopper left').toEqual([]);
  const counts = new Map<string, number>();
  for (const t of ['failed', 'bisect_started', 'culprit', 'revert_opened', 'reverted', 'fix_filed', 'promoted', 'back_merge_opened', 'back_merged', 'back_merge_issue_filed', 'canary_started', 'canary_promoted', 'canary_issue_filed']) {
    counts.set(`landing_batch.${t}`, (await events(h, `landing_batch.${t}`)).length);
  }
  s.end(state, g, (type) => counts.get(type) ?? 0);
}

/** The scenario with no kill: one hopper to its end. Answers the writes it made, in order. */
export async function cleanRun(w: LandingWorld, s: LandingScenario): Promise<string[]> {
  const a = await w.host({ connect: true });
  await endedOnce(w, a, s);
  return [...w.github.writes];
}

/** The scenario: a first hopper killed at `point`, after a GitHub write and before its event; a second one ends it. */
export async function killedThenEnded(w: LandingWorld, s: LandingScenario, point: string): Promise<void> {
  const a = await w.host({ killPoint: point, connect: true });
  await w.drive(a, async () => false, `the kill at ${point}`);
  await killedAt(a, point.split('#')[0]!);
  await endedOnce(w, await w.host(), s);
}

/**
 * The tests of the scenario `key`: its clean run when `from` is 0, and a kill at each of its points from `from` up to
 * `to`. A scenario's tests run one after the other in their file, so a long scenario is split over files: the shards of
 * the pull request check then share it, inside their 10 minutes.
 */
export function describeLanding(key: string, from = 0, to?: number): void {
  const s = LANDING_SCENARIOS.find((x) => x.key === key);
  if (!s) throw new Error(`no landing scenario "${key}"`);
  const worlds: LandingWorld[] = [];
  describe(s.name, () => {
    afterEach(async () => {
      await stopHosts();
      for (const w of worlds.splice(0)) await w.close();
    });
    if (from === 0) {
      it('a clean run: its writes are the kill points, and it ends with each effect once', async () => {
        const w = await landingWorld(s);
        worlds.push(w);
        expect(pointsOf(await cleanRun(w, s))).toEqual(s.points);
      }, SCENARIO_MS);
    }
    for (const point of s.points.slice(from, to)) {
      it(`killed at ${point}: the next hopper ends the batch, each effect once`, async () => {
        const w = await landingWorld(s);
        worlds.push(w);
        await killedThenEnded(w, s, point);
      }, SCENARIO_MS);
    }
  });
}
