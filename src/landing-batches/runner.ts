// The batch runner (issue #1073, design.md "Landing batches"): one user's landing batches, one pass at start and every
// `LANDING_BATCH_PASS_MS`. For each repository the settings name: a job's open pull request on the tested branch moves
// to the landing branch (the default branch); a batch run at work is read — green, merged into the tested branch at its
// tip; red, closed and recorded failed; either way its branch is removed —; failing checks start a bisect within the
// batch, and a pass takes its next step, then the culprit's revert and fix issue (`red.ts`); with none of these at work,
// a batch run starts when due (`batchDue`). Each step is an event, with the user's own GitHub connection. What the last
// pass found is kept in memory for the view: why no batch run started, or the problem.
import {
  batchBody, batchBranch, batchChecks, batchDue, batchTitle, landingBatchStates, mergedPullRequests, pendingChanged,
  type BatchCheckRun, type LandingBatchRepoView, type LandingBatchSettings,
} from '../domain/landing-batches.ts';
import type { FailedCheck } from '../domain/landing-bisect.ts';
import type { DomainEvent, NewEvent } from '../domain/types.ts';
import { bisectPass, culpritPass, startBisect } from './red.ts';

/** How often the runner passes: 2 minutes. */
export const LANDING_BATCH_PASS_MS = 2 * 60_000;

/** The GitHub calls of the batch runner. */
export interface LandingBatchGitHub {
  defaultBranch(repo: string): Promise<string>;
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
  openPullRequests(repo: string, base: string): Promise<{ number: number; url: string }[]>;
  retarget(repo: string, number: number, base: string): Promise<void>;
  /** The merged pull request whose merge (or squash) commit is `sha`, when there is one. */
  pullRequestOf(repo: string, sha: string): Promise<number | undefined>;
  /** GitHub's revert of a merged pull request: a new pull request into its base, with this text. */
  revert(repo: string, number: number, text: { title: string; body: string }): Promise<{ number: number; url: string }>;
  /** The log of a GitHub Actions job, by its check run's id. */
  checkLog(repo: string, checkRunId: number): Promise<string>;
  fileIssue(repo: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<{ number: number; url: string }>;
}

export interface LandingBatches {
  pass(): Promise<void>;
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
  /** The URLs of the open pull requests of the user's jobs: only those move to the landing branch. */
  jobPullRequests(): readonly string[];
  now(): Date;
  log(line: string): void;
  everyMs?: number;
}): LandingBatches {
  const found = new Map<string, { why?: string; problem?: string; checkedAt: string }>();
  const note = (repo: string, f: { why?: string; problem?: string }): void => { found.set(repo, { ...f, checkedAt: o.now().toISOString() }); };

  async function passRepo(gh: LandingBatchGitHub, repo: string): Promise<void> {
    const cfg = o.settings().repos[repo];
    if (!cfg) return;
    const landing = await gh.defaultBranch(repo);
    if (landing.toLowerCase() === cfg.tested.toLowerCase()) {
      note(repo, { problem: `the default branch of ${repo} is ${landing}, its tested branch: make the landing branch its default branch` });
      return;
    }
    // A job's pull request lands on the landing branch, never on the tested branch.
    const jobs = new Set(o.jobPullRequests());
    for (const p of await gh.openPullRequests(repo, cfg.tested)) {
      if (!jobs.has(p.url)) continue;
      await gh.retarget(repo, p.number, landing);
      o.record({ type: 'landing_batch.retargeted', data: { repo, pullRequest: p.number, url: p.url, from: cfg.tested, to: landing } });
    }
    const state = landingBatchStates(o.events())[repo];
    const red = { gh, repo, landing, tested: cfg.tested, record: o.record, state: () => landingBatchStates(o.events())[repo], note: (f: { why?: string; problem?: string }) => note(repo, f), login: o.login, now: o.now, log: o.log };
    const run = state?.running;
    if (run) {
      const pr = await gh.pullRequest(repo, run.pullRequest);
      const ended = { repo, tested: cfg.tested, tip: run.tip, pullRequest: run.pullRequest, url: run.url };
      const fail = async (reason: string, checks: FailedCheck[], close: boolean): Promise<void> => {
        if (close) await gh.close(repo, run.pullRequest);
        await gh.deleteBranch(repo, run.branch).catch((e: unknown) => o.log(`hopper: landing batches: ${run.branch} of ${repo} not removed: ${(e as Error).message}`));
        o.record({ type: 'landing_batch.failed', data: { ...ended, reason, checks: checks.map((c) => c.name), ...(checks.length > 0 ? { checkRuns: checks } : {}) } });
        note(repo, { why: reason });
        // Only failing checks say the batch itself fails: a bisect finds the first change that does.
        if (checks.length > 0) await startBisect(red, { tested: cfg.tested, tip: run.tip, checks, reason, pullRequest: run.pullRequest, url: run.url });
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
      if (checks.kind === 'red') return fail(checks.reason, checks.checks, true);
      const merged = await gh.merge(repo, run.pullRequest, run.tip, batchTitle({ landing, tested: cfg.tested, tip: run.tip }));
      await gh.deleteBranch(repo, run.branch).catch((e: unknown) => o.log(`hopper: landing batches: ${run.branch} of ${repo} not removed: ${(e as Error).message}`));
      o.record({ type: 'landing_batch.promoted', data: { ...ended, merge: merged.sha } });
      note(repo, { why: `batch run #${run.pullRequest} moved ${cfg.tested} to ${run.tip.slice(0, 12)}` });
      return;
    }
    if (state?.bisect) return bisectPass(red, state.bisect);
    if (state?.culprit) await culpritPass(red, state.culprit);
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
    const b = { landing, tested: cfg.tested, tip: cmp.tip, merges };
    const pr = await gh.openPullRequest(repo, { head: branch, base: cfg.tested, title: batchTitle(b), body: batchBody(b) });
    o.record({ type: 'landing_batch.started', data: { repo, landing, tested: cfg.tested, tip: cmp.tip, branch, pullRequest: pr.number, url: pr.url, merges, why: due.why } });
    note(repo, { why: due.why });
  }

  async function runPass(): Promise<void> {
    const repos = Object.keys(o.settings().repos);
    if (repos.length === 0) return;
    const gh = o.github();
    for (const repo of repos) {
      if ('problem' in gh) { note(repo, { problem: gh.problem }); continue; }
      try {
        await passRepo(gh, repo);
      } catch (e) {
        note(repo, { problem: (e as Error).message });
        o.log(`hopper: landing batches: ${repo}: ${(e as Error).message}`);
      }
    }
  }

  let running: Promise<void> | undefined;
  // One pass at a time: a batch run is never started twice by two passes at once.
  const pass = (): Promise<void> => (running ??= runPass().finally(() => { running = undefined; }));
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    pass,
    view() {
      const settings = o.settings();
      const states = landingBatchStates(o.events());
      return {
        repos: Object.entries(settings.repos).map(([repo, config]) => ({
          repo, config, state: states[repo] ?? { repo }, ...found.get(repo),
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
