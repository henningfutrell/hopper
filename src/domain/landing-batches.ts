// Landing batches (issue #1073, design.md "Landing batches"): a job's pull request merges into the **landing branch** —
// the repository's default branch, `main` for the hopper's own — after the fast checks only. The full suite runs
// on the landing branch's tip as a **batch run**: a pull request of the tip into the **tested branch** (`dev`), opened
// by the hopper after `everyMerges` merges or `everyMinutes` minutes since the last batch run, and only when the landing
// branch has something the tested branch lacks and the tip was not tested before. Green, the hopper merges it: the
// tested branch moves by the whole batch in one merge. Red, it is recorded and closed; failing checks start a bisect
// within the batch (part 2, `landing-bisect.ts`). Each step is an event (`landing_batch.*`); the state of each
// repository is reduced from them. Pure.
import type { Bisect, BisectResult, Culprit, FailedCheck } from './landing-bisect.ts';
import type { DomainEvent } from './types.ts';

/** One repository's landing batches: the branch a green batch moves, and when a batch run starts. */
export interface LandingBatchRepo {
  /** The tested branch: what a green batch run merges into (`dev`). Never the repository's default branch. */
  tested: string;
  /** A batch run starts after this many merges into the landing branch since the last one. */
  everyMerges: number;
  /** A batch run starts this many minutes after the last one, when the landing branch has something new. */
  everyMinutes: number;
}

/** Per repository, `owner/repo` lowercased. A repository not named has no landing batches. */
export interface LandingBatchSettings { repos: Record<string, LandingBatchRepo> }

export const DEFAULT_LANDING_BATCHES: LandingBatchSettings = { repos: {} };
export const DEFAULT_EVERY_MERGES = 5;
export const DEFAULT_EVERY_MINUTES = 60;
/** A batch run with no check after this many minutes is red: no full suite ran. */
export const BATCH_NO_CHECKS_MINUTES = 30;
/** The prefix of a batch run's branch. No job pushes to it (src/github-proxy/git.ts `checkPush`). */
export const BATCH_BRANCH_PREFIX = 'hopper-batch/';

/** A change: per repository, the parts to set, or `null` to take its landing batches away. */
export interface LandingBatchPatch { repos: Record<string, Partial<LandingBatchRepo> | null> }

const key = (repo: string): string => repo.toLowerCase();

export function patchLandingBatches(s: LandingBatchSettings, p: LandingBatchPatch): LandingBatchSettings {
  const repos = { ...s.repos };
  for (const [repo, v] of Object.entries(p.repos)) {
    const k = key(repo);
    if (v === null) { delete repos[k]; continue; }
    const was = repos[k];
    const tested = v.tested ?? was?.tested;
    if (tested === undefined) continue;
    repos[k] = { tested, everyMerges: v.everyMerges ?? was?.everyMerges ?? DEFAULT_EVERY_MERGES, everyMinutes: v.everyMinutes ?? was?.everyMinutes ?? DEFAULT_EVERY_MINUTES };
  }
  return { repos: Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b))) };
}

/** A batch run at work: its tip, branch and pull request. */
export interface RunningBatch { tip: string; branch: string; pullRequest: number; url: string; startedAt: string; merges: number[] }

/** Where one repository's landing batches stand, from its events. */
export interface LandingBatchState {
  repo: string;
  /** The newest tip a batch run ended on, green or red: it does not run again. */
  lastTestedTip?: string;
  /** The newest tip a green batch run moved the tested branch to. */
  lastPromotedTip?: string;
  /** When the newest batch run started: the timer counts from it. */
  lastStartedAt?: string;
  running?: RunningBatch;
  /** How the newest batch run ended. */
  last?: { outcome: 'promoted' | 'failed'; tip: string; at: string; pullRequest: number; url: string; reason?: string };
  /** A bisect at work within the newest red batch. */
  bisect?: Bisect;
  /** Why the newest bisect ended with no culprit. */
  bisectEnded?: { tip: string; reason: string; at: string };
  /** The newest culprit, its revert and its fix issue. */
  culprit?: Culprit;
  /** A culprit's revert merged since the newest batch run started: the next one starts at once. */
  revertedSinceRun?: boolean;
  /** The pull requests merged into the landing branch that wait for a batch run, as last recorded (part 3); none once one starts. */
  pending?: { tip: string; merges: number[] };
}

export const LANDING_BATCH_EVENT_TYPES = [
  'landing_batch.started', 'landing_batch.promoted', 'landing_batch.failed', 'landing_batch.retargeted', 'landing_batches.changed',
  'landing_batch.bisect_started', 'landing_batch.bisect_run', 'landing_batch.bisect_tested', 'landing_batch.culprit',
  'landing_batch.revert_opened', 'landing_batch.reverted', 'landing_batch.revert_failed', 'landing_batch.fix_filed',
  'landing_batch.pending',
] as const;

/** A red batch's events onto the state: the bisect, its runs and results, the culprit, its revert and its fix issue. */
function reduceRed(s: LandingBatchState, type: string, d: Record<string, unknown>, at: string): void {
  const tip = String(d.tip ?? '');
  const b = s.bisect?.tip === tip ? s.bisect : undefined;
  const c = s.culprit?.tip === tip && s.culprit.sha === d.sha ? s.culprit : undefined;
  const checks = (d.checks as FailedCheck[] | undefined) ?? [];
  if (type === 'landing_batch.bisect_started') {
    const points = (d.points as Bisect['points'] | undefined) ?? [];
    s.bisect = { tip, tested: String(d.tested), ...(typeof d.pullRequest === 'number' ? { batch: d.pullRequest } : {}), points, good: -1, bad: points.length - 1, checks: { [points.length - 1]: checks }, reason: String(d.reason ?? ''), startedAt: at, results: [] };
    delete s.bisectEnded;
  } else if (type === 'landing_batch.bisect_run' && b) {
    b.running = { index: Number(d.index), sha: String(d.sha), branch: String(d.branch), pullRequest: Number(d.pullRequest), url: String(d.url), startedAt: at };
  } else if (type === 'landing_batch.bisect_tested' && b) {
    const r: BisectResult = { index: Number(d.index), sha: String(d.sha), outcome: d.outcome === 'good' ? 'good' : d.outcome === 'bad' ? 'bad' : 'unknown' };
    delete b.running;
    b.results.push(r);
    if (r.outcome === 'good') b.good = r.index;
    else if (r.outcome === 'bad') { b.bad = r.index; b.checks[r.index] = checks; } else {
      delete s.bisect;
      s.bisectEnded = { tip, reason: String(d.reason ?? ''), at };
    }
  } else if (type === 'landing_batch.culprit') {
    delete s.bisect;
    s.culprit = {
      tip, sha: String(d.sha), ...(typeof d.pullRequest === 'number' ? { pullRequest: d.pullRequest } : {}), ...(typeof d.batch === 'number' ? { batch: d.batch } : {}), checks,
      reason: String(d.reason ?? ''), at, results: (d.results as BisectResult[] | undefined) ?? [],
    };
  } else if (type === 'landing_batch.revert_opened' && c) {
    c.revert = { pullRequest: Number(d.pullRequest), url: String(d.url), state: 'open' };
    c.pullRequest = Number(d.culpritPullRequest);
  } else if (type === 'landing_batch.reverted' && c) {
    c.revert = { pullRequest: Number(d.pullRequest), url: String(d.url), state: 'merged' };
    s.revertedSinceRun = true;
  } else if (type === 'landing_batch.revert_failed' && c) {
    c.revertProblem = String(d.reason ?? '');
  } else if (type === 'landing_batch.fix_filed' && c) {
    c.fix = { issue: Number(d.issue), url: String(d.url) };
  }
}

/** Each repository's state, from its `landing_batch.*` events in any order (they are sorted by `seq`). */
export function landingBatchStates(events: readonly DomainEvent[]): Record<string, LandingBatchState> {
  const out: Record<string, LandingBatchState> = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = e.data as Record<string, unknown>;
    if (typeof d.repo !== 'string') continue;
    const repo = key(d.repo);
    const s = (out[repo] ??= { repo });
    const tip = String(d.tip ?? '');
    if (e.type === 'landing_batch.started') {
      s.lastStartedAt = e.at;
      s.running = { tip, branch: String(d.branch), pullRequest: Number(d.pullRequest), url: String(d.url), startedAt: e.at, merges: (d.merges as number[] | undefined) ?? [] };
      delete s.revertedSinceRun;
      delete s.pending;
    } else if (e.type === 'landing_batch.pending') {
      s.pending = { tip, merges: (d.merges as number[] | undefined) ?? [] };
    } else if (e.type === 'landing_batch.promoted' || e.type === 'landing_batch.failed') {
      const outcome = e.type === 'landing_batch.promoted' ? 'promoted' : 'failed';
      s.lastTestedTip = tip;
      if (outcome === 'promoted') s.lastPromotedTip = tip;
      if (s.running?.tip === tip) delete s.running;
      s.last = { outcome, tip, at: e.at, pullRequest: Number(d.pullRequest), url: String(d.url), ...(typeof d.reason === 'string' ? { reason: d.reason } : {}) };
    } else reduceRed(s, e.type, d, e.at);
  }
  return out;
}

/** Whether the merges that wait for a batch run are news: some wait, and they differ from the last ones recorded. */
export function pendingChanged(s: LandingBatchState | undefined, merges: readonly number[]): boolean {
  return merges.length > 0 && JSON.stringify(s?.pending?.merges ?? []) !== JSON.stringify(merges);
}

/** What the landing branch has that the tested branch lacks: its tip, its commits ahead, and the merges among them. */
export interface LandingFacts { tip: string; aheadBy: number; merges: number }

const short = (sha: string): string => sha.slice(0, 12);

/** Whether a batch run starts now, and why (or why not). */
export function batchDue(s: LandingBatchState | undefined, f: LandingFacts, cfg: LandingBatchRepo, now: Date): { due: boolean; why: string } {
  if (s?.running) return { due: false, why: `batch run #${s.running.pullRequest} is at work` };
  if (s?.bisect) return { due: false, why: `a bisect of the batch at ${short(s.bisect.tip)} is at work` };
  const c = s?.culprit;
  if (c?.pullRequest !== undefined && c.revertProblem === undefined && c.revert?.state !== 'merged') {
    return { due: false, why: c.revert ? `the revert #${c.revert.pullRequest} of #${c.pullRequest} waits to merge` : `the revert of #${c.pullRequest} is not open yet` };
  }
  if (f.aheadBy <= 0) return { due: false, why: `nothing new on the landing branch beyond ${cfg.tested}` };
  if (s?.lastTestedTip === f.tip) return { due: false, why: `the landing branch tip ${short(f.tip)} was tested already` };
  if (s?.lastStartedAt === undefined) return { due: true, why: 'no batch run before' };
  if (s.revertedSinceRun && c) return { due: true, why: `the culprit ${c.pullRequest !== undefined ? `#${c.pullRequest}` : short(c.sha)} was reverted` };
  if (f.merges >= cfg.everyMerges) return { due: true, why: `${f.merges} merges since the last batch run` };
  const minutes = Math.floor((now.getTime() - Date.parse(s.lastStartedAt)) / 60_000);
  if (minutes >= cfg.everyMinutes) return { due: true, why: `${minutes} minutes since the last batch run` };
  return { due: false, why: `${f.merges} of ${cfg.everyMerges} merges, or ${cfg.everyMinutes - minutes} more minutes` };
}

/** One check run on a batch run's tip, as GitHub answers it. */
export interface BatchCheckRun { name: string; status: string; conclusion?: string | null; id?: number }

const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/** What a batch run's checks say: pending, green (every one passed), or red with why. */
export function batchChecks(runs: readonly BatchCheckRun[], pr: { mergeable: boolean | null }, startedAt: string, now: Date):
  { kind: 'pending' } | { kind: 'green' } | { kind: 'red'; reason: string; checks: FailedCheck[] } {
  if (pr.mergeable === false) return { kind: 'red', reason: 'the batch has merge conflicts with the tested branch', checks: [] };
  const failed = runs.filter((r) => r.status === 'completed' && RED.has(r.conclusion ?? '')).map((r): FailedCheck => (r.id !== undefined ? { name: r.name, id: r.id } : { name: r.name }));
  if (failed.length > 0) return { kind: 'red', reason: `checks failed: ${failed.map((f) => f.name).join(', ')}`, checks: failed };
  if (runs.length === 0) {
    return now.getTime() - Date.parse(startedAt) >= BATCH_NO_CHECKS_MINUTES * 60_000
      ? { kind: 'red', reason: `no check ran in ${BATCH_NO_CHECKS_MINUTES} minutes`, checks: [] }
      : { kind: 'pending' };
  }
  return runs.every((r) => r.status === 'completed') ? { kind: 'green' } : { kind: 'pending' };
}

/** The pull requests the landing branch merged, from its merge commits' messages, oldest first, once each. */
export function mergedPullRequests(messages: readonly string[]): number[] {
  const out: number[] = [];
  for (const m of messages) {
    const n = /^Merge pull request #(\d+) /.exec(m);
    if (n && !out.includes(Number(n[1]))) out.push(Number(n[1]));
  }
  return out;
}

/** A batch run's branch: the prefix and the tip's first 12 characters. */
export const batchBranch = (tip: string): string => `${BATCH_BRANCH_PREFIX}${short(tip)}`;

export const batchTitle = (b: { landing: string; tested: string; tip: string }): string =>
  `Batch run: ${b.landing} at ${short(b.tip)} into ${b.tested}`;

/** A batch run's pull request text: neutral, what it carries and what happens to it. */
export function batchBody(b: { landing: string; tested: string; tip: string; merges: readonly number[] }): string {
  const list = b.merges.length > 0 ? b.merges.map((n) => `- #${n}`).join('\n') : '- (no pull request merges: direct commits only)';
  return [
    `A batch run of the landing branch \`${b.landing}\` at \`${short(b.tip)}\` into the tested branch \`${b.tested}\`.`,
    '',
    'The full test suite runs on it. When every check passes, the hopper merges it, so the batch moves to',
    `\`${b.tested}\` in one merge. When a check fails, the hopper closes it and records the failure.`,
    'Do not merge it by hand.',
    '',
    'Pull requests in this batch:',
    list,
  ].join('\n');
}

/** As GET /api/landing-batches answers it: the settings, the job repositories, and each configured repository's state. */
export interface LandingBatchesView {
  settings: LandingBatchSettings;
  choices: { repos: string[] };
  repos: LandingBatchRepoView[];
}

/** One configured repository: its settings, state, and what the last pass found (why no run, or a problem). */
export interface LandingBatchRepoView {
  repo: string;
  config: LandingBatchRepo;
  state: LandingBatchState;
  why?: string;
  problem?: string;
  checkedAt?: string;
}
