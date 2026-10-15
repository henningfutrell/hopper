// report(): what happened to a job, written to its issue. The hopper's only issue writes are
// labels; it posts no comment at all (owner decision, 2026-10-04: a finished issue needs no
// comment): claimed → `hopper:claimed`, with `hopper:held-by:<id>` naming its holder (issue #440); finished — only a job
// whose work is done or partly done is finished (completion.ts, issues #171, #187, #579) — → `hopper:pr-ready` while its
// pull request waits for review, `hopper:partly-done` for a part, `hopper:done` once the issue is closed as complete; the
// merge of its pull request closes the issue, never report(), and `follow.ts` follows it after (and closes it only after the
// hopper's own merge of a pull request with no closing keyword, issue #677); failed → `hopper:failed`; rejected at the queue gate → the claim label goes and nothing
// else (issue #387: a rejection is the user's own record, kept on the job; a shared label would turn the issue
// away for every user and every hopper on the repo); cancelled → the claim label goes — a tend job's cancelled by no person
// and no source puts `hopper:pr-ready` back (issue #1010): its pull request waits, to be tended again. `hopper:rejected`
// written before then still keeps an issue out until a person removes it. Returns the source state unchanged.
// Run again (`takeBack`, issues #313, #354) is one other issue write: an issue no longer assigned to the connected account
// is assigned to it (issue #1010), a closed issue is reopened, the end labels go and the source label comes back, so the new job runs and finishes against it. A person's resolution
// of a hand-off (`resolutionChanges`, issue #551; rows of the GitHub outbox, issue #1238) is the other, and the hopper's only comment: one short comment saying
// what was done, with the person's note and link, naming no person, and the end label it leaves the issue with. Rows written under
// earlier rules may still carry finalCommentId, claimCommentId, progressCommentId,
// questionComments and answeredComments; they are kept as stored and never read.

import { SourceError } from '../../domain/ports.ts';
import type { SourceReport } from '../../domain/ports.ts';
import { DELIBERATE_CANCELS, handedToFollowOns, type HandoffResolution, type Job, type ResolutionWrite } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import { END_LABELS, HOLDER_LABEL_COLOR, HOLDER_LABEL_DESCRIPTION, HOPPER_LABELS, LABEL_DONE, LABEL_FAILED, LABEL_PARTLY_DONE, LABEL_PR_READY, LABEL_REJECTED, holderLabel } from './labels.ts';
import { claimLabels, isAssignedTo } from './discover.ts';
import { isPartOf, namesIssue, worksOnAnotherIssue } from './completion.ts';
import type { GitHubIssue } from './api.ts';
import type { OutboxChange } from '../../domain/github-outbox.ts';
import type { GitHubOutbox } from './outbox.ts';

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

export async function ensureLabels(ctx: ReportContext, repo: string): Promise<void> {
  if (ctx.labelledRepos.has(repo)) return;
  for (const l of HOPPER_LABELS) await ctx.api.ensureLabel(repo, l.name, l.color, l.description);
  if (ctx.holder) await ctx.api.ensureLabel(repo, holderLabel(ctx.holder), HOLDER_LABEL_COLOR, HOLDER_LABEL_DESCRIPTION);
  ctx.labelledRepos.add(repo);
}

/** End of a job on its issue: drop `hopper:claimed`, its holder label and `also`, add the outcome label. */
async function settle(ctx: ReportContext, repo: string, number: number, add: string[], also: string[] = []): Promise<void> {
  await ctx.api.removeLabels(repo, number, [...claimLabels(ctx.holder), ...also]);
  if (add.length) {
    await ensureLabels(ctx, repo);
    await ctx.api.addLabels(repo, number, add);
  }
}

/**
 * A done job's end on its issue (issue #579). A part: `hopper:partly-done`, its pull request kept to follow. The issue
 * closed as complete already: `hopper:done`. Else its pull request waits for review: `hopper:pr-ready`, the job's own
 * open pull request kept to follow (`follow.ts`). `hopper:failed` goes too: a failed job found done later ends here.
 * A proposal's job whose follow-ons go on with its work (issue #859) leaves the issue as it is, claimed, and follows
 * nothing: its follow-ons report the issue's end, and only a pull request one of them opens can make it done.
 */
async function finished(ctx: ReportContext, job: Job, repo: string, number: number, state: State): Promise<State> {
  if (handedToFollowOns(job)) return state;
  const issue = await ctx.api.getIssue(repo, number);
  const also = issue.labels.includes(LABEL_FAILED) ? [LABEL_FAILED] : [];
  if (job.partlyDone) {
    await settle(ctx, repo, number, [LABEL_PARTLY_DONE], also);
    return { ...state, pullRequest: job.partlyDone, follow: 'open', part: true };
  }
  if (issue.state === 'closed') {
    await settle(ctx, repo, number, [LABEL_DONE], also);
    return state;
  }
  // The ready one that closes it, whoever opened it (issue #637): its own, or an older one a run again went on with; else
  // one that references it, or one named for it on its branch — what made it done —, so the Pull requests list links it.
  const own = await readyPullRequest(ctx.api, repo, number);
  await settle(ctx, repo, number, [LABEL_PR_READY], also);
  return { ...state, ...(own ? { pullRequest: own.url } : {}), follow: 'open' };
}

/**
 * The newest ready pull request that closes the issue, else one that references it, else one on a branch named for it.
 * Never a part (issue #721): it ships part of the issue, on whatever branch.
 */
async function readyPullRequest(api: GitHubApi, repo: string, number: number): Promise<{ url: string } | undefined> {
  const ready = <P extends { isDraft: boolean; conflicting: boolean; createdAt: string }>(prs: P[]): P | undefined =>
    prs.filter((pr) => !pr.isDraft && !pr.conflicting).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const closing = ready(await api.openClosingPullRequests(repo, number));
  if (closing) return closing;
  const mentions = (await api.referencingPullRequests(repo, number))
    .filter((pr) => pr.repo.toLowerCase() === repo.toLowerCase() && !worksOnAnotherIssue(pr.body, repo, number));
  const parts = new Set(mentions.filter((pr) => isPartOf(pr, repo, number)).map((pr) => pr.url));
  return ready(mentions.filter((pr) => pr.state === 'open' && !parts.has(pr.url)))
    ?? ready((await api.openPullRequests(repo)).filter((pr) => namesIssue(pr.headRef, number) && !parts.has(pr.url)));
}

/** A tend job (issue #967) cancelled by no person and no source (issue #1010): `tendRetryAt` tends its pull request again. */
const tendTriedAgain = (job: Job): boolean => {
  const reason = job.sourceState?.sync?.cancelReason;
  return job.spec.tend === true && !(typeof reason === 'string' && DELIBERATE_CANCELS.includes(reason));
};

async function apply(ctx: ReportContext, r: SourceReport, state: State): Promise<State> {
  const { job } = r;
  const { repo, number } = issueOf(job);
  switch (r.kind) {
    case 'claimed':
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, claimLabels(ctx.holder));
      return state;
    case 'finished':
      return finished(ctx, job, repo, number, state);
    case 'failed':
      // The hopper fixes it itself (issue #1230): the issue stays as it is, claimed, never `hopper:failed` meanwhile.
      if (r.fixing) return state;
      await settle(ctx, repo, number, [LABEL_FAILED]);
      return state;
    case 'cancelled':
      // A tend job cancelled not on purpose (issue #1010): its pull request still waits, and the hopper tends it again.
      await settle(ctx, repo, number, tendTriedAgain(job) ? [LABEL_PR_READY] : []);
      return state;
    case 'rejected':
      await settle(ctx, repo, number, []);
      return state;
  }
}

/** A GitHub error as the SourceError the sync loop reads (permanent or not). */
export function sourceError(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof GitHubApiError) return new SourceError(err.message, err.permanent, err.status);
  return new SourceError((err as Error).message, false);
}

/**
 * Give an ended job's issue back for Run again (issues #313, #354): a closed issue is reopened — the new
 * job is cancelled while it is closed, and its pull request's merge closes it again —, the end labels
 * (`hopper:failed`, `hopper:done`, `hopper:rejected`) and `hopper:claimed` go, and the source label comes
 * back if it was taken off. Answers the issue as it stands after. An issue no longer assigned to `assignee`, the
 * connected account, is assigned to it first (issue #1010): else its new job would be cancelled at once (issue #527), and
 * Run again, Continue and tending would stop on a step the hopper can take itself.
 */
export async function takeBack(ctx: ReportContext, label: string, job: Job, assignee: string | undefined): Promise<GitHubIssue> {
  try {
    const { repo, number } = issueOf(job);
    const issue = await ctx.api.getIssue(repo, number);
    if (assignee !== undefined && !isAssignedTo(issue, assignee)) await ctx.api.addAssignees(repo, number, [assignee]);
    if (issue.state === 'closed') await ctx.api.reopenIssue(repo, number);
    await ctx.api.removeLabels(repo, number, [...END_LABELS, ...claimLabels(ctx.holder)]);
    if (!issue.labels.includes(label)) await ctx.api.addLabels(repo, number, [label]);
    return await ctx.api.getIssue(repo, number);
  } catch (err) {
    throw sourceError(err);
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
 * do `hopper:rejected` — either way not taken again —, in place of `hopper:failed` and the claim; Continue and I fixed it
 * took it back already (`takeBack`). Then the comment. The changes, as rows of the GitHub outbox (issue #1238).
 */
export function resolutionChanges(r: HandoffResolution, holder?: string): OutboxChange[] {
  const end = r.action === 'done_by_hand' ? LABEL_DONE : r.action === 'wont_do' ? LABEL_REJECTED : undefined;
  const labels: OutboxChange[] = end ? [{ op: 'remove_labels', labels: [...claimLabels(holder), LABEL_FAILED] }, { op: 'add_labels', labels: [end] }] : [];
  return [...labels, { op: 'comment', body: resolutionComment(r) }];
}

/**
 * A resolution kept in the source's GitHub outbox (issue #1238), once, tagged with the job and the resolution's time;
 * asked again, where its rows stand. One that failed before its rows were kept is not sent again by itself: no comment twice.
 */
export function keepResolution(outbox: GitHubOutbox, job: Job, r: HandoffResolution, holder?: string): Promise<ResolutionWrite> {
  try {
    const { repo } = issueOf(job);
    const key = job.source!.key;
    const tag = `${job.id}@${r.at}`;
    const now = outbox.resolution(key, tag);
    if (now) return Promise.resolve(now);
    if (r.writeBack === 'failed') return Promise.resolve({ state: 'failed', error: r.writeBackError ?? 'failed' });
    outbox.queue('resolve', key, repo, resolutionChanges(r, holder).map((change) => ({ change })), { tag });
    return Promise.resolve({ state: 'pending' });
  } catch (err) {
    return Promise.reject(sourceError(err));
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
