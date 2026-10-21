// report(): what happened to a job, written to its issue. The hopper's only issue writes are
// labels; it posts no comment at all (owner decision, 2026-10-04: a finished issue needs no
// comment): claimed → `hopper:claimed`, with `hopper:held-by:<id>` naming its holder (issue #440); finished — only a job
// whose work is done or partly done is finished (completion.ts, issues #171, #187, #579) — → `hopper:pr-ready` while its
// pull request waits for review, `hopper:partly-done` for a part, `hopper:done` once the issue is closed as complete,
// `hopper:blocked` when no open pull request is found for it (issue #1891: never `hopper:pr-ready` with none); the
// merge of its pull request closes the issue, never report(), and `follow.ts` follows it after (and closes it only after the
// hopper's own merge of a pull request with no closing keyword, issue #677); failed → `hopper:failed`; rejected at the queue gate → the claim label goes and nothing
// else (issue #387: a rejection is the user's own record, kept on the job; a shared label would turn the issue
// away for every user and every hopper on the repo); cancelled → the claim label goes — a tend job's cancelled by no person
// and no source puts `hopper:pr-ready` back (issue #1010): its pull request waits, to be tended again. `hopper:rejected`
// written before then still keeps an issue out until a person removes it. Returns the source state unchanged.
// The labels follow the ledger (issue #1892 part 15): each end names the state it moves the item to (`reportLabels`,
// item-labels.ts), `labelsFor` that state names the end label, and the change, with the claim's, is GitHub outbox rows (act
// `report`), kept before they are sent and sent at once: a refusal for now no longer fails the report, and a claim not sent
// yet cancels out against the end that takes it off.
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
import { END_LABELS, HOLDER_LABEL_COLOR, HOLDER_LABEL_DESCRIPTION, HOPPER_LABELS, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED, holderLabel } from './labels.ts';
import { reportLabels, type LabelDrift, type ReportEnd } from './item-labels.ts';
import { claimLabels, isAssignedTo } from './discover.ts';
import { isPartOf, namesIssue, openClosingWork, worksOnAnotherIssue } from './completion.ts';
import type { GitHubIssue } from './api.ts';
import type { OutboxChange } from '../../domain/github-outbox.ts';
import type { GitHubOutbox } from './outbox.ts';

export interface ReportContext {
  api: GitHubApi;
  /** The hopper labels this process made sure of, as `<repo> <label>` (issue #1154: only the ones it adds). */
  ensuredLabels: Set<string>;
  /** This user's claim holder id (issue #440); absent: claims carry no holder label. */
  holder?: string;
  /** Tell the ledger the issue `key` was read closed (issue #1892), when it does not hold that yet; absent: it is not told. */
  issueClosed?(key: string, reason: string | undefined): void;
}

/**
 * Keeps the label change `change` of item `key` of `repo` (issue #1892 parts 14 and 15), tagged `tag`, and sends it: the GitHub
 * outbox's rows. A change with that tag on its way already is not kept twice. The rows tagged `replaces` not sent yet are dropped.
 */
export type LabelSink = (key: string, repo: string, change: LabelDrift, tag: string, replaces?: string) => Promise<void>;

/** What a job's report needs beyond the context of a give-back: where its label changes go. */
export interface JobReportContext extends ReportContext { labels: LabelSink }

type State = Record<string, unknown>;

function issueOf(job: Job): { repo: string; number: number } {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) throw new SourceError(`job ${job.id} has no GitHub issue reference`, true);
  return { repo, number };
}

/** Make sure `repo` has each hopper label of `names`, with its colour and description: once per label per process. */
export async function ensureLabels(ctx: ReportContext, repo: string, names: readonly string[]): Promise<void> {
  const own = [...HOPPER_LABELS, ...(ctx.holder ? [{ name: holderLabel(ctx.holder), color: HOLDER_LABEL_COLOR, description: HOLDER_LABEL_DESCRIPTION }] : [])];
  for (const l of own.filter((o) => names.includes(o.name))) {
    const key = `${repo} ${l.name}`;
    if (ctx.ensuredLabels.has(key)) continue;
    await ctx.api.ensureLabel(repo, l.name, l.color, l.description);
    ctx.ensuredLabels.add(key);
  }
}

/**
 * One label change on an issue: `remove` comes off, then `add` goes on. With `carried`, the issue's labels as just read
 * (issue #1154), a label it does not carry is not removed and one it carries is not added: a write that changes nothing
 * is not sent. Without it, every one is.
 */
export async function relabel(ctx: ReportContext, repo: string, number: number,
  c: { add?: readonly string[]; remove?: readonly string[]; carried?: readonly string[] }): Promise<void> {
  const add = (c.add ?? []).filter((l) => !c.carried?.includes(l));
  const remove = (c.remove ?? []).filter((l) => !c.add?.includes(l) && (!c.carried || c.carried.includes(l)));
  if (remove.length) await ctx.api.removeLabels(repo, number, [...new Set(remove)]);
  if (add.length) {
    await ensureLabels(ctx, repo, add);
    await ctx.api.addLabels(repo, number, add);
  }
}

/**
 * End of job `job` on its issue, which carries `carried` when just read: `hopper:claimed` and its holder label come off with
 * the end labels the end's state does not want, and its label goes on. Kept in the outbox, tagged with the job and the end.
 */
async function settle(ctx: JobReportContext, job: Job, repo: string, r: ReportEnd, carried?: readonly string[]): Promise<void> {
  const ends = reportLabels(r, carried);
  const claim = claimLabels(ctx.holder).filter((l) => !carried || carried.includes(l));
  const change = { remove: [...claim, ...ends.remove], add: ends.add };
  // Its claim not sent yet is dropped: it comes off all the same (a claim refused for now would else land after the end).
  if (change.remove.length || change.add.length) await ctx.labels(job.source!.key, repo, change, `${job.id}:${r.end}`, `${job.id}:claimed`);
}

/**
 * A done job's end on its issue (issue #579). A part: `hopper:partly-done`, its pull request kept to follow. The issue
 * closed as complete already: `hopper:done`. Else its pull request waits for review: `hopper:pr-ready`, the job's own
 * ready pull request kept to follow (`follow.ts`), else its newest open one in any state of review — a part's
 * `hopper:partly-done`. None open (issue #1891): `hopper:blocked`, never `hopper:pr-ready` with no pull request, and the
 * follow looks for one again. `hopper:failed` goes too: a failed job found done later ends here.
 * A proposal's job whose follow-ons go on with its work (issue #859) leaves the issue as it is, claimed, and follows
 * nothing: its follow-ons report the issue's end, and only a pull request one of them opens can make it done.
 */
async function finished(ctx: JobReportContext, job: Job, repo: string, number: number, state: State): Promise<State> {
  if (handedToFollowOns(job)) return state;
  const issue = await ctx.api.getIssue(repo, number);
  if (job.partlyDone) {
    await settle(ctx, job, repo, { end: 'pr_open', part: true }, issue.labels);
    return { ...state, pullRequest: job.partlyDone, follow: 'open', part: true };
  }
  if (issue.state === 'closed') {
    await settle(ctx, job, repo, { end: 'closed' }, issue.labels);
    // The ledger reads the close too (issue #1892): its item is done, not blocked for want of a pull request.
    if (job.source?.key) ctx.issueClosed?.(job.source.key, issue.stateReason);
    return state;
  }
  // The ready one that closes it, whoever opened it (issue #637): its own, or an older one a run again went on with; else
  // one that references it, or one named for it on its branch — what made it done —, so the Pull requests list links it.
  const open = await pullRequestOf(ctx.api, repo, number);
  await settle(ctx, job, repo, open ? { end: 'pr_open', part: open.part } : { end: 'no_pr' }, issue.labels);
  return { ...state, ...(open ? { pullRequest: open.url } : {}), ...(open?.part ? { part: true } : {}), follow: 'open' };
}

/**
 * The newest ready pull request that closes the issue, else one that references it, else one on a branch named for it —
 * never a part (issue #721): it ships part of the issue, on whatever branch. None ready (issue #1891): the newest open one
 * of those in any state of review, else the newest open part (`part`); undefined when none is open.
 */
async function pullRequestOf(api: GitHubApi, repo: string, number: number): Promise<{ url: string; part: boolean } | undefined> {
  const newest = <P extends { createdAt: string }>(prs: P[]): P | undefined => [...prs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const ready = <P extends { isDraft: boolean; conflicting: boolean; createdAt: string }>(prs: P[]): P | undefined => newest(prs.filter((pr) => !pr.isDraft && !pr.conflicting));
  const whole = (url: string) => ({ url, part: false });
  const closing = await openClosingWork(api, repo, number);
  const closes = ready(closing);
  if (closes) return whole(closes.url);
  const mentions = (await api.referencingPullRequests(repo, number))
    .filter((pr) => pr.repo.toLowerCase() === repo.toLowerCase() && !worksOnAnotherIssue(pr, repo, number));
  const parts = new Set(mentions.filter((pr) => isPartOf(pr, repo, number)).map((pr) => pr.url));
  const others = mentions.filter((pr) => pr.state === 'open' && !parts.has(pr.url));
  const mentioned = ready(others);
  if (mentioned) return whole(mentioned.url);
  const branch = (await api.openPullRequests(repo)).filter((pr) => namesIssue(pr.headRef, number) && !parts.has(pr.url));
  const any = ready(branch) ?? newest(closing) ?? newest(others) ?? newest(branch);
  if (any) return whole(any.url);
  const part = newest(mentions.filter((pr) => pr.state === 'open' && parts.has(pr.url)));
  return part && { url: part.url, part: true };
}

/** A tend job (issue #967) cancelled by no person and no source (issue #1010): `tendRetryAt` tends its pull request again. */
const tendTriedAgain = (job: Job): boolean => {
  const reason = job.sourceState?.sync?.cancelReason;
  return job.spec.tend === true && !(typeof reason === 'string' && DELIBERATE_CANCELS.includes(reason));
};

async function apply(ctx: JobReportContext, r: SourceReport, state: State): Promise<State> {
  const { job } = r;
  const { repo, number } = issueOf(job);
  switch (r.kind) {
    case 'claimed':
      await ctx.labels(job.source!.key, repo, { remove: [], add: claimLabels(ctx.holder) }, `${job.id}:claimed`);
      return state;
    case 'finished':
      return finished(ctx, job, repo, number, state);
    case 'failed':
      // The hopper fixes it itself (issue #1230): the issue stays as it is, claimed, never `hopper:failed` meanwhile.
      if (r.fixing) return state;
      await settle(ctx, job, repo, { end: 'failed' });
      return state;
    case 'cancelled':
      // A tend job cancelled not on purpose (issue #1010): its pull request still waits, and the hopper tends it again.
      await settle(ctx, job, repo, { end: 'cancelled', tendAgain: tendTriedAgain(job) });
      return state;
    case 'rejected':
      await settle(ctx, job, repo, { end: 'rejected' });
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
    await relabel(ctx, repo, number, { remove: [...END_LABELS, ...claimLabels(ctx.holder)], carried: issue.labels });
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

export async function reportToGitHub(ctx: JobReportContext, r: SourceReport): Promise<State> {
  const state: State = { ...(r.job.sourceState?.source ?? {}) };
  try {
    return await apply(ctx, r, state);
  } catch (err) {
    throw sourceError(err);
  }
}
