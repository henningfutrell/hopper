// A red batch (issue #1073 part 2, design.md "Landing batches"): the batch runner's steps after a batch run's checks
// failed. The bisect starts from the batch's points (`startBisect`); each pass takes one step of it (`bisectPass`): a
// bisect run of the middle point — a branch at it and a pull request into the tested branch, as a batch run, never
// merged —, read and closed when its checks end; then the culprit. For the culprit (`culpritPass`): GitHub's revert of
// its pull request on the landing branch, merged once GitHub lets it, and a fix issue with the hopper label, assigned
// to the user, so Intake takes it. Each step an event, with the user's own GitHub connection; the rules and the text are
// `src/domain/landing-bisect.ts`.
import { batchChecks, type LandingBatchState } from '../domain/landing-batches.ts';
import {
  batchPoints, bisectBody, bisectBranch, bisectNext, bisectTitle, fixIssueText, linkedIssue, logTail, revertText,
  type Bisect, type Culprit, type FailedCheck,
} from '../domain/landing-bisect.ts';
import type { NewEvent } from '../domain/types.ts';
import { JOB_LABEL } from '../repo-checks/service.ts';
import type { LandingBatchGitHub } from './runner.ts';

/** One repository's pass, as the runner gives it. */
export interface RedPass {
  gh: LandingBatchGitHub;
  repo: string;
  landing: string;
  tested: string;
  record(event: NewEvent): void;
  /** The repository's state from the events, as they are now. */
  state(): LandingBatchState | undefined;
  note(found: { why?: string; problem?: string }): void;
  login(): string | undefined;
  now(): Date;
  log(line: string): void;
}

const short = (sha: string): string => sha.slice(0, 12);

/** After a batch run at `tip` failed its checks: a bisect of its points, or the culprit at once when it had one. */
export async function startBisect(p: RedPass, f: { tested: string; tip: string; checks: FailedCheck[]; reason: string; pullRequest: number; url: string }): Promise<void> {
  const cmp = await p.gh.compare(p.repo, f.tested, f.tip);
  const points = batchPoints(cmp.commits, f.tip);
  if (points.length <= 1) {
    const point = points[0] ?? { sha: f.tip };
    p.record({ type: 'landing_batch.culprit', data: { repo: p.repo, tested: f.tested, tip: f.tip, index: 0, ...point, checks: f.checks, reason: f.reason, results: [], batch: f.pullRequest } });
    return;
  }
  p.record({ type: 'landing_batch.bisect_started', data: { repo: p.repo, tested: f.tested, tip: f.tip, points, checks: f.checks, reason: f.reason, pullRequest: f.pullRequest, url: f.url } });
}

/** One step of the bisect: read the bisect run at work, or start the next one, or record the culprit. */
export async function bisectPass(p: RedPass, b: Bisect): Promise<void> {
  const run = b.running;
  if (run) {
    const pr = await p.gh.pullRequest(p.repo, run.pullRequest);
    const end = async (outcome: 'good' | 'bad' | 'unknown', why: string, checks: FailedCheck[] = []): Promise<void> => {
      if (pr.state === 'open') await p.gh.close(p.repo, run.pullRequest);
      await p.gh.deleteBranch(p.repo, run.branch).catch((e: unknown) => p.log(`hopper: landing batches: ${run.branch} of ${p.repo} not removed: ${(e as Error).message}`));
      p.record({
        type: 'landing_batch.bisect_tested',
        data: { repo: p.repo, tested: b.tested, tip: b.tip, index: run.index, sha: run.sha, pullRequest: run.pullRequest, url: run.url, outcome, ...(outcome === 'unknown' ? { reason: why } : {}), ...(checks.length > 0 ? { checks } : {}) },
      });
      p.note({ why: outcome === 'unknown' ? `the bisect ended: ${why}` : `bisect run #${run.pullRequest}: ${short(run.sha)} ${why}` });
    };
    if (pr.merged) return end('good', 'passed');
    if (pr.state === 'closed') return end('unknown', 'its pull request was closed without a merge');
    if (pr.headSha !== run.sha) return end('unknown', `its branch moved from ${short(run.sha)}`);
    const checks = batchChecks(await p.gh.checkRuns(p.repo, run.sha), pr, run.startedAt, p.now());
    if (checks.kind === 'pending') { p.note({ why: `bisect run #${run.pullRequest} waits for its checks` }); return; }
    if (checks.kind === 'green') return end('good', 'passed');
    return checks.checks.length > 0 ? end('bad', 'failed', checks.checks) : end('unknown', checks.reason);
  }
  const next = bisectNext(b);
  const point = b.points[next.index]!;
  if (next.kind === 'test') {
    const branch = bisectBranch(point.sha);
    await p.gh.createBranch(p.repo, branch, point.sha);
    const t = { landing: p.landing, tested: b.tested, sha: point.sha, tip: b.tip, ...(point.pullRequest !== undefined ? { pullRequest: point.pullRequest } : {}) };
    const pr = await p.gh.openPullRequest(p.repo, { head: branch, base: b.tested, title: bisectTitle(t), body: bisectBody(t) });
    p.record({ type: 'landing_batch.bisect_run', data: { repo: p.repo, tested: b.tested, tip: b.tip, index: next.index, sha: point.sha, branch, pullRequest: pr.number, url: pr.url } });
    p.note({ why: `bisect run #${pr.number} tests ${short(point.sha)}` });
    return;
  }
  p.record({
    type: 'landing_batch.culprit',
    data: { repo: p.repo, tested: b.tested, tip: b.tip, index: next.index, ...point, checks: b.checks[next.index] ?? [], reason: b.reason, results: b.results, ...(b.batch !== undefined ? { batch: b.batch } : {}) },
  });
  const c = p.state()?.culprit;
  if (c) await culpritPass(p, c);
}

/** The culprit's revert — opened, then merged —, and its fix issue, each once. */
export async function culpritPass(p: RedPass, c: Culprit): Promise<void> {
  const at = { repo: p.repo, tip: c.tip, sha: c.sha };
  if (!c.revert && c.revertProblem === undefined) {
    const n = c.pullRequest ?? await p.gh.pullRequestOf(p.repo, c.sha);
    if (n === undefined) {
      p.record({ type: 'landing_batch.revert_failed', data: { ...at, reason: 'the culprit is a direct commit, not a pull request: revert it by hand' } });
    } else {
      try {
        const r = await p.gh.revert(p.repo, n, revertText({ landing: p.landing, tested: p.tested, tip: c.tip, culprit: n, checks: c.checks.map((x) => x.name), ...(c.batch !== undefined ? { batch: c.batch } : {}) }));
        p.record({ type: 'landing_batch.revert_opened', data: { ...at, culpritPullRequest: n, pullRequest: r.number, url: r.url } });
      } catch (e) {
        p.record({ type: 'landing_batch.revert_failed', data: { ...at, reason: (e as Error).message } });
      }
    }
  } else if (c.revert?.state === 'open') {
    const r = c.revert;
    const pr = await p.gh.pullRequest(p.repo, r.pullRequest);
    if (pr.merged) {
      p.record({ type: 'landing_batch.reverted', data: { ...at, pullRequest: r.pullRequest, url: r.url, ...(pr.mergeSha ? { merge: pr.mergeSha } : {}) } });
    } else if (pr.state === 'closed') {
      p.record({ type: 'landing_batch.revert_failed', data: { ...at, pullRequest: r.pullRequest, url: r.url, reason: `the revert #${r.pullRequest} was closed without a merge` } });
    } else {
      try {
        const m = await p.gh.merge(p.repo, r.pullRequest, pr.headSha, `Revert #${c.pullRequest ?? short(c.sha)}: it fails the full test suite`);
        p.record({ type: 'landing_batch.reverted', data: { ...at, pullRequest: r.pullRequest, url: r.url, merge: m.sha } });
      } catch (e) {
        p.note({ why: `the revert #${r.pullRequest} waits: ${(e as Error).message}` });
      }
    }
  }
  const now = p.state()?.culprit;
  if (!now || now.fix || now.sha !== c.sha) return;
  await fileFix(p, now);
}

async function fileFix(p: RedPass, c: Culprit): Promise<void> {
  const login = p.login();
  if (login === undefined) { p.note({ problem: 'no GitHub account is connected: the fix issue waits' }); return; }
  try {
    const checks = await Promise.all(c.checks.map(async (x) => {
      const log = x.id === undefined ? undefined : await p.gh.checkLog(p.repo, x.id).then((t) => logTail(t)).catch(() => undefined);
      return log ? { name: x.name, log } : { name: x.name };
    }));
    const issue = c.pullRequest === undefined ? undefined : linkedIssue((await p.gh.pullRequest(p.repo, c.pullRequest)).body);
    const text = fixIssueText({
      landing: p.landing, tested: p.tested, tip: c.tip, sha: c.sha, checks, results: c.results, ...(c.batch !== undefined ? { batch: c.batch } : {}),
      ...(c.pullRequest !== undefined ? { pullRequest: c.pullRequest } : {}), ...(issue !== undefined ? { issue } : {}),
      revert: c.revert ? { pullRequest: c.revert.pullRequest } : { problem: c.revertProblem ?? 'the revert is not open yet' },
    });
    const filed = await p.gh.fileIssue(p.repo, { ...text, labels: [JOB_LABEL], assignees: [login] });
    p.record({ type: 'landing_batch.fix_filed', data: { repo: p.repo, tip: c.tip, sha: c.sha, issue: filed.number, url: filed.url } });
  } catch (e) {
    p.note({ problem: `the fix issue for ${short(c.sha)} was not filed: ${(e as Error).message}` });
  }
}
