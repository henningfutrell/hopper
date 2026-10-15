// The batch runner (issue #1073, design.md "Landing batches"): one user's landing batches, one pass at start and every
// `LANDING_BATCH_PASS_MS`. For each repository the settings name: a job's open pull request on the tested branch moves
// to the landing branch (its settings name it, issue #1142); a batch run at work is read — green, merged into the tested branch at its
// tip; red, closed and recorded failed; either way its branch is removed —; failing checks start a bisect within the
// batch, and a pass takes its next step, then the culprit's revert and fix issue (`red.ts`); merge conflicts with the
// tested branch start a back-merge of it into the landing branch (`back-merge.ts`); with none of these at work,
// a batch run starts when due (`batchDue`), its text closing the issues of its job pull requests (issue #1175). With a canary window set, the canary step after it (`canary.ts`). Each step is an event, with the user's own GitHub connection. What the last
// pass found is kept in memory for the view: why no batch run started, or the problem.
import {
  BATCH_BRANCH_PREFIX, batchBody, batchBranch, batchChecks, batchDue, batchTitle, landingBatchStates, landingBranch, mergedPullRequests, pendingChanged,
  type BatchCheckRun, type LandingBatchRepo, type LandingBatchRepoView, type LandingBatchSettings, type LandingBatchStuck, type RunningBatch,
} from '../domain/landing-batches.ts';
import type { FailedCheck } from '../domain/landing-bisect.ts';
import type { DomainEvent, NewEvent } from '../domain/types.ts';
import { backMergePass, startBackMerge } from './back-merge.ts';
import { retargetNote } from '../sources/github/pr-notes.ts';
import { canaryPass } from './canary.ts';
import { bisectPass, culpritPass, startBisect, type RedPass } from './red.ts';

/** How often the runner passes: 2 minutes. */
export const LANDING_BATCH_PASS_MS = 2 * 60_000;

/** The GitHub calls of the batch runner. */
export interface LandingBatchGitHub {
  /** What `head` (a branch, or a commit's full sha) has that `base` lacks: commits ahead, `head`'s tip, and those commits. */
  compare(repo: string, base: string, head: string): Promise<{ aheadBy: number; tip: string; commits: { sha: string; parents: string[]; message: string }[] }>;
  createBranch(repo: string, name: string, sha: string): Promise<void>;
  deleteBranch(repo: string, name: string): Promise<void>;
  openPullRequest(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  pullRequest(repo: string, number: number): Promise<{ state: 'open' | 'closed'; merged: boolean; mergeable: boolean | null; headSha: string; base: string; url: string; body: string; mergeSha?: string }>;
  checkRuns(repo: string, sha: string): Promise<BatchCheckRun[]>;
  /** A merge commit, only while the head is `sha`. */
  merge(repo: string, number: number, sha: string, title: string): Promise<{ sha: string }>;
  close(repo: string, number: number): Promise<void>;
  /** GitHub's merge of `head` into the branch `base`: its merge commit, nothing to merge, or a conflict it cannot merge. */
  mergeInto(repo: string, base: string, head: string, message: string): Promise<{ kind: 'merged'; sha: string } | { kind: 'nothing' } | { kind: 'conflict' }>;
  /** The open pull requests into `base`, with the branch each comes from. */
  openPullRequests(repo: string, base: string): Promise<{ number: number; url: string; head: string }[]>;
  retarget(repo: string, number: number, base: string): Promise<void>;
  /** One comment on pull request `number`: what the hopper did with it (issue #1143). */
  comment(repo: string, number: number, body: string): Promise<void>;
  /** The merged pull request whose merge (or squash) commit is `sha`, when there is one. */
  pullRequestOf(repo: string, sha: string): Promise<number | undefined>;
  /** GitHub's revert of a merged pull request: a new pull request into its base, with this text. */
  revert(repo: string, number: number, text: { title: string; body: string }): Promise<{ number: number; url: string }>;
  /** The log of a GitHub Actions job, by its check run's id. */
  checkLog(repo: string, checkRunId: number): Promise<string>;
  fileIssue(repo: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<{ number: number; url: string }>;
  /** The bug reports (issues labelled `user-report`) filed since `since` whose text names the commit `sha` (12 characters). */
  bugReports(repo: string, sha: string, since: string): Promise<number[]>;
  /** Moves the branch to `sha`, only as a fast-forward. */
  fastForward(repo: string, branch: string, sha: string): Promise<void>;
}

/** Passes in a row that fail the same way before the landing pass is stuck (issue #1333): 3 passes, about 6 minutes. */
export const LANDING_BATCH_STUCK_PASSES = 3;

const stuckOf = (f: (LandingBatchStuck & { recorded: boolean }) | undefined): { stuck?: LandingBatchStuck } =>
  f && f.passes >= LANDING_BATCH_STUCK_PASSES ? { stuck: { error: f.error, since: f.since, passes: f.passes } } : {};

export interface LandingBatches {
  pass(): Promise<void>;
  /**
   * A person's restart of `repo`'s batch (issue #1333): recorded at once, with the pull requests it closes; `done` when
   * they are closed and a pass ran. Throws when `repo` has no landing batches or there is no GitHub connection.
   */
  restart(repo: string, by: string): { closed: number[]; done: Promise<void> };
  view(): { repos: LandingBatchRepoView[] };
  start(): void;
  /** Ends the timer, then waits for a pass in flight. */
  stop(): Promise<void>;
}

export function createLandingBatches(o: {
  github(): LandingBatchGitHub | { problem: string };
  /** The user's connected GitHub account: a fix issue is assigned to it. */
  login(): string | undefined;
  settings(): LandingBatchSettings;
  /** The user's `landing_batch.*` events. */
  events(): readonly DomainEvent[];
  record(event: NewEvent): void;
  /** The URLs of the pull requests the user's jobs named, followed or not (issue #1143): only those move to the landing branch. */
  jobPullRequests(): readonly string[];
  /** The issues the job pull requests `merges` close (issue #1175), as closing references from `repo`: named in the batch run's text. */
  closingIssues?(repo: string, merges: readonly number[]): string[];
  now(): Date;
  log(line: string): void;
  everyMs?: number;
}): LandingBatches {
  const found = new Map<string, { why?: string; problem?: string; checkedAt: string }>();
  const note = (repo: string, f: { why?: string; problem?: string }): void => { found.set(repo, { ...f, checkedAt: o.now().toISOString() }); };
  const canaryFound = new Map<string, { why?: string; problem?: string; checkedAt: string }>();
  // The pull requests GitHub refused to move (issue #1311), by URL with the refusal: logged once, not on every pass.
  const refused = new Map<string, string>();

  // A run of passes that failed the same way (issue #1333), per repository: recorded stuck once, at LANDING_BATCH_STUCK_PASSES.
  const failing = new Map<string, LandingBatchStuck & { recorded: boolean }>();

  /** The batch run at work: read, and merged on green or ended on red. */
  async function runningPass(gh: LandingBatchGitHub, repo: string, tested: string, landing: string, run: RunningBatch, red: RedPass): Promise<void> {
    const pr = await gh.pullRequest(repo, run.pullRequest);
    const ended = { repo, tested, tip: run.tip, pullRequest: run.pullRequest, url: run.url };
    const fail = async (reason: string, checks: FailedCheck[], close: boolean): Promise<void> => {
      if (close) await gh.close(repo, run.pullRequest);
      await gh.deleteBranch(repo, run.branch).catch((e: unknown) => o.log(`hopper: landing batches: ${run.branch} of ${repo} not removed: ${(e as Error).message}`));
      o.record({ type: 'landing_batch.failed', data: { ...ended, reason, checks: checks.map((c) => c.name), ...(checks.length > 0 ? { checkRuns: checks } : {}) } });
      note(repo, { why: reason });
      // Only failing checks say the batch itself fails: a bisect finds the first change that does.
      if (checks.length > 0) await startBisect(red, { tested, tip: run.tip, checks, reason, pullRequest: run.pullRequest, url: run.url });
    };
    if (pr.merged) {
      o.record({ type: 'landing_batch.promoted', data: ended });
      note(repo, { why: `batch run #${run.pullRequest} was merged` });
      return;
    }
    if (pr.state === 'closed') return fail('its pull request was closed without a merge', [], false);
    if (pr.headSha !== run.tip) return fail(`its branch moved from ${run.tip.slice(0, 12)}`, [], true);
    const checks = batchChecks(await gh.checkRuns(repo, run.tip), pr, run.startedAt, o.now());
    if (checks.kind === 'pending') { note(repo, { why: `batch run #${run.pullRequest} waits for its checks` }); return; }
    if (checks.kind === 'red') {
      await fail(checks.reason, checks.checks, true);
      // Merge conflicts: the tested branch has a change the landing branch lacks, merged into it by a back-merge.
      if (pr.mergeable === false) await startBackMerge(red, { tip: run.tip, batch: run.pullRequest });
      return;
    }
    const merged = await gh.merge(repo, run.pullRequest, run.tip, batchTitle({ landing, tested, tip: run.tip }));
    await gh.deleteBranch(repo, run.branch).catch((e: unknown) => o.log(`hopper: landing batches: ${run.branch} of ${repo} not removed: ${(e as Error).message}`));
    o.record({ type: 'landing_batch.promoted', data: { ...ended, merge: merged.sha } });
    note(repo, { why: `batch run #${run.pullRequest} moved ${tested} to ${run.tip.slice(0, 12)}` });
  }

  /** A job's pull request lands on the landing branch, never on the tested branch. */
  async function moveJobPullRequests(gh: LandingBatchGitHub, repo: string, tested: string, landing: string): Promise<void> {
    // The hopper's own (a batch run, a bisect, a back-merge) stays there, even when a job named it (issue #1311): its
    // branch is a landing branch tip.
    const jobs = new Set(o.jobPullRequests());
    for (const p of await gh.openPullRequests(repo, tested)) {
      if (!jobs.has(p.url) || p.head.startsWith(BATCH_BRANCH_PREFIX)) continue;
      // One refusal skips that pull request only: the others move, and the batch run goes on (issue #1311).
      const moved = await gh.retarget(repo, p.number, landing).then(() => true, (e: unknown) => {
        const why = (e as Error).message;
        if (refused.get(p.url) !== why) o.log(`hopper: landing batches: ${p.url} not moved to ${landing}: ${why}`);
        refused.set(p.url, why);
        return false;
      });
      if (!moved) continue;
      refused.delete(p.url);
      o.record({ type: 'landing_batch.retargeted', data: { repo, pullRequest: p.number, url: p.url, from: tested, to: landing } });
      // The pull request shows it (issue #1143); a refusal loses only the comment.
      await gh.comment(repo, p.number, retargetNote(tested, landing))
        .catch((e: unknown) => o.log(`hopper: landing batches: the note on ${p.url} was not posted: ${(e as Error).message}`));
    }
  }

  /** A batch run starts when due; else the merges that wait for one are recorded. */
  async function startPass(gh: LandingBatchGitHub, repo: string, cfg: LandingBatchRepo, landing: string): Promise<void> {
    const cmp = await gh.compare(repo, cfg.tested, landing);
    const merges = mergedPullRequests(cmp.commits.map((c) => c.message));
    const fresh = landingBatchStates(o.events())[repo];
    const due = batchDue(fresh, { tip: cmp.tip, aheadBy: cmp.aheadBy, merges: merges.length }, cfg, o.now());
    if (!due.due) {
      // The merges that wait for it, for the work-item ledger: once per change.
      if (cmp.aheadBy > 0 && pendingChanged(fresh, merges)) o.record({ type: 'landing_batch.pending', data: { repo, landing, tested: cfg.tested, tip: cmp.tip, merges } });
      note(repo, { why: due.why });
      return;
    }
    const branch = batchBranch(cmp.tip);
    await gh.createBranch(repo, branch, cmp.tip);
    const b = { landing, tested: cfg.tested, tip: cmp.tip, merges, closes: o.closingIssues?.(repo, merges) ?? [] };
    const pr = await gh.openPullRequest(repo, { head: branch, base: cfg.tested, title: batchTitle(b), body: batchBody(b) });
    o.record({ type: 'landing_batch.started', data: { repo, landing, tested: cfg.tested, tip: cmp.tip, branch, pullRequest: pr.number, url: pr.url, merges, why: due.why } });
    note(repo, { why: due.why });
  }

  /**
   * One repository's pass, step by step. A step that throws is a problem of the pass, and the next step still runs
   * (issue #1333): a refused move or comment never holds a green batch run back. Answers the problems, one per step.
   */
  async function passRepo(gh: LandingBatchGitHub, repo: string): Promise<string[]> {
    const cfg = o.settings().repos[repo];
    if (!cfg) return [];
    // The landing branch is a setting, never GitHub's default branch: a repository whose default branch is its tested
    // branch still takes landing batches (issue #1142).
    const landing = landingBranch(cfg);
    if (landing.toLowerCase() === cfg.tested.toLowerCase()) {
      return [`the landing branch of ${repo} is ${landing}, its tested branch: name another landing branch in Settings → Landing batches`];
    }
    const problems: string[] = [];
    const step = async (what: string, f: () => Promise<void>): Promise<void> => {
      try { await f(); } catch (e) { problems.push(`${what}: ${(e as Error).message}`); }
    };
    await step(`the move of job pull requests to ${landing}`, () => moveJobPullRequests(gh, repo, cfg.tested, landing));
    const state = landingBatchStates(o.events())[repo];
    const red: RedPass = { gh, repo, landing, tested: cfg.tested, record: o.record, state: () => landingBatchStates(o.events())[repo], note: (f: { why?: string; problem?: string }) => note(repo, f), login: o.login, now: o.now, log: o.log };
    const run = state?.running;
    if (run) {
      await step(`batch run #${run.pullRequest}`, () => runningPass(gh, repo, cfg.tested, landing, run, red));
      return problems;
    }
    const bisect = state?.bisect;
    if (bisect) {
      await step(`the bisect of the batch at ${bisect.tip.slice(0, 12)}`, () => bisectPass(red, bisect));
      return problems;
    }
    const culprit = state?.culprit;
    if (culprit) await step('the culprit\'s revert', () => culpritPass(red, culprit));
    const backMerge = state?.backMerge;
    if (backMerge) await step('the back-merge', () => backMergePass(red, backMerge));
    await step('the start of a batch run', () => startPass(gh, repo, cfg, landing));
    return problems;
  }

  /** What a pass of `repo` ended with: its problem, or none. The same problem on LANDING_BATCH_STUCK_PASSES passes in a row is recorded once. */
  function track(repo: string, problem: string | undefined): void {
    const was = failing.get(repo);
    if (problem === undefined) { failing.delete(repo); return; }
    if (was?.error !== problem) o.log(`hopper: landing batches: ${repo}: ${problem}`);
    const now = was?.error === problem ? { ...was, passes: was.passes + 1 } : { error: problem, since: o.now().toISOString(), passes: 1, recorded: false };
    if (!now.recorded && now.passes >= LANDING_BATCH_STUCK_PASSES) {
      o.record({ type: 'landing_batch.stuck', data: { repo, error: now.error, since: now.since, passes: now.passes } });
      now.recorded = true;
    }
    failing.set(repo, now);
  }

  async function runPass(): Promise<void> {
    const repos = Object.keys(o.settings().repos);
    if (repos.length === 0) return;
    const gh = o.github();
    for (const repo of repos) {
      if ('problem' in gh) { note(repo, { problem: gh.problem }); track(repo, gh.problem); continue; }
      const problems = await passRepo(gh, repo).catch((e: unknown) => [(e as Error).message]);
      const problem = problems.length > 0 ? problems.join('; ') : undefined;
      if (problem !== undefined) note(repo, { problem });
      track(repo, problem);
      const hours = o.settings().repos[repo]?.canaryHours;
      if (hours === undefined) { canaryFound.delete(repo); continue; }
      const noteCanary = (f: { why?: string; problem?: string }): void => { canaryFound.set(repo, { ...f, checkedAt: o.now().toISOString() }); };
      try {
        await canaryPass({ gh, repo, hours, record: o.record, state: () => landingBatchStates(o.events())[repo], note: noteCanary, login: o.login, now: o.now });
      } catch (e) {
        noteCanary({ problem: (e as Error).message });
        o.log(`hopper: landing batches: the canary of ${repo}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * A person's way out of a stuck batch (issue #1333). Recorded at once: `landing_batch.restarted` ends the batch run and
   * the bisect at work, so the next batch run starts at the landing branch's tip, the same tip too. Then, after the pass
   * in flight, their pull requests are closed and their branches removed, and a pass starts it. A close or a removal
   * GitHub refuses is logged: the restart goes on, and the removed branch closes the pull request all the same.
   */
  function restart(repo: string, by: string): { closed: number[]; done: Promise<void> } {
    const key = repo.toLowerCase();
    if (!o.settings().repos[key]) throw new Error(`${repo} has no landing batches`);
    const gh = o.github();
    if ('problem' in gh) throw new Error(gh.problem);
    const state = landingBatchStates(o.events())[key];
    const at = [state?.running, state?.bisect?.running].filter((r) => r !== undefined);
    const closed = at.map((r) => r.pullRequest);
    o.record({ type: 'landing_batch.restarted', data: { repo: key, ...(state?.running ? { tip: state.running.tip } : {}), by, closed } });
    failing.delete(key);
    const done = (async () => {
      await running?.catch(() => undefined);
      for (const r of at) {
        await gh.close(key, r.pullRequest).catch((e: unknown) => o.log(`hopper: landing batches: #${r.pullRequest} of ${key} not closed: ${(e as Error).message}`));
        await gh.deleteBranch(key, r.branch).catch((e: unknown) => o.log(`hopper: landing batches: ${r.branch} of ${key} not removed: ${(e as Error).message}`));
      }
      await pass();
    })();
    return { closed, done };
  }

  let running: Promise<void> | undefined;
  // One pass at a time: a batch run is never started twice by two passes at once.
  const pass = (): Promise<void> => (running ??= runPass().finally(() => { running = undefined; }));
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    pass,
    restart,
    view() {
      const settings = o.settings();
      const states = landingBatchStates(o.events());
      return {
        repos: Object.entries(settings.repos).map(([repo, config]) => ({
          repo, config, state: states[repo] ?? { repo }, ...found.get(repo),
          ...stuckOf(failing.get(repo)),
          ...(config.canaryHours !== undefined && canaryFound.has(repo) ? { canary: canaryFound.get(repo) } : {}),
        })),
      };
    },
    start() {
      const run = () => { pass().catch((e: unknown) => o.log(`hopper: landing batches: the pass failed: ${(e as Error).message}`)); };
      run();
      timer ??= setInterval(run, o.everyMs ?? LANDING_BATCH_PASS_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}
