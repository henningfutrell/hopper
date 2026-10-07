// report(): what happened to a job, written to its issue. The hopper's only issue writes are
// labels; it posts no comment at all (owner decision, 2026-10-04: a finished issue needs no
// comment): claimed → `hopper:claimed`; finished → `hopper:done` — only a job whose work reached
// its completion is finished (completion.ts, issues #171, #187), and the merge of its pull request
// closes the issue, never the hopper (with completion `pull-request` the issue stays open until a
// person merges); failed → `hopper:failed`; rejected at the queue gate → `hopper:rejected` (issue
// #159), the issue left open; cancelled → the claim label goes. Returns the source state unchanged.
// Run again (`takeBack`, issues #313, #354) is the one other issue write: a closed issue is reopened, the
// end labels go and the source label comes back, so the new job runs and finishes against it. Rows written under
// earlier rules may still carry finalCommentId, claimCommentId, progressCommentId,
// questionComments and answeredComments; they are kept as stored and never read.

import { SourceError } from '../../domain/ports.ts';
import type { SourceReport } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import { HOPPER_LABELS, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED } from './labels.ts';
import type { GitHubIssue } from './api.ts';

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
  }
}

/** A GitHub error as the SourceError the sync loop reads (permanent or not). */
function sourceError(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof GitHubApiError) return new SourceError(err.message, err.permanent, err.status);
  return new SourceError((err as Error).message, false);
}

/**
 * Give an ended job's issue back for Run again (issues #313, #354): a closed issue is reopened — the new
 * job is cancelled while it is closed, and its pull request's merge closes it again —, the end labels
 * (`hopper:failed`, `hopper:done`, `hopper:rejected`) and `hopper:claimed` go, and the source label comes
 * back if it was taken off. Answers the issue as it stands after.
 */
export async function takeBack(ctx: ReportContext, label: string, job: Job): Promise<GitHubIssue> {
  try {
    const { repo, number } = issueOf(job);
    const issue = await ctx.api.getIssue(repo, number);
    if (issue.state === 'closed') await ctx.api.reopenIssue(repo, number);
    await ctx.api.removeLabels(repo, number, [LABEL_FAILED, LABEL_DONE, LABEL_REJECTED, LABEL_CLAIMED]);
    if (!issue.labels.includes(label)) await ctx.api.addLabels(repo, number, [label]);
    return await ctx.api.getIssue(repo, number);
  } catch (err) {
    throw sourceError(err);
  }
}

export async function reportToGitHub(ctx: ReportContext, r: SourceReport): Promise<State> {
  const state: State = { ...(r.job.sourceState?.source ?? {}) };
  try {
    return await apply(ctx, r, state);
  } catch (err) {
    throw sourceError(err);
  }
}
