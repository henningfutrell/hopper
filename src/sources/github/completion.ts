// The GitHub source's definition of done (issues #171, #187, #350, #579). A job that ended done is complete when
// its issue is **closed as complete** — by the merge of the job's own pull request, opened at or after the job's
// createdAt (a merge closes an issue only on the default branch, `dev`), or, no pull request closing it, closed as
// completed at or after the job's createdAt: by a commit, or with no code at all (issue #350) — or when the job's
// own pull request is open, ready for review (not a draft) and free of merge conflicts, and closes the issue when
// merged. A merge is never needed (issue #579: a pull request is done; a merge is only allowed, by yolo mode).
// Anything else — a local commit, a branch, a draft, an issue closed as not planned or before the job, an older pull
// request — is not complete; an error asking GitHub throws. A failed job whose issue is closed as complete is
// finished too (`closedAsComplete`, asked by the sync loop before it reports the failure): its work landed, and its
// pane ended after. A job whose own pull request ships part of the issue ("Part of #N") is partly done (`partlyDone`):
// not complete, and not failed either. A job whose own open pull request has merge conflicts, or is a draft, is not
// complete either, but one fixed step finishes it (`unfinishedPullRequest`, issue #626): rebase it, or mark it ready.

import type { Job, UnfinishedPullRequest, WorkPullRequest, WorkState } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest, GitHubApi, GitHubIssue, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from './api.ts';

/** The job's own pull request: opened at or after the job was created. */
export const isOwnPullRequest = <P extends { createdAt: string }>(pr: P | undefined, job: Job): pr is P =>
  pr !== undefined && Date.parse(pr.createdAt) >= Date.parse(job.createdAt);

/**
 * Closed as complete: by the job's own merged pull request (`closer`, the last close event's), or, no
 * pull request closing it, as completed at or after the job was created — a commit, or by hand (issue #350).
 */
export function isClosedAsComplete(issue: GitHubIssue, closer: ClosingPullRequest | undefined, job: Job): boolean {
  if (issue.state !== 'closed') return false;
  if (closer) return isOwnPullRequest(closer, job);
  return issue.stateReason === 'completed' && issue.closedAt !== undefined && Date.parse(issue.closedAt) >= Date.parse(job.createdAt);
}

/** Updated by the job (issue #618): its head commit made at or after the job was created. */
export const isUpdatedBy = (pr: Pick<OpenPullRequest, 'headCommittedAt'>, job: Job): boolean =>
  pr.headCommittedAt !== undefined && Date.parse(pr.headCommittedAt) >= Date.parse(job.createdAt);

/** The most pull requests an issue's text is asked about (issue #618). */
export const MAX_NAMED = 10;

/** The numbers of the pull requests an issue's text may name in its own repo (issue #618): `#N` or `…/pull/N`, its own number left out. */
export function namedNumbers(issue: Pick<GitHubIssue, 'repo' | 'number' | 'title' | 'body'>): number[] {
  const text = `${issue.title}\n${issue.body}`;
  const escaped = issue.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [
    ...[...text.matchAll(/(?<![\w/#&])#(\d+)\b/g)].map((m) => m[1]!),
    ...[...text.matchAll(new RegExp(`https://github\\.com/${escaped}/pull/(\\d+)\\b`, 'gi'))].map((m) => m[1]!),
  ].map(Number).filter((n) => n !== issue.number);
  return [...new Set(found)].slice(0, MAX_NAMED);
}

/** Pull request `n`, or undefined when GitHub says it is none (a permanent error: gone, no access). A transient error throws. */
async function pullRequestOrNone(api: GitHubApi, repo: string, n: number): Promise<NumberedPullRequest | undefined> {
  try {
    return await api.pullRequest(repo, n);
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return undefined;
    throw err;
  }
}

/**
 * Closed as completed (issue #637): by any pull request, commit or person, at any time. A merged pull request closing it
 * counts unless GitHub says not planned; closed as not planned is not done.
 */
export const isClosedAsCompleted = (issue: GitHubIssue, closer: ClosingPullRequest | undefined): boolean =>
  issue.state === 'closed' && (issue.stateReason === 'completed' || (closer !== undefined && issue.stateReason !== 'not_planned'));

/** Ready for review (issue #637): open, not a draft, free of merge conflicts. */
const isReady = (pr: { isDraft: boolean; conflicting: boolean }): boolean => !pr.isDraft && !pr.conflicting;

/** Merged at or after the job was created: on an issue still open, an older merge is work the job was asked to redo. */
const mergedSince = (pr: { mergedAt?: string }, job: Job): boolean => pr.mergedAt !== undefined && Date.parse(pr.mergedAt) >= Date.parse(job.createdAt);

/**
 * An issue that asks to update the pull requests it names (issue #637): a line — its title, or a line of its body — that
 * starts by asking to bring up to date, rebase, update or fix the conflicts of a pull request, and names one.
 */
const UPDATE_ASK = /^(please\s+)?(bring|rebase|update|refresh|fix\s+(the\s+)?(merge\s+)?conflicts)\b.*(#\d+|\/pull\/\d+)/i;
export const asksToUpdate = (issue: Pick<GitHubIssue, 'title' | 'body'>): boolean =>
  [issue.title, ...issue.body.split('\n')].some((l) => UPDATE_ASK.test(l.trim()));

/** A pull request's number, from its URL. */
const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/** How a pull request was found, for the miss's text: `#N (open, draft)`. */
function described(pr: { url: string; state: 'open' | 'closed' | 'merged'; isDraft: boolean; conflicting: boolean }): string {
  const why = pr.state !== 'open' ? [] : [...(pr.isDraft ? ['draft'] : []), ...(pr.conflicting ? ['merge conflicts'] : [])];
  return `#${numberOf(pr.url)} (${[pr.state, ...why].join(', ')})`;
}

/**
 * Whether the job's issue is done on GitHub (issue #637), decided from what GitHub shows, not from what the job did:
 * - its issue closed as completed, by anyone, at any time (`isClosedAsCompleted`);
 * - a pull request of its repo that closes or references the issue — opened by the job or before it, by any author —
 *   open and ready for review, or merged since the job began; one that ships only part of it ("Part of #N") is a part,
 *   not the whole (`partlyDone`);
 * - an issue that asks to update the pull requests it names (`asksToUpdate`): each of them free of merge conflicts, or
 *   merged, at any time; the job need not have pushed.
 * Undefined: done. Else why not, naming what was looked at. An error asking GitHub throws: the caller asks again.
 */
export async function notComplete(api: GitHubApi, job: Job): Promise<string | undefined> {
  const { repo, number, url } = job.source ?? {};
  if (!repo || !number) return `job ${job.id} has no GitHub issue reference`;
  const issue = await api.getIssue(repo, number);
  const closer = await api.closingPullRequest(repo, number);
  if (isClosedAsCompleted(issue, closer)) return undefined;
  const found = new Map<string, { url: string; state: 'open' | 'closed' | 'merged'; isDraft: boolean; conflicting: boolean }>();
  for (const pr of await api.openClosingPullRequests(repo, number)) {
    if (isReady(pr)) return undefined;
    found.set(pr.url, { ...pr, state: 'open' });
  }
  for (const pr of await api.referencingPullRequests(repo, number)) {
    if (pr.repo.toLowerCase() !== repo.toLowerCase() || isPartOf(pr, repo, number)) continue;
    if (pr.state === 'open' ? isReady(pr) : pr.state === 'merged' && mergedSince(pr, job)) return undefined;
    if (!found.has(pr.url)) found.set(pr.url, pr);
  }
  const lines = [issue.state === 'open' ? `the issue ${url ?? `${repo}#${number}`} is open`
    : `the issue ${url ?? `${repo}#${number}`} is ${issue.stateReason === 'not_planned' ? 'closed as not planned' : 'closed, not as completed'}`];
  lines.push(found.size === 0 ? `no pull request in ${repo} closes or references it`
    : `no pull request in ${repo} that closes or references it is ready for review or merged since the job began: ${[...found.values()].map(described).join(', ')}`);
  if (asksToUpdate(issue)) {
    const named: NumberedPullRequest[] = [];
    for (const n of namedNumbers(issue)) {
      const pr = await pullRequestOrNone(api, repo, n);
      if (pr) named.push(pr);
    }
    if (named.length > 0 && named.every((pr) => pr.state === 'merged' || (pr.state === 'open' && !pr.conflicting))) return undefined;
    if (named.length > 0) lines.push(`the pull requests it asks to update are not each merged or free of merge conflicts: ${named.map(described).join(', ')}`);
  }
  return lines.join(', and ');
}

/**
 * The job's own open pull request that one fixed step finishes (issue #626): one that closes the issue or ships part
 * of it, with merge conflicts (rebase it first) or a draft (mark it ready). The newest first; undefined: none.
 */
export async function unfinishedPullRequest(api: GitHubApi, job: Job): Promise<UnfinishedPullRequest | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  const parts = (await api.referencingPullRequests(repo, number)).filter((pr) => pr.state === 'open' && isPartOf(pr, repo, number));
  const own = [...await api.openClosingPullRequests(repo, number), ...parts]
    .filter((pr) => isOwnPullRequest(pr, job) && (pr.conflicting || pr.isDraft))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return own && { pullRequest: own.url, step: own.conflicting ? 'rebase' : 'mark_ready' };
}

/** A pull request that ships part of issue `n` of `repo` (issue #579): its own repo, its body saying "Part of #n". */
export const isPartOf = (pr: ReferencingPullRequest, repo: string, n: number): boolean =>
  pr.repo.toLowerCase() === repo.toLowerCase() && new RegExp(`\\bpart of #${n}\\b`, 'i').test(pr.body);

/**
 * The job's own pull request that ships part of its issue (issue #579): open, ready for review and free of merge
 * conflicts, or merged (yolo mode). Its URL, the newest first; undefined: none.
 */
export async function partlyDone(api: GitHubApi, job: Job): Promise<string | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  const parts = (await api.referencingPullRequests(repo, number))
    .filter((pr) => isPartOf(pr, repo, number) && isOwnPullRequest(pr, job) && (pr.state === 'merged' || (pr.state === 'open' && !pr.isDraft && !pr.conflicting)));
  return parts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.url;
}

/**
 * What a failed job's work shows on GitHub (issues #529, #621): its issue — open, closed as completed (`done`), closed
 * any other way, or gone — and the pull requests the job opened (created at or after the job) or pushed to (an
 * updated pull request, issue #618: an older one that closes the issue, one that mentions it, or one its text names),
 * each with its state. Undefined: no access (403), it cannot tell. A transient error throws, to be asked again.
 */
export async function workState(api: GitHubApi, job: Job): Promise<Omit<WorkState, 'checkedAt'> | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  let issue: GitHubIssue;
  try {
    issue = await api.getIssue(repo, number);
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return err.status === 404 || err.status === 410 ? { item: 'gone', pullRequests: [] } : undefined;
    throw err;
  }
  const found = new Map<string, WorkPullRequest>();
  const add = (pr: { url: string; createdAt: string; headCommittedAt?: string; isDraft: boolean; conflicting: boolean }, state: WorkPullRequest['state']): void => {
    const by = isOwnPullRequest(pr, job) ? 'opened' : isUpdatedBy(pr, job) ? 'updated' : undefined;
    if (by && !found.has(pr.url)) found.set(pr.url, { url: pr.url, number: numberOf(pr.url), by, state, draft: pr.isDraft, conflicting: state === 'open' && pr.conflicting });
  };
  const closer = await api.closingPullRequest(repo, number);
  if (closer) add({ ...closer, isDraft: false, conflicting: false }, 'merged');
  for (const pr of await api.openClosingPullRequests(repo, number)) add(pr, 'open');
  for (const pr of await api.referencingPullRequests(repo, number)) if (pr.repo.toLowerCase() === repo.toLowerCase()) add(pr, pr.state);
  for (const n of namedNumbers(issue)) {
    const pr = await pullRequestOrNone(api, repo, n);
    if (pr) add(pr, pr.state);
  }
  const item = issue.state === 'open' ? 'open' : issue.stateReason === 'completed' || closer !== undefined ? 'done' : 'closed';
  return { item, pullRequests: [...found.values()] };
}

/**
 * Whether a pull request of the job's own is open (issue #630), a timed-out job's liveness: one closing its issue that it
 * opened, or an older one it pushed to. A draft counts: it shows the job at work. An error throws: not known.
 */
export async function ownPullRequestOpen(api: GitHubApi, job: Job): Promise<boolean> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return false;
  return (await api.openClosingPullRequests(repo, number)).some((pr) => isOwnPullRequest(pr, job) || isUpdatedBy(pr, job));
}

/**
 * Whether the job's issue is closed as complete. A permanent error (the issue gone, no access) is not:
 * the failure is reported, and meets the same error there; a transient one throws, to be asked again.
 */
export async function closedAsComplete(api: GitHubApi, job: Job): Promise<boolean> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return false;
  try {
    const issue = await api.getIssue(repo, number);
    return isClosedAsCompleted(issue, await api.closingPullRequest(repo, number));
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return false;
    throw err;
  }
}
