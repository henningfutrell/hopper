// The canary step (issue #1073 part 5, design.md "Landing batches: the canary"): each pass, for a repository with a
// canary window, `stable` is compared with `canary`. A new candidate starts the window (`landing_batch.canary_started`);
// the candidate at work is read against the bug reports that name it: one or more hold it (`canary_held`) and file one
// issue with the hopper label, assigned to the user, so Intake takes it (`canary_issue_filed`); the window passed with
// none, `stable` moves to it as a fast-forward (`canary_promoted`). The rules and the text are
// `src/domain/landing-canary.ts`; each step an event, with the user's own GitHub connection.
import type { LandingBatchState } from '../domain/landing-batches.ts';
import { CANARY_BRANCH, canaryIssueText, canaryNext, canaryVerdict, STABLE_BRANCH, type Canary } from '../domain/landing-canary.ts';
import type { NewEvent } from '../domain/types.ts';
import { JOB_LABEL } from '../repo-checks/service.ts';
import type { LandingBatchGitHub } from './runner.ts';

export interface CanaryPass {
  gh: LandingBatchGitHub;
  repo: string;
  hours: number;
  record(event: NewEvent): void;
  state(): LandingBatchState | undefined;
  note(f: { why?: string; problem?: string }): void;
  login(): string | undefined;
  now(): Date;
}

export async function canaryPass(p: CanaryPass): Promise<void> {
  const at = { repo: p.repo, canary: CANARY_BRANCH, stable: STABLE_BRANCH };
  const cmp = await p.gh.compare(p.repo, STABLE_BRANCH, CANARY_BRANCH);
  const c = p.state()?.canary;
  const next = canaryNext(c, cmp);
  if (next.kind === 'start') {
    p.record({ type: 'landing_batch.canary_started', data: { ...at, tip: cmp.tip, hours: p.hours } });
    p.note({ why: next.why });
    return;
  }
  if (next.kind === 'idle') {
    if (c?.state === 'held' && c.tip === cmp.tip && !c.issue) await fileIssue(p, c);
    p.note({ why: next.why });
    return;
  }
  const running = c!;
  const reports = await p.gh.bugReports(p.repo, running.tip.slice(0, 12), running.startedAt);
  const verdict = canaryVerdict(running, reports, p.hours, p.now());
  if (verdict.kind === 'wait') { p.note({ why: verdict.why }); return; }
  if (verdict.kind === 'promote') {
    await p.gh.fastForward(p.repo, STABLE_BRANCH, running.tip);
    p.record({ type: 'landing_batch.canary_promoted', data: { ...at, tip: running.tip, why: verdict.why } });
    p.note({ why: `${STABLE_BRANCH} moved to ${running.tip.slice(0, 12)}: ${verdict.why}` });
    return;
  }
  p.record({ type: 'landing_batch.canary_held', data: { ...at, tip: running.tip, reports, reason: verdict.reason } });
  p.note({ why: `the canary ${running.tip.slice(0, 12)} is held: ${verdict.reason}` });
  const held = p.state()?.canary;
  if (held) await fileIssue(p, held);
}

/** The issue for a held candidate, once. */
async function fileIssue(p: CanaryPass, c: Canary): Promise<void> {
  const login = p.login();
  if (login === undefined) { p.note({ problem: 'no GitHub account is connected: the issue for the held canary waits' }); return; }
  try {
    const filed = await p.gh.fileIssue(p.repo, { ...canaryIssueText({ tip: c.tip, reports: c.reports, hours: p.hours }), labels: [JOB_LABEL], assignees: [login] });
    p.record({ type: 'landing_batch.canary_issue_filed', data: { repo: p.repo, tip: c.tip, issue: filed.number, url: filed.url } });
  } catch (e) {
    p.note({ problem: `the issue for the held canary ${c.tip.slice(0, 12)} was not filed: ${(e as Error).message}` });
  }
}
