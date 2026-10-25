// Landing batches (issue #1073, design.md "Landing batches"): a job's pull request merges into the **landing branch** —
// a setting per repository, `main` when left out, whatever the repository's default branch (issue #1142) — after the
// fast checks only. The full suite runs
// on the landing branch's tip as a **batch run**: a pull request of the tip into the **tested branch** (`dev`), opened
// by the hopper after `everyMerges` merges or `everyMinutes` minutes since the last batch run, and only when the landing
// branch has something the tested branch lacks and the tip was not tested before. Green, the hopper merges it: the
// tested branch moves by the whole batch in one merge. Red, it is recorded and closed; failing checks start a bisect
// within the batch (part 2, `landing-bisect.ts`); merge conflicts start a back-merge (part 4, `landing-back-merge.ts`);
// `beta` → `stable` goes through a canary (part 5, `landing-canary.ts`). Each step is an event (`landing_batch.*`); the
// state of each repository is reduced from them. Pure.
import { reduceBackMerge, type BackMergeState } from './landing-back-merge.ts';
import { reduceCanary, type CanaryState } from './landing-canary.ts';
import type { Bisect, BisectResult, Culprit, FailedCheck } from './landing-bisect.ts';
import type { DomainEvent } from './types.ts';

/** One repository's landing batches: the branch a green batch moves, and when a batch run starts. */
export interface LandingBatchRepo {
  /** The tested branch: what a green batch run merges into (`dev`). Never the landing branch. */
  tested: string;
  /** The landing branch: where job pull requests merge and what a batch run tests (issue #1142). Absent (saved before it): `main`. */
  landing?: string;
  /** A batch run starts after this many merges into the landing branch since the last one. */
  everyMerges: number;
  /** A batch run starts this many minutes after the last one, when the landing branch has something new. */
  everyMinutes: number;
  /** The canary window (part 5), in hours: a candidate on `canary` goes to `stable` after it. Absent: no canary step. */
  canaryHours?: number;
}

/** Per repository, `owner/repo` lowercased. A repository not named has no landing batches. */
export interface LandingBatchSettings { repos: Record<string, LandingBatchRepo> }

export const DEFAULT_LANDING_BATCHES: LandingBatchSettings = { repos: {} };
export const DEFAULT_LANDING_BRANCH = 'main';
export const DEFAULT_EVERY_MERGES = 5;
export const DEFAULT_EVERY_MINUTES = 60;
/** A batch run with no check after this many minutes is red: no full suite ran. */
export const BATCH_NO_CHECKS_MINUTES = 30;
/**
 * Branches no job pushes to, whatever the repository's default branch is: the release branches, and the canary (issue #1073
 * part 5). A pull request from one (a promotion) is no issue's work (issue #876).
 */
export const RELEASE_BRANCHES: readonly string[] = ['main', 'master', 'dev', 'beta', 'canary', 'stable'];
/** The prefix of a batch run's branch. No job pushes to it (src/github-proxy/git.ts `checkPush`). */
export const BATCH_BRANCH_PREFIX = 'hopper-batch/';

/** A change: per repository, the parts to set (`canaryHours` `null`: no canary step), or `null` to take its landing batches away. */
export interface LandingBatchPatch { repos: Record<string, (Partial<Omit<LandingBatchRepo, 'canaryHours'>> & { canaryHours?: number | null }) | null> }

const key = (repo: string): string => repo.toLowerCase();

/** A repository's landing branch: the one its settings name, else `main`. Never read from GitHub's default branch (issue #1142). */
export const landingBranch = (cfg: LandingBatchRepo): string => cfg.landing ?? DEFAULT_LANDING_BRANCH;

export function patchLandingBatches(s: LandingBatchSettings, p: LandingBatchPatch): LandingBatchSettings {
  const repos = { ...s.repos };
  for (const [repo, v] of Object.entries(p.repos)) {
    const k = key(repo);
    if (v === null) { delete repos[k]; continue; }
    const was = repos[k];
    const tested = v.tested ?? was?.tested;
    if (tested === undefined) continue;
    const canaryHours = v.canaryHours === null ? undefined : v.canaryHours ?? was?.canaryHours;
    repos[k] = {
      tested, landing: v.landing ?? was?.landing ?? DEFAULT_LANDING_BRANCH, everyMerges: v.everyMerges ?? was?.everyMerges ?? DEFAULT_EVERY_MERGES, everyMinutes: v.everyMinutes ?? was?.everyMinutes ?? DEFAULT_EVERY_MINUTES,
      ...(canaryHours !== undefined ? { canaryHours } : {}),
    };
  }
  return { repos: Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b))) };
}

/** A batch run at work: its tip, branch and pull request. */
export interface RunningBatch { tip: string; branch: string; pullRequest: number; url: string; startedAt: string; merges: number[] }

/**
 * A batch run the hopper starts (issue #1589): recorded before its branch and pull request, so a pass that stops between
 * them and their record starts the same batch run, and finds its pull request by its head branch.
 */
export interface DueBatch { tip: string; branch: string; landing: string; merges: number[]; closes: string[]; why: string }

/** Where one repository's landing batches stand, from its events. */
export interface LandingBatchState extends BackMergeState, CanaryState {
  repo: string;
  /** The newest tip a batch run ended on, green or red: it does not run again. */
  lastTestedTip?: string;
  /** The newest tip a green batch run moved the tested branch to. */
  lastPromotedTip?: string;
  /** When the newest batch run started: the timer counts from it. */
  lastStartedAt?: string;
  running?: RunningBatch;
  /** A batch run due, not started yet (issue #1589). */
  due?: DueBatch;
  /** The pull requests of the batch and bisect runs that ended (issue #1589): each pass closes the ones still open. */
  closedRuns?: number[];
  /** The newest tip whose batch runs were cut off (issue #2086), and how many in a row: it runs again up to BATCH_RERUNS times. */
  cutOff?: { tip: string; runs: number; pullRequest: number };
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
  /** A person restarted the batch since the newest batch run started (issue #1333): the next one starts at once, the same tip too. */
  restarted?: { at: string; by: string };
  /** The pull requests merged into the landing branch that wait for a batch run, as last recorded (part 3); none once one starts. */
  pending?: { tip: string; merges: number[] };
  /** Where `beta` was last seen ahead of `canary` (issue #2775 part 10): its tip, and when. */
  beta?: { tip: string; at: string };
}

export const LANDING_BATCH_EVENT_TYPES = [
  'landing_batch.due', 'landing_batch.started', 'landing_batch.promoted', 'landing_batch.failed', 'landing_batch.retargeted', 'landing_batches.changed',
  'landing_batch.bisect_started', 'landing_batch.bisect_run', 'landing_batch.bisect_tested', 'landing_batch.culprit',
  'landing_batch.revert_opened', 'landing_batch.reverted', 'landing_batch.revert_failed', 'landing_batch.fix_filed',
  'landing_batch.pending', 'landing_batch.back_merge_opened', 'landing_batch.back_merged', 'landing_batch.back_merge_failed',
  'landing_batch.back_merge_issue_filed', 'landing_batch.canary_started', 'landing_batch.canary_held', 'landing_batch.canary_issue_filed',
  'landing_batch.canary_promoted', 'landing_batch.beta_moved', 'landing_batch.stuck', 'landing_batch.restarted',
] as const;

/** A batch or bisect run that ended: its pull request stays closed. */
function closeRun(s: LandingBatchState, pullRequest: unknown): void {
  if (typeof pullRequest === 'number' && !s.closedRuns?.includes(pullRequest)) (s.closedRuns ??= []).push(pullRequest);
}

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
    closeRun(s, d.pullRequest);
    const r: BisectResult = { index: Number(d.index), sha: String(d.sha), outcome: d.outcome === 'good' ? 'good' : d.outcome === 'bad' ? 'bad' : 'unknown' };
    delete b.running;
    // A cut-off bisect run (issue #2086) says nothing of the point: it runs again, BATCH_RERUNS times at most.
    const cut = b.cutOff?.[r.index] ?? 0;
    if (d.cutOff === true && cut < BATCH_RERUNS) { (b.cutOff ??= {})[r.index] = cut + 1; return; }
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
    if (e.type === 'landing_batch.due') {
      s.due = { tip, branch: String(d.branch), landing: String(d.landing), merges: (d.merges as number[] | undefined) ?? [], closes: (d.closes as string[] | undefined) ?? [], why: String(d.why ?? '') };
    } else if (e.type === 'landing_batch.started') {
      delete s.due;
      s.lastStartedAt = e.at;
      s.running = { tip, branch: String(d.branch), pullRequest: Number(d.pullRequest), url: String(d.url), startedAt: e.at, merges: (d.merges as number[] | undefined) ?? [] };
      delete s.revertedSinceRun;
      delete s.backMergedSinceRun;
      delete s.restarted;
      delete s.pending;
    } else if (e.type === 'landing_batch.pending') {
      s.pending = { tip, merges: (d.merges as number[] | undefined) ?? [] };
    } else if (e.type === 'landing_batch.promoted' || e.type === 'landing_batch.failed') {
      const outcome = e.type === 'landing_batch.promoted' ? 'promoted' : 'failed';
      s.lastTestedTip = tip;
      if (outcome === 'promoted') { s.lastPromotedTip = tip; delete s.backMergeIssue; }
      if (s.running?.tip === tip) delete s.running;
      if (outcome === 'failed') closeRun(s, d.pullRequest);
      if (d.cutOff === true) s.cutOff = { tip, runs: s.cutOff?.tip === tip ? s.cutOff.runs + 1 : 1, pullRequest: Number(d.pullRequest) };
      else delete s.cutOff;
      // Merge conflicts: a back-merge is due, recorded with the failure (issue #1589).
      if (d.conflicts === true) s.backMerge = { tip, state: 'due', batch: Number(d.pullRequest), at: e.at };
      s.last = { outcome, tip, at: e.at, pullRequest: Number(d.pullRequest), url: String(d.url), ...(typeof d.reason === 'string' ? { reason: d.reason } : {}) };
    } else if (e.type === 'landing_batch.restarted') {
      // A person ended the batch run and the bisect at work (issue #1333).
      for (const n of (d.closed as number[] | undefined) ?? []) closeRun(s, n);
      delete s.running;
      delete s.bisect;
      s.restarted = { at: e.at, by: String(d.by ?? '') };
    } else if (e.type === 'landing_batch.beta_moved') {
      s.beta = { tip, at: e.at };
    } else if (e.type === 'landing_batch.stuck') {
      // Only said: what is stuck is the runner's, in memory.
    } else if (e.type.startsWith('landing_batch.back_merge')) reduceBackMerge(s, e.type, d, e.at);
    else if (e.type.startsWith('landing_batch.canary_')) reduceCanary(s, e.type, d, e.at);
    else reduceRed(s, e.type, d, e.at);
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
  if (s?.due) return { due: false, why: `the batch run of ${short(s.due.tip)} starts` };
  if (s?.bisect) return { due: false, why: `a bisect of the batch at ${short(s.bisect.tip)} is at work` };
  const c = s?.culprit;
  if (c?.pullRequest !== undefined && c.revertProblem === undefined && c.revert?.state !== 'merged') {
    return { due: false, why: c.revert ? `the revert #${c.revert.pullRequest} of #${c.pullRequest} waits to merge` : `the revert of #${c.pullRequest} is not open yet` };
  }
  if (s?.backMerge?.state === 'due') return { due: false, why: `the merge of ${cfg.tested} into the landing branch starts` };
  if (s?.backMerge?.state === 'open') return { due: false, why: `the merge of ${cfg.tested} into the landing branch (#${s.backMerge.pullRequest}) waits to merge` };
  if (f.aheadBy <= 0) return { due: false, why: `nothing new on the landing branch beyond ${cfg.tested}` };
  if (s?.restarted) return { due: true, why: 'a person restarted the landing batch' };
  if (s?.cutOff?.tip === f.tip && s.cutOff.runs <= BATCH_RERUNS) {
    return { due: true, why: `batch run #${s.cutOff.pullRequest} was cut off: run ${s.cutOff.runs + 1} of ${BATCH_RERUNS + 1}` };
  }
  if (s?.lastTestedTip === f.tip) return { due: false, why: `the landing branch tip ${short(f.tip)} was tested already` };
  if (s?.lastStartedAt === undefined) return { due: true, why: 'no batch run before' };
  if (s.revertedSinceRun && c) return { due: true, why: `the culprit ${c.pullRequest !== undefined ? `#${c.pullRequest}` : short(c.sha)} was reverted` };
  if (s.backMergedSinceRun) return { due: true, why: `${cfg.tested} was merged into the landing branch` };
  if (f.merges >= cfg.everyMerges) return { due: true, why: `${f.merges} merges since the last batch run` };
  const minutes = Math.floor((now.getTime() - Date.parse(s.lastStartedAt)) / 60_000);
  if (minutes >= cfg.everyMinutes) return { due: true, why: `${minutes} minutes since the last batch run` };
  return { due: false, why: `${f.merges} of ${cfg.everyMerges} merges, or ${cfg.everyMinutes - minutes} more minutes` };
}

/** One check run on a batch run's tip, as GitHub answers it. */
export interface BatchCheckRun { name: string; status: string; conclusion?: string | null; id?: number }

const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
/** A cut-off check (issue #2086): GitHub cancelled it, or it passed its time limit. No test failed in it. */
const CUT_OFF = new Set(['cancelled', 'timed_out']);
/** How many times a batch run, or a bisect run of one point, with a cut-off check runs again (issue #2086). */
export const BATCH_RERUNS = 2;

const failedCheck = (r: BatchCheckRun): FailedCheck => (r.id !== undefined ? { name: r.name, id: r.id } : { name: r.name });

/**
 * What a batch run's checks say: pending, green (every one passed), cut off, or red with why. Cut off (issue #2086): a
 * check was cancelled or timed out, so the run says nothing of the tests; the check to require fails with it, so a cut-off
 * check outweighs every failed one, and the run runs again.
 */
export function batchChecks(runs: readonly BatchCheckRun[], pr: { mergeable: boolean | null }, startedAt: string, now: Date):
  { kind: 'pending' } | { kind: 'green' } | { kind: 'red' | 'cut-off'; reason: string; checks: FailedCheck[] } {
  if (pr.mergeable === false) return { kind: 'red', reason: 'the batch has merge conflicts with the tested branch', checks: [] };
  const done = runs.filter((r) => r.status === 'completed');
  const cut = done.filter((r) => CUT_OFF.has(r.conclusion ?? '')).map(failedCheck);
  if (cut.length > 0) return { kind: 'cut-off', reason: `checks cut off: ${cut.map((c) => c.name).join(', ')}`, checks: cut };
  const failed = done.filter((r) => RED.has(r.conclusion ?? '')).map(failedCheck);
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

/** GitHub's closing keywords, each before one issue reference: `#N`, `owner/name#N`, or the issue's URL. */
const CLOSING_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b|([\w.-]+\/[\w.-]+)?#(\d+)\b)/gi;

/**
 * The issues a pull request's text closes (issue #1356), as GitHub's closing references from `repo`: `#N` for an issue
 * of `repo`, `owner/name#N` for one of another repository, in the order the text names them, once each. A batch run's
 * text names them again, so its merge into the tested branch closes them whatever the ledger knows of their items.
 */
export function closingReferences(body: string, repo: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(CLOSING_REF)) {
    const of = m[1] ?? m[3];
    const n = Number(m[2] ?? m[4]);
    const ref = !of || of.toLowerCase() === repo.toLowerCase() ? `#${n}` : `${of}#${n}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** A batch run's branch: the prefix and the tip's first 12 characters. */
export const batchBranch = (tip: string): string => `${BATCH_BRANCH_PREFIX}${short(tip)}`;

export const batchTitle = (b: { landing: string; tested: string; tip: string }): string =>
  `Batch run: ${b.landing} at ${short(b.tip)} into ${b.tested}`;

/**
 * A batch run's pull request text: neutral, what it carries and what happens to it. `closes` (issue #1175): a closing
 * keyword for each issue its job pull requests close, so its merge into the tested branch (the default branch) closes them.
 */
export function batchBody(b: { landing: string; tested: string; tip: string; merges: readonly number[]; closes?: readonly string[] }): string {
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
    ...(b.closes && b.closes.length > 0 ? ['', ...b.closes.map((ref) => `Closes ${ref}`)] : []),
  ].join('\n');
}

/** As GET /api/landing-batches answers it: the settings, the job repositories, and each configured repository's state. */
export interface LandingBatchesView {
  settings: LandingBatchSettings;
  choices: { repos: string[] };
  repos: LandingBatchRepoView[];
}

/** A landing pass that failed the same way on `passes` passes in a row, since `since` (issue #1333). */
export interface LandingBatchStuck { error: string; since: string; passes: number }

/** One configured repository: its settings, state, and what the last pass found (why no run, or a problem). */
export interface LandingBatchRepoView {
  repo: string;
  config: LandingBatchRepo;
  state: LandingBatchState;
  why?: string;
  problem?: string;
  checkedAt?: string;
  /** The same problem on several passes in a row (issue #1333): the landing pass is stuck. */
  stuck?: LandingBatchStuck;
  /** What the last pass found of the canary (part 5), when its window is set. */
  canary?: { why?: string; problem?: string; checkedAt: string };
}
