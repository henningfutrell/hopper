// report(): what happened to a job, written to its issue. The hopper's only issue writes are
// labels; it posts no comment at all (owner decision, 2026-10-04: a finished issue needs no
// comment): claimed → `hopper:claimed`, with `hopper:held-by:<id>` naming its holder (issue #440); finished → `hopper:done` — only a job whose work reached
// its completion is finished (completion.ts, issues #171, #187), and the merge of its pull request
// closes the issue, never the hopper (with completion `pull-request` the issue stays open until a
// person merges); failed → `hopper:failed`; rejected at the queue gate → the claim label goes and nothing
// else (issue #387: a rejection is the user's own record, kept on the job; a shared label would turn the issue
// away for every user and every hopper on the repo); cancelled → the claim label goes. `hopper:rejected`
// written before then still keeps an issue out until a person removes it. Returns the source state unchanged.
// Run again (`takeBack`, issues #313, #354) is one other issue write: a closed issue is reopened, the
// end labels go and the source label comes back, so the new job runs and finishes against it. A person's resolution
// of a hand-off (`writeResolution`, issue #551) is the other, and the hopper's only comment: one short comment saying
// what was done, with the person's note and link, naming no person, and the end label it leaves the issue with. Rows written under
// earlier rules may still carry finalCommentId, claimCommentId, progressCommentId,
// questionComments and answeredComments; they are kept as stored and never read.

import { SourceError } from '../../domain/ports.ts';
import { RerunRefused } from '../../domain/rerun-refused.ts';
import type { SourceReport } from '../../domain/ports.ts';
import type { HandoffResolution, Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import { HOLDER_LABEL_COLOR, HOLDER_LABEL_DESCRIPTION, HOPPER_LABELS, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED, holderLabel } from './labels.ts';
import { claimLabels, isAssignedTo } from './discover.ts';
import type { GitHubIssue } from './api.ts';

export interface ReportContext {
  api: GitHubApi;
  /** Repos whose hopper labels were ensured by this process. */
  labelledRepos: Set<string>;
  /** This user's claim holder id (issue #440); absent: claims carry no holder label. */
  holder?: string;
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
  if (ctx.holder) await ctx.api.ensureLabel(repo, holderLabel(ctx.holder), HOLDER_LABEL_COLOR, HOLDER_LABEL_DESCRIPTION);
  ctx.labelledRepos.add(repo);
}

/** End of a job on its issue: drop `hopper:claimed` and its holder label, add the outcome label. */
async function settle(ctx: ReportContext, repo: string, number: number, add: string[]): Promise<void> {
  await ctx.api.removeLabels(repo, number, claimLabels(ctx.holder));
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
      await ctx.api.addLabels(repo, number, claimLabels(ctx.holder));
      return state;
    case 'finished':
      await settle(ctx, repo, number, [LABEL_DONE]);
      return state;
    case 'failed':
      await settle(ctx, repo, number, [LABEL_FAILED]);
      return state;
    case 'cancelled':
    case 'rejected':
      await settle(ctx, repo, number, []);
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
 * back if it was taken off. Answers the issue as it stands after. An issue no longer assigned to `assignee`, the
 * connected account, is refused before anything is written (issue #527): its new job would be cancelled at once.
 */
export async function takeBack(ctx: ReportContext, label: string, job: Job, assignee: string | undefined): Promise<GitHubIssue> {
  try {
    const { repo, number } = issueOf(job);
    const issue = await ctx.api.getIssue(repo, number);
    if (assignee !== undefined && !isAssignedTo(issue, assignee)) {
      throw new RerunRefused(`its issue is not assigned to the connected account ${assignee}: assign it (Sources, Assign to me) and run it again`);
    }
    if (issue.state === 'closed') await ctx.api.reopenIssue(repo, number);
    await ctx.api.removeLabels(repo, number, [LABEL_FAILED, LABEL_DONE, LABEL_REJECTED, ...claimLabels(ctx.holder)]);
    if (!issue.labels.includes(label)) await ctx.api.addLabels(repo, number, [label]);
    return await ctx.api.getIssue(repo, number);
  } catch (err) {
    throw err instanceof RerunRefused ? err : sourceError(err);
  }
}

/** What a resolution says it did, in the comment's first line. */
const RESOLVED_AS: Record<HandoffResolution['action'], (r: HandoffResolution) => string> = {
  continue: (r) => (r.resumed === false ? 'continued in a new job, with a note' : 'continued in the same session, with a note'),
  fixed: () => 'the cause was fixed outside the job; it runs again',
  done_by_hand: () => 'done by hand',
  wont_do: () => 'won\'t do',
};

/** The comment: what was done, the note quoted, the link. Neutral: it names nobody, the resolver included. */
export function resolutionComment(r: HandoffResolution): string {
  const lines = [`Resolved from Needs a person: ${RESOLVED_AS[r.action](r)}.`];
  if (r.note) lines.push('', ...r.note.split('\n').map((l) => `> ${l}`));
  if (r.link) lines.push('', `Link: ${r.link}`);
  return lines.join('\n');
}

/**
 * Tell the issue a person's resolution of its job's hand-off (issue #551): Done by hand leaves it `hopper:done`, Won't
 * do `hopper:rejected` — either way not taken again —, in place of `hopper:failed`; Continue and I fixed it took it back
 * already (`takeBack`). Then the comment.
 */
export async function writeResolution(ctx: ReportContext, job: Job, r: HandoffResolution): Promise<void> {
  try {
    const { repo, number } = issueOf(job);
    if (r.action === 'done_by_hand') await settle(ctx, repo, number, [LABEL_DONE]);
    if (r.action === 'wont_do') await settle(ctx, repo, number, [LABEL_REJECTED]);
    if (r.action === 'done_by_hand' || r.action === 'wont_do') await ctx.api.removeLabels(repo, number, [LABEL_FAILED]);
    await ctx.api.postComment(repo, number, resolutionComment(r));
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
