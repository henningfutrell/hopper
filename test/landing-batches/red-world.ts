// The fake GitHub of a red batch (issue #1073 part 2) at the LandingBatchGitHub seam, and a runner over it with its
// events in memory. Shared by red.test.ts and cut-off.test.ts.
import type { LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';

export const REPO = 'owner/app';
export const SETTINGS: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 2, everyMinutes: 60 } } };

export interface Pull { head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; url: string; headSha: string; body: string; mergeSha?: string }
export interface Commit { sha: string; parents: string[]; message: string }

export interface World {
  tip: string;
  commits: Commit[];
  pulls: Map<number, Pull>;
  /** Check runs per sha. */
  checks: Map<string, { name: string; status: string; conclusion?: string; id?: number }[]>;
  logs: Map<number, string>;
  issues: { title: string; body: string; labels: string[]; assignees: string[] }[];
  calls: string[];
  next: number;
  /** What GitHub's merge of the tested branch into a back-merge branch answers. */
  backMerge: 'merged' | 'conflict' | 'nothing';
}

export const merged = (n: number, sha: string, body = ''): [number, Pull] =>
  [n, { head: `issue-${n}`, base: 'main', state: 'closed', merged: true, mergeable: null, url: `https://github.test/${REPO}/pull/${n}`, headSha: `h${n}`, body, mergeSha: sha }];

export function world(commits: Commit[], pulls: [number, Pull][] = []): World {
  return { tip: commits.at(-1)!.sha, commits, pulls: new Map(pulls), checks: new Map(), logs: new Map(), issues: [], calls: [], next: 100, backMerge: 'merged' };
}

export function fake(w: World): LandingBatchGitHub {
  const url = (n: number): string => `https://github.test/${REPO}/pull/${n}`;
  return {
    compare: async () => ({ aheadBy: w.commits.length, tip: w.tip, commits: w.commits }),
    createBranch: async (_repo, name, sha) => { w.calls.push(`branch ${name} ${sha}`); },
    deleteBranch: async (_repo, name) => { w.calls.push(`delete ${name}`); },
    openPullRequest: async (_repo, p) => {
      const n = w.next++;
      const sha = p.head.startsWith('hopper-batch/bisect-') ? w.commits.find((c) => p.head.endsWith(c.sha.slice(0, 12)))!.sha
        : p.head.startsWith('hopper-batch/back-merge-') ? 'backmerge0000000' : w.tip;
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
    mergeInto: async (_repo, base, head) => {
      w.calls.push(`merge ${head} into ${base}: ${w.backMerge}`);
      return w.backMerge === 'merged' ? { kind: 'merged', sha: 'backmerge0000000' } : { kind: w.backMerge };
    },
    openPullRequests: async () => [],
    findIssue: async () => undefined,
    retarget: async () => {},
    comment: async () => {},
    pullRequestOf: async (_repo, sha) => [...w.pulls.entries()].find(([, p]) => p.merged && p.mergeSha === sha)?.[0],
    revert: async (_repo, n, t) => {
      const r = w.next++;
      w.pulls.set(r, { head: `revert-${n}`, base: 'main', state: 'open', merged: false, mergeable: true, url: url(r), headSha: `rh${r}`, body: t.body });
      w.calls.push(`revert #${n} as #${r}: ${t.title}`);
      return { number: r, url: url(r) };
    },
    checkLog: async (_repo, id) => { const l = w.logs.get(id); if (l === undefined) throw new Error('no log'); return l; },
    fileIssue: async (_repo, issue) => { w.issues.push(issue); w.calls.push(`issue ${issue.title}`); return { number: 900 + w.issues.length, url: `https://github.test/${REPO}/issues/${900 + w.issues.length}` }; },
    bugReports: async () => [],
    fastForward: async () => { throw new Error('no canary here'); },
  };
}

export function runner(w: World, clock: { now: Date }) {
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

export const fail = (id: number) => [{ name: 'test', status: 'completed', conclusion: 'failure', id }];
export const pass = [{ name: 'test', status: 'completed', conclusion: 'success', id: 1 }];
export const P1 = 'p1aaaaaaaaaaaaaaaa';
export const P2 = 'p2bbbbbbbbbbbbbbbb';
export const P3 = 'p3cccccccccccccccc';
