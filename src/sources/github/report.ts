// report(): what happened to a job, written to its issue. The hopper's only issue writes are
// labels; it posts no comment at all (owner decision, 2026-10-04: a finished issue needs no
// comment): claimed → `hopper:claimed`; finished → `hopper:done` — only a job whose work reached
// its completion is finished (completion.ts, issues #171, #187), and the merge of its pull request
// closes the issue, never the hopper (with completion `pull-request` the issue stays open until a
// person merges); failed → `hopper:failed`; rejected at the queue gate → `hopper:rejected` (issue
// #159), the issue left open; cancelled → the claim label goes; rerun (a failed job, by the user,
// issue #313) → `hopper:failed` and `hopper:claimed` go, so the issue is offered again — refused while the issue is closed (issue #348). Returns the source state unchanged. Rows written under
// earlier rules may still carry finalCommentId, claimCommentId, progressCommentId,
// questionComments and answeredComments; they are kept as stored and never read.

import { SourceError, SourceRefused } from '../../domain/ports.ts';
import type { SourceReport } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import { HOPPER_LABELS, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED } from './labels.ts';

export interface ReportContext {
  api: GitHubApi;
  /** Repos whose hopper labels were ensured by this process. */
  labelledRepos: Set<string>;
}

type State = Record<string, unknown>;

function issueOf(job: Job): { repo: string; number: number } {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) throw new SourceError(`job ${job.id} has no GitHub issue reference`, true);
  return { repo, number };
}

async function ensureLabels(ctx: ReportContext, repo: string): Promise<void> {
  if (ctx.labelledRepos.has(repo)) return;
  for (const l of HOPPER_LABELS) await ctx.api.ensureLabel(repo, l.name, l.color, l.description);
  ctx.labelledRepos.add(repo);
}

/** End of a job on its issue: drop `hopper:claimed`, add the outcome label. */
async function settle(ctx: ReportContext, repo: string, number: number, add: string[]): Promise<void> {
  await ctx.api.removeLabels(repo, number, [LABEL_CLAIMED]);
  if (add.length) {
    await ensureLabels(ctx, repo);
    await ctx.api.addLabels(repo, number, add);
  }
}

async function apply(ctx: ReportContext, r: SourceReport, state: State): Promise<State> {
  const { job } = r;
  const { repo, number } = issueOf(job);
  switch (r.kind) {
    case 'claimed':
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, [LABEL_CLAIMED]);
      return state;
    case 'finished':
      await settle(ctx, repo, number, [LABEL_DONE]);
      return state;
    case 'failed':
      await settle(ctx, repo, number, [LABEL_FAILED]);
      return state;
    case 'cancelled':
      await settle(ctx, repo, number, []);
      return state;
    case 'rejected':
      await settle(ctx, repo, number, [LABEL_REJECTED]);
      return state;
    case 'rerun':
      // Discovery offers only open issues, and the hopper never reopens one (issue #348).
      if ((await ctx.api.getIssue(repo, number)).state === 'closed') throw new SourceRefused('its issue is closed; reopen it to run it again');
      // The job's end goes, so discovery offers the issue again (issue #313).
      await ctx.api.removeLabels(repo, number, [LABEL_FAILED, LABEL_CLAIMED]);
      return state;
  }
}

export async function reportToGitHub(ctx: ReportContext, r: SourceReport): Promise<State> {
  const state: State = { ...(r.job.sourceState?.source ?? {}) };
  try {
    return await apply(ctx, r, state);
  } catch (err) {
    if (err instanceof SourceError) throw err;
    if (err instanceof GitHubApiError) throw new SourceError(err.message, err.permanent, err.status);
    throw new SourceError((err as Error).message, false);
  }
}
