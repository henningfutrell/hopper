// The batch runner (issue #1073, design.md "Landing batches"): one user's landing batches, one pass at start and every
// `LANDING_BATCH_PASS_MS`. For each repository the settings name: a job's open pull request on the tested branch moves
// to the landing branch (its settings name it, issue #1142); a batch run at work is read — green, merged into the tested branch at its
// tip; red, closed and recorded failed; either way its branch is removed —; failing checks start a bisect within the
// batch, and a pass takes its next step, then the culprit's revert and fix issue (`red.ts`); merge conflicts with the
// tested branch start a back-merge of it into the landing branch (`back-merge.ts`); with none of these at work,
// a batch run starts when due (`batchDue`), its text closing the issues of its job pull requests (issue #1175). With a canary window set, the canary step after it (`canary.ts`). Each step is an event, with the user's own GitHub connection. What the last
// pass found is kept in memory for the view: why no batch run started, or the problem.
// Each GitHub write follows the record of its intent (issue #1589): a batch run is recorded due before its branch and pull
// request, a failure before its close; a pass that stopped between the two finds what it made (`once.ts`) and closes
// what it ended.
import {
  BATCH_BRANCH_PREFIX, batchBody, closingReferences, batchBranch, batchChecks, batchDue, batchTitle, landingBatchStates, landingBranch, mergedPullRequests, pendingChanged,
  type BatchCheckRun, type DueBatch, type LandingBatchRepo, type LandingBatchRepoView, type LandingBatchSettings, type LandingBatchStuck, type RunningBatch,
} from '../domain/landing-batches.ts';
import type { FailedCheck } from '../domain/landing-bisect.ts';
import { heldCut } from '../domain/track-interventions.ts';
import type { DomainEvent, NewEvent } from '../domain/types.ts';
import { backMergePass, startBackMerge } from './back-merge.ts';
import { retargetNote } from '../sources/github/pr-notes.ts';
import { betaPass, canaryPass } from './canary.ts';
import { openOnce, withKillPoints } from './once.ts';
import { bisectPass, bisectStart, culpritPass, type RedPass } from './red.ts';

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
  /** The open pull requests into `base`, with the branch each comes from and its title. */
  openPullRequests(repo: string, base: string): Promise<{ number: number; url: string; head: string; title: string }[]>;
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
  /** The open issue with this title and label, changed since `since` (issue #1589): one a pass filed before it was recorded. */
  findIssue(repo: string, f: { title: string; label: string; since: string }): Promise<{ number: number; url: string } | undefined>;
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
  /** The pull requests of `repo` whose change a delivery hold holds (issue #2775 part 7): no batch run and no stable move takes them. Absent: none. */
  held?(repo: string): ReadonlySet<number>;
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

  /**
   * A batch or bisect run's branch removed and its pull request closed; a refusal is logged, and a later pass tries again.
   * The branch first (issue #1954): GitHub closes a pull request whose branch is removed, and a pass closes an ended run's
   * pull request still open, so a stop between the two leaves neither. The other way, the branch of a closed pull request stays.
   */
  async function closeRun(gh: LandingBatchGitHub, repo: string, pullRequest: number | undefined, branch: string): Promise<void> {
    await gh.deleteBranch(repo, branch).catch((e: unknown) => o.log(`hopper: landing batches: ${branch} of ${repo} not removed: ${(e as Error).message}`));
    if (pullRequest !== undefined) await gh.close(repo, pullRequest).catch((e: unknown) => o.log(`hopper: landing batches: #${pullRequest} of ${repo} not closed: ${(e as Error).message}`));
  }

  /** The batch run at work: read, and merged on green or ended on red. */
  async function runningPass(gh: LandingBatchGitHub, repo: string, tested: string, landing: string, run: RunningBatch, red: RedPass): Promise<void> {
    const pr = await gh.pullRequest(repo, run.pullRequest);
    const ended = { repo, tested, tip: run.tip, pullRequest: run.pullRequest, url: run.url };
    const fail = async (reason: string, checks: FailedCheck[], close: boolean, conflicts = false, cutOff = false): Promise<void> => {
      // Only failing checks say the batch itself fails: a bisect finds the first change that does. Its points are read
      // first, so its start is recorded with the failure, and both before the close (issue #1589). A cut-off check (issue
      // #2086) says nothing of the batch: no bisect; the batch runs again (batchDue).
      const bisect = checks.length > 0 && !cutOff ? await bisectStart(red, { tested, tip: run.tip, checks, reason, pullRequest: run.pullRequest, url: run.url }) : undefined;
      o.record({
        type: 'landing_batch.failed',
        data: { ...ended, reason, checks: checks.map((c) => c.name), ...(checks.length > 0 ? { checkRuns: checks } : {}), ...(conflicts ? { conflicts } : {}), ...(cutOff ? { cutOff } : {}) },
      });
      if (bisect) o.record(bisect);
      note(repo, { why: reason });
      await closeRun(gh, repo, close ? run.pullRequest : undefined, run.branch);
      // Merge conflicts: the tested branch has a change the landing branch lacks, merged into it by a back-merge.
      if (conflicts) await startBackMerge(red, { tip: run.tip, batch: run.pullRequest });
    };
    if (pr.merged) {
      // Merged by a person, or by a pass that stopped before its record.
      await closeRun(gh, repo, undefined, run.branch);
      o.record({ type: 'landing_batch.promoted', data: { ...ended, ...(pr.mergeSha ? { merge: pr.mergeSha } : {}) } });
      note(repo, { why: `batch run #${run.pullRequest} was merged` });
      return;
    }
    if (pr.state === 'closed') return fail('its pull request was closed without a merge', [], false);
    if (pr.headSha !== run.tip) return fail(`its branch moved from ${run.tip.slice(0, 12)}`, [], true);
    const checks = batchChecks(await gh.checkRuns(repo, run.tip), pr, run.startedAt, o.now());
    if (checks.kind === 'pending') { note(repo, { why: `batch run #${run.pullRequest} waits for its checks` }); return; }
    if (checks.kind === 'red') return fail(checks.reason, checks.checks, true, pr.mergeable === false);
    if (checks.kind === 'cut-off') return fail(checks.reason, checks.checks, true, false, true);
    const merged = await gh.merge(repo, run.pullRequest, run.tip, batchTitle({ landing, tested, tip: run.tip }));
    await gh.deleteBranch(repo, run.branch).catch((e: unknown) => o.log(`hopper: landing batches: ${run.branch} of ${repo} not removed: ${(e as Error).message}`));
    o.record({ type: 'landing_batch.promoted', data: { ...ended, merge: merged.sha } });
    note(repo, { why: `batch run #${run.pullRequest} moved ${tested} to ${run.tip.slice(0, 12)}` });
  }

  /** A job's pull request lands on the landing branch, never on the tested branch. Answers the open pull requests on it. */
  async function moveJobPullRequests(gh: LandingBatchGitHub, repo: string, tested: string, landing: string): Promise<{ number: number; head: string }[]> {
    // The hopper's own (a batch run, a bisect, a back-merge) stays there, even when a job named it (issue #1311): its
    // branch is a landing branch tip.
    const jobs = new Set(o.jobPullRequests());
    const open = await gh.openPullRequests(repo, tested);
    for (const p of open) {
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
    return open;
  }

  /** A batch run starts when due; else the merges that wait for one are recorded. */
  async function startPass(gh: LandingBatchGitHub, repo: string, cfg: LandingBatchRepo, landing: string): Promise<void> {
    const fresh = landingBatchStates(o.events())[repo];
    // A batch run recorded due and not started: a pass stopped on its way (issue #1589). The same one starts.
    if (fresh?.due) return start(gh, repo, cfg.tested, fresh.due);
    const all = await gh.compare(repo, cfg.tested, landing);
    const pending = mergedPullRequests(all.commits.map((c) => c.message));
    // A held change (issue #2775 part 7): the batch run takes the landing branch up to it.
    const cut = heldCut(all.commits, o.held?.(repo) ?? new Set());
    const cmp = cut ? await gh.compare(repo, cfg.tested, cut.tip) : all;
    const merges = cut ? mergedPullRequests(cmp.commits.map((c) => c.message)) : pending;
    const facts = batchDue(fresh, { tip: cmp.tip, aheadBy: cmp.aheadBy, merges: merges.length }, cfg, o.now());
    const due = cut ? { ...facts, why: `${facts.why}; #${cut.pullRequest} is held: the batch run takes the landing branch up to it` } : facts;
    if (!due.due) {
      // The merges that wait for it, for the work-item ledger: once per change.
      if (all.aheadBy > 0 && pendingChanged(fresh, pending)) o.record({ type: 'landing_batch.pending', data: { repo, landing, tested: cfg.tested, tip: all.tip, merges: pending } });
      note(repo, { why: due.why });
      return;
    }
    const d: DueBatch = { tip: cmp.tip, branch: batchBranch(cmp.tip), landing, merges, closes: await batchCloses(gh, repo, merges), why: due.why };
    o.record({ type: 'landing_batch.due', data: { repo, tested: cfg.tested, ...d } });
    await start(gh, repo, cfg.tested, d);
  }

  /** A due batch run's branch and pull request, or the pull request a stopped pass opened on that branch. */
  async function start(gh: LandingBatchGitHub, repo: string, tested: string, d: DueBatch): Promise<void> {
    await gh.createBranch(repo, d.branch, d.tip);
    const b = { landing: d.landing, tested, tip: d.tip, merges: d.merges, closes: d.closes };
    const pr = await openOnce(gh, repo, { head: d.branch, base: tested, title: batchTitle(b), body: batchBody(b) });
    o.record({ type: 'landing_batch.started', data: { repo, landing: d.landing, tested, tip: d.tip, branch: d.branch, pullRequest: pr.number, url: pr.url, merges: d.merges, why: d.why } });
    note(repo, { why: d.why });
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
    let open: { number: number; head: string }[] = [];
    await step(`the move of job pull requests to ${landing}`, async () => { open = await moveJobPullRequests(gh, repo, cfg.tested, landing); });
    const state = landingBatchStates(o.events())[repo];
    // A batch or bisect run recorded ended and still open: a pass stopped before it closed it (issue #1589).
    for (const p of open) if (state?.closedRuns?.includes(p.number) && p.head.startsWith(BATCH_BRANCH_PREFIX)) await closeRun(gh, repo, p.number, p.head);
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
    if (backMerge) await step('the back-merge', () => (backMerge.state === 'due' ? startBackMerge(red, { tip: backMerge.tip, batch: backMerge.batch ?? 0 }) : backMergePass(red, backMerge)));
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

  /**
   * The issues a batch run of `merges` closes: those the ledger knows its job pull requests did (issue #1175), then those
   * each pull request's own text closes (issue #1356), whatever the ledger knows of its item — a job still at work or on
   * its own wait, or an item the ledger never linked to it. A text that cannot be read is said, and the rest go on.
   */
  async function batchCloses(gh: LandingBatchGitHub, repo: string, merges: readonly number[]): Promise<string[]> {
    const out = [...o.closingIssues?.(repo, merges) ?? []];
    const has = (ref: string) => out.some((r) => r.toLowerCase() === ref.toLowerCase());
    for (const n of merges) {
      const body = await gh.pullRequest(repo, n).then((p) => p.body, (e: unknown) => {
        o.log(`hopper: landing batches: the text of ${repo}#${n} was not read: ${(e as Error).message}`);
        return '';
      });
      for (const ref of closingReferences(body, repo)) if (!has(ref)) out.push(ref);
    }
    return out;
  }

  async function runPass(): Promise<void> {
    const repos = Object.keys(o.settings().repos);
    if (repos.length === 0) return;
    const given = o.github();
    const gh = 'problem' in given ? given : withKillPoints(given);
    for (const repo of repos) {
      if ('problem' in gh) { note(repo, { problem: gh.problem }); track(repo, gh.problem); continue; }
      const problems = await passRepo(gh, repo).catch((e: unknown) => [(e as Error).message]);
      const problem = problems.length > 0 ? problems.join('; ') : undefined;
      if (problem !== undefined) note(repo, { problem });
      track(repo, problem);
      const hours = o.settings().repos[repo]?.canaryHours;
      if (hours === undefined) { canaryFound.delete(repo); continue; }
      const noteCanary = (f: { why?: string; problem?: string }): void => { canaryFound.set(repo, { ...f, checkedAt: o.now().toISOString() }); };
      await betaPass({ gh, repo, record: o.record, state: () => landingBatchStates(o.events())[repo] });
      try {
        await canaryPass({ gh, repo, hours, held: () => o.held?.(repo) ?? new Set(), record: o.record, state: () => landingBatchStates(o.events())[repo], note: noteCanary, login: o.login, now: o.now });
      } catch (e) {
        noteCanary({ problem: (e as Error).message });
        o.log(`hopper: landing batches: the canary of ${repo}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * A person's way out of a stuck batch (issue #1333). Recorded at once: `landing_batch.restarted` ends the batch run and
   * the bisect at work, so the next batch run starts at the landing branch's tip, the same tip too. Then, after the pass
   * in flight, a pass removes their branches and closes their pull requests, as for every run that ended (issue #1589),
   * and starts it. A close or a removal GitHub refuses is logged: the restart goes on, the removed branch closes the pull
   * request all the same, and a later pass tries again.
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
