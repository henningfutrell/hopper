// The GitHub source's definition of done (issues #171, #187, #350, #579). A job that ended done is complete when
// its issue is **closed as complete** — by the merge of the job's own pull request, opened at or after the job's
// createdAt (a merge closes an issue only on the default branch, `dev`), or, no pull request closing it, closed as
// completed at or after the job's createdAt: by a commit, or with no code at all (issue #350) — or when the job's
// own pull request is open, ready for review (not a draft), free of merge conflicts and with no failing checks (issue
// #736; checks still running do not count against it), and closes the issue when merged. A merge is never needed (issue #579: a pull request is done; a merge is only allowed, by yolo mode).
// Anything else — a local commit, a branch, a draft, an issue closed as not planned or before the job, an older pull
// request — is not complete; an error asking GitHub throws. A failed job whose issue is closed as complete is
// finished too: the sync loop asks the work-item ledger before it reports the failure, and reads the issue
// (`issueState`) as ledger input only when the ledger does not hold it closed (issue #1067): its work landed, and its
// pane ended after. A job whose own pull request ships part of the issue ("Part of #N") is partly done (`partlyDone`):
// not complete, and not failed either. A job whose own open pull request has merge conflicts, failing checks, or is a
// draft, is not complete either, but one fixed step finishes it (`unfinishedPullRequest`, issues #626, #736): rebase it,
// fix its checks, or mark it ready. A job that reworks a pull request a person sent back (`job.rework`, issue #724)
// counts that pull request only once it pushed to it: ready for review again with no push since is not done, and it is
// the job's own for a part and a finish step. A job whose own pull request is there, ready but for its red checks, is said so
// by number and failed checks (issue #1230, `redChecksLine`): the assessor's cause Own PR checks red, not Not complete.

import type { ChecksState, Job, OwnPullRequestChecks, UnfinishedPullRequest, WorkPullRequest, WorkState } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import { closingReferences } from '../../domain/cross-references.ts';
import { BATCH_BRANCH_PREFIX, RELEASE_BRANCHES } from '../../domain/landing-batches.ts';
import { pullRequestRepo } from '../../domain/pull-requests.ts';
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

/** Ready for review (issue #637): open, not a draft, free of merge conflicts, and its checks not failing (issue #736). */
const isReady = (pr: { isDraft: boolean; conflicting: boolean; checks?: string }): boolean => !pr.isDraft && !pr.conflicting && pr.checks !== 'failing';

/** The pull request the job reworks (issue #724), with no push from the job since: it does not count as done yet. */
const reworkUnpushed = (pr: { url: string; headCommittedAt?: string }, job: Job): boolean => job.rework?.pullRequest === pr.url && !isUpdatedBy(pr, job);

/** The job's own pull request (opened by it), or the one it reworks (issue #724). */
const isOwnOrReworked = (pr: { url: string; createdAt: string }, job: Job): boolean => job.rework?.pullRequest === pr.url || isOwnPullRequest(pr, job);

/** Merged at or after the job was created: on an issue still open, an older merge is work the job was asked to redo. */
const mergedSince = (pr: { mergedAt?: string }, job: Job): boolean => pr.mergedAt !== undefined && Date.parse(pr.mergedAt) >= Date.parse(job.createdAt);

/**
 * An issue that asks to update the pull requests it names (issue #637): a line — its title, or a line of its body — that
 * starts by asking to bring up to date, rebase, update or fix the conflicts of a pull request, and names one.
 */
const UPDATE_ASK = /^(please\s+)?(bring|rebase|update|refresh|fix\s+(the\s+)?(merge\s+)?conflicts)\b.*(#\d+|\/pull\/\d+)/i;
export const asksToUpdate = (issue: Pick<GitHubIssue, 'title' | 'body'>): boolean =>
  [issue.title, ...issue.body.split('\n')].some((l) => UPDATE_ASK.test(l.trim()));

/**
 * A branch named for issue `n` (issue #637): `issue-N`, `issue_N` or `issueN` anywhere, or `N-…` at its start or after a
 * slash (`fix/N-thing`); not `fix-N`, which names a number, not an issue.
 */
export const namesIssue = (branch: string, n: number): boolean =>
  new RegExp(`(^|[/_-])issue[-_]?${n}(?!\\d)|(^|/)${n}(?=[-_]|$)`, 'i').test(branch);

/** A pull request's number, from its URL. */
const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/** How a pull request was found, for the miss's text: `#N (open, draft)`, `owner/name#N (…)` in another repository than `repo`'s. */
function described(pr: { url: string; state: 'open' | 'closed' | 'merged'; isDraft: boolean; conflicting: boolean; checks?: string }, repo: string): string {
  const why = pr.state !== 'open' ? [] : [...(pr.isDraft ? ['draft'] : []), ...(pr.conflicting ? ['merge conflicts'] : []), ...(pr.checks === 'failing' ? ['checks failing'] : [])];
  const of = pullRequestRepo(pr.url, repo);
  return `${of.toLowerCase() === repo.toLowerCase() ? '' : of}#${numberOf(pr.url)} (${[pr.state, ...why].join(', ')})`;
}

/**
 * Whether a pull request that mentions the issue of `repo` is looked at for it (issue #2004): one of `repo`, or the job's
 * own in another repository (opened, updated or reworked by it) — its change lands there, as infrastructure code does.
 */
const looksAt = (pr: ReferencingPullRequest, repo: string, job: Job): boolean =>
  pr.repo.toLowerCase() === repo.toLowerCase() || isOwnOrReworked(pr, job) || isUpdatedBy(pr, job);

/** The pull requests a job opened through the hopper's GitHub proxy (issue #2510): their URLs, the newest first. */
export type JobOpenedPullRequests = (jobId: string) => readonly string[];

/** How many of the pull requests a job opened through the hopper are read for its own open one (issue #2510). */
const MAX_OPENED = 5;

/**
 * The job's own open pull request that the issue's links in its repository miss (issue #2510): one of another repository
 * that mentions the issue, opened or updated by the job (`looksAt`, issue #2004), and not another issue's work; else the
 * newest one the job opened through the hopper (`opened`) that is still open, in any repository, whatever its text or branch
 * says: the job reported it, so a base-branch update by someone else or a closing keyword only in its title does not unlink it.
 * A part ("Part of #N") is said so. `mentions`: the pull requests that mention the issue, as just read. Undefined: none.
 * An error asking GitHub throws.
 */
export async function ownOpenPullRequestOf(api: GitHubApi, job: Job, repo: string, number: number, mentions: readonly ReferencingPullRequest[], opened?: JobOpenedPullRequests): Promise<{ url: string; part: boolean } | undefined> {
  const elsewhere = mentions
    .filter((pr) => pr.state === 'open' && pr.repo.toLowerCase() !== repo.toLowerCase() && looksAt(pr, repo, job)
      && (isPartOf(pr, repo, number) || !worksOnAnotherIssue(pr, repo, number)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (elsewhere) return { url: elsewhere.url, part: isPartOf(elsewhere, repo, number) };
  for (const url of (opened?.(job.id) ?? []).slice(0, MAX_OPENED)) {
    const pr = await pullRequestOrNone(api, pullRequestRepo(url, repo), numberOf(url));
    if (pr?.state === 'open') return { url: pr.url, part: false };
  }
  return undefined;
}

/** An issue whose deliverable is an artifact, not a code change (issue #673): a line of its body says `Deliverable: artifact`. */
const DELIVERABLE_ARTIFACT = /^\s*deliverable:\s*artifact\s*$/im;
export const isArtifactDeliverable = (issue: Pick<GitHubIssue, 'body'>): boolean => DELIVERABLE_ARTIFACT.test(issue.body);

/** Whether issue `n` of `repo` waits on its batch run (issue #1337, batch-wait.ts); a merge at or after `since` counts at any age. */
export type WaitsOnBatch = (repo: string, n: number, since: string) => Promise<boolean>;

/** The artifacts a job made (issue #673): each one's id, and the URL of the issue it is linked to. */
export type JobArtifacts = (jobId: string) => { id: string; issue?: string }[];

/**
 * For an issue whose deliverable is an artifact (issue #673): undefined when the job made one linked to the issue and a
 * comment on the issue names it — its link or its id; else why not.
 */
async function artifactMissing(api: GitHubApi, job: Job, artifacts: JobArtifacts | undefined): Promise<string> {
  const { repo, number, url } = job.source!;
  const linked = (artifacts?.(job.id) ?? []).filter((a) => a.issue === url);
  if (linked.length === 0) return 'the issue asks for an artifact, and the job made none linked to it';
  const comments = await api.listComments(repo!, number!);
  if (comments.some((c) => linked.some((a) => c.body.includes(a.id)))) return '';
  return `the issue asks for an artifact, and no comment on it names the job's artifact (${linked.map((a) => a.id).join(', ')}): sh "$HOPPER_ARTIFACT" share ID --owner posts its link there`;
}

/**
 * Whether the job's issue is done on GitHub (issue #637), decided from what GitHub shows, not from what the job did:
 * - its issue closed as completed, by anyone, at any time (`isClosedAsCompleted`);
 * - a pull request of its repo that closes or references the issue — opened by the job or before it, by any author —
 *   or the job's own in another repository (`looksAt`, issue #2004), open and ready for review, or merged since the job began; one that ships only part of it ("Part of #N") is a part,
 *   not the whole (`partlyDone`); one that only mentions it and closes or ships part of another issue is that issue's
 *   work, not this one's (`worksOnAnotherIssue`, issue #786), and one from a release branch (a promotion) is no issue's
 *   work (`fromReleaseBranch`, issue #876);
 * - an open pull request of its repo on a branch named for the issue (`namesIssue`), ready for review, unless it ships a
 *   part (issue #721);
 * - an issue that asks to update the pull requests it names (`asksToUpdate`): each of them free of merge conflicts, or
 *   merged, at any time; the job need not have pushed;
 * - an issue whose deliverable is an artifact (`isArtifactDeliverable`, issue #673): an artifact the job made, linked
 *   to the issue, named by a comment on it;
 * - an issue that waits on its batch run (`waits`, issue #1337, batch-wait.ts): its work merged into the landing branch,
 *   which GitHub does not close it for, by the job or before it while its batch run is still to come.
 * Undefined: done. Else why not, naming what was looked at. An error asking GitHub throws: the caller asks again.
 */
export async function notComplete(api: GitHubApi, job: Job, artifacts?: JobArtifacts, waits?: WaitsOnBatch): Promise<string | undefined> {
  const { repo, number, url } = job.source ?? {};
  if (!repo || !number) return `job ${job.id} has no GitHub issue reference`;
  const issue = await api.getIssue(repo, number);
  const closer = await api.closingPullRequest(repo, number);
  if (isClosedAsCompleted(issue, closer)) return undefined;
  const artifact = isArtifactDeliverable(issue) ? await artifactMissing(api, job, artifacts) : undefined;
  if (artifact === '') return undefined;
  const found = new Map<string, { url: string; state: 'open' | 'closed' | 'merged'; isDraft: boolean; conflicting: boolean; checks?: string }>();
  let unpushed: string | undefined;
  // Ready, and not the reworked pull request with no push since (issue #724).
  const counts = (pr: { url: string; isDraft: boolean; conflicting: boolean; checks?: string; headCommittedAt?: string }): boolean => {
    if (!isReady(pr)) return false;
    if (!reworkUnpushed(pr, job)) return true;
    unpushed = pr.url;
    return false;
  };
  for (const pr of await openClosingWork(api, repo, number)) {
    if (counts(pr)) return undefined;
    found.set(pr.url, { ...pr, state: 'open' });
  }
  const parts = new Set<string>();
  for (const pr of await api.referencingPullRequests(repo, number)) {
    if (!looksAt(pr, repo, job)) continue;
    if (isPartOf(pr, repo, number)) { parts.add(pr.url); continue; }
    if (worksOnAnotherIssue(pr, repo, number)) continue;
    if (pr.state === 'open' ? counts(pr) : pr.state === 'merged' && mergedSince(pr, job)) return undefined;
    if (!found.has(pr.url)) found.set(pr.url, pr);
  }
  // A pull request that names the issue only on its branch (issue #637): no cross-reference shows it. A part on such a
  // branch is still a part (issue #721).
  for (const pr of await api.openPullRequests(repo)) {
    if (!namesIssue(pr.headRef, number) || found.has(pr.url) || parts.has(pr.url)) continue;
    if (counts(pr)) return undefined;
    found.set(pr.url, { ...pr, state: 'open' });
  }
  if (issue.state === 'open' && await waits?.(repo, number, job.createdAt)) return undefined;
  const lines = [issue.state === 'open' ? `the issue ${url ?? `${repo}#${number}`} is open`
    : `the issue ${url ?? `${repo}#${number}`} is ${issue.stateReason === 'not_planned' ? 'closed as not planned' : 'closed, not as completed'}`];
  // The job's own pull request with red checks (issue #1230): said by its number and its failed checks, never hidden as none.
  const own = await ownPullRequestChecks(api, job);
  const red = own?.checks === 'failing' ? own : undefined;
  if (red) lines.push(redChecksLine(red));
  // The job's own pull request with merge conflicts or as a draft (issue #1265): said by its number and its step, so the
  // assessor sends the job back to finish it, never a person.
  const unfinished = red ? undefined : await unfinishedPullRequest(api, job);
  if (unfinished && unfinished.step !== 'fix_checks') lines.push(unfinishedLine(unfinished));
  if (!red || found.size > 0) {
    lines.push(found.size === 0 ? `no pull request in ${repo} closes or references it`
      : `no pull request in ${repo} that closes or references it is ready for review or merged since the job began: ${[...found.values()].map((pr) => described(pr, repo)).join(', ')}`);
  }
  if (unpushed !== undefined) lines.push(`the pull request sent back for rework, #${numberOf(unpushed)}, has no push since the rework`);
  if (artifact !== undefined) lines.push(artifact);
  if (asksToUpdate(issue)) {
    const named: NumberedPullRequest[] = [];
    for (const n of namedNumbers(issue)) {
      const pr = await pullRequestOrNone(api, repo, n);
      if (pr) named.push(pr);
    }
    if (named.length > 0 && named.every((pr) => pr.state === 'merged' || (pr.state === 'open' && !pr.conflicting))) return undefined;
    if (named.length > 0) lines.push(`the pull requests it asks to update are not each merged or free of merge conflicts: ${named.map((pr) => described(pr, repo)).join(', ')}`);
  }
  return lines.join(', and ');
}

/**
 * The job's open pull requests of its issue: opened by it, updated by it, or the one it reworks; closing the issue, shipping
 * part of it, or only referencing it in its own repository with no closing keyword for another issue (issue #1522: a
 * referencing one is the job's too, so its miss names it by number), in its own repository or another (issue #2004).
 */
export async function ownOpenPullRequests(api: GitHubApi, job: Job, repo: string, number: number): Promise<OpenPullRequest[]> {
  const referencing = (await api.referencingPullRequests(repo, number)).filter((pr) => pr.state === 'open' && looksAt(pr, repo, job)
    && (isPartOf(pr, repo, number) || !worksOnAnotherIssue(pr, repo, number)));
  const closing = await openClosingWork(api, repo, number);
  const all = [...closing, ...referencing.filter((pr) => !closing.some((c) => c.url === pr.url))];
  return all.filter((pr) => isOwnOrReworked(pr, job) || isUpdatedBy(pr, job));
}

/**
 * The job's own open pull request that one fixed step finishes (issue #626): one that closes the issue or ships part
 * of it, with merge conflicts (rebase it first), failing checks (fix them, issue #736) or a draft (mark it ready). The
 * one it reworks counts as its own (issue #724), and so does one it pushed to (issue #1265: a job of its item run again),
 * and one that only references the issue (issue #1522).
 * The newest first; undefined: none.
 */
export async function unfinishedPullRequest(api: GitHubApi, job: Job): Promise<UnfinishedPullRequest | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  const own = (await ownOpenPullRequests(api, job, repo, number))
    .filter((pr) => pr.conflicting || pr.checks === 'failing' || pr.isDraft)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return own && { pullRequest: own.url, step: own.conflicting ? 'rebase' : own.checks === 'failing' ? 'fix_checks' : 'mark_ready' };
}

/** `PR #N: checks failed: <names>` (issue #1230): what the job's miss says of its own pull request with red checks. */
export const redChecksLine = (own: OwnPullRequestChecks): string =>
  `PR #${numberOf(own.pullRequest)}: checks failed: ${own.failed.length > 0 ? own.failed.map((c) => c.name).join(', ') : 'names not known'}`;

/** `PR #N: merge conflicts with its base` or `PR #N: a draft` (issue #1265): what the job's miss says of its own unfinished pull request. */
export const unfinishedLine = (u: UnfinishedPullRequest): string =>
  `PR #${numberOf(u.pullRequest)}: ${u.step === 'rebase' ? 'merge conflicts with its base' : 'a draft'}`;

/**
 * The job's own open pull request and its checks (issue #1230): opened by the job, updated by it, or the one it reworks;
 * closing its issue or shipping part of it; ready but for its checks (not a draft, no merge conflicts); the newest first.
 * Failing: its failed checks as GitHub names them, read by its number. Undefined: none. An error asking GitHub throws.
 */
export async function ownPullRequestChecks(api: GitHubApi, job: Job): Promise<OwnPullRequestChecks | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  const own = (await ownOpenPullRequests(api, job, repo, number))
    .filter((pr) => !pr.isDraft && !pr.conflicting)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!own) return undefined;
  const read = own.checks === 'failing' ? await pullRequestOrNone(api, pullRequestRepo(own.url, repo), numberOf(own.url)) : undefined;
  const checks = read ? read.checks : own.checks;
  const headOid = read?.headOid ?? own.headOid;
  return {
    pullRequest: own.url, ...(headOid ? { headOid } : {}), ...(checks ? { checks } : {}),
    failed: checks === 'failing' ? read?.failedChecks ?? own.failedChecks ?? [] : [],
  };
}

/**
 * A pull request that ships part of issue `n` of `repo` (issue #579): its body says "Part of #n" in its own repo, or, in
 * any repo (issue #2004: the change lands in another one), "Part of repo#n" or the issue's URL; never one from a release
 * branch (issue #876).
 */
export function isPartOf(pr: ReferencingPullRequest, repo: string, n: number): boolean {
  if (fromReleaseBranch(pr)) return false;
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = pr.repo.toLowerCase() === repo.toLowerCase() ? '#|' : '';
  return new RegExp(`\\bpart of (?:${bare}${escaped}#|https://github\\.com/${escaped}/issues/)${n}(?!\\d)`, 'i').test(pr.body);
}

/**
 * A pull request body that closes issue `n` of `repo` with one of GitHub's closing keywords (issues #721, #430): close,
 * closes, closed, fix, fixes, fixed, resolve, resolves or resolved, then `#n`, `repo#n` or the issue's URL
 * (`closingReferences`).
 */
export const closesByKeyword = (body: string, repo: string, n: number): boolean =>
  closingReferences(body, repo).some((r) => r.number === n && r.repo.toLowerCase() === repo.toLowerCase());

/**
 * A pull request from a release branch (issue #876): a promotion, `dev` into `beta`, whose body lists the issues it
 * carries; or from a batch run's branch (`hopper-batch/…`, issue #2132): a batch run of the landing branch into the
 * tested branch, whose body closes the issues of its job pull requests, or a bisect run or a back-merge. It is no issue's
 * work, whatever its body says: never followed as a job's pull request, so its close without a merge flags no issue.
 */
export const fromReleaseBranch = (pr: { headRef?: string }): boolean =>
  pr.headRef !== undefined && (RELEASE_BRANCHES.includes(pr.headRef.toLowerCase()) || pr.headRef.startsWith(BATCH_BRANCH_PREFIX));

/** The open pull requests whose merge closes issue `n` of `repo` and that are its work: none from a release branch (`fromReleaseBranch`). */
export const openClosingWork = async (api: GitHubApi, repo: string, n: number): Promise<OpenPullRequest[]> =>
  (await api.openClosingPullRequests(repo, n)).filter((pr) => !fromReleaseBranch(pr));

/**
 * A pull request that only mentions issue `n` and is not its work (issues #786, #876): one from a release branch
 * (`fromReleaseBranch`), or one that closes or ships part of another issue of `repo` — that issue's work. Its mention of
 * `n` ("depends on #n") never makes `n` done, it is never followed for `n`, and its merge never closes `n`.
 */
export function worksOnAnotherIssue(pr: { body: string; headRef?: string; repo?: string }, repo: string, n: number): boolean {
  if (fromReleaseBranch(pr)) return true;
  const { body } = pr;
  // `#N` in a pull request of another repository names that repository's issue (issue #2004).
  const from = pr.repo ?? repo;
  if (closingReferences(body, from).some((r) => r.number === n && r.repo.toLowerCase() === repo.toLowerCase())) return false;
  const elsewhere = from.toLowerCase() !== repo.toLowerCase();
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = `(?:(#)|${escaped}#|https://github\\.com/${escaped}/issues/)(\\d+)(?!\\d)`;
  return [...body.matchAll(new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part\\s+of)\\s*:?\\s+${target}`, 'gi'))]
    .some((m) => (elsewhere && m[1] !== undefined) || Number(m[2]) !== n);
}

/**
 * The job's own pull request that ships part of its issue (issue #579): open, ready for review (`isReady`), or merged
 * (yolo mode). Its own: opened by the job, or updated by it — a tend of a waiting part (issue #736). Its URL, the newest
 * first; undefined: none.
 */
export async function partlyDone(api: GitHubApi, job: Job): Promise<string | undefined> {
  return (await partPullRequest(api, job))?.url;
}

/** The pull request `partlyDone` names, with its state (issue #1924 part 4: an open one's done criteria are read); undefined: none. */
export async function partPullRequest(api: GitHubApi, job: Job): Promise<{ url: string; state: string } | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  const parts = (await api.referencingPullRequests(repo, number))
    .filter((pr) => isPartOf(pr, repo, number) && (isOwnOrReworked(pr, job) || isUpdatedBy(pr, job)) && !reworkUnpushed(pr, job)
      && (pr.state === 'merged' || (pr.state === 'open' && isReady(pr))));
  return parts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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
  const add = (pr: { url: string; createdAt: string; headCommittedAt?: string; isDraft: boolean; conflicting: boolean; checks?: ChecksState }, state: WorkPullRequest['state']): void => {
    const by = isOwnPullRequest(pr, job) ? 'opened' : isUpdatedBy(pr, job) ? 'updated' : undefined;
    const open = state === 'open';
    if (by && !found.has(pr.url)) {
      found.set(pr.url, { url: pr.url, number: numberOf(pr.url), by, state, draft: pr.isDraft, conflicting: open && pr.conflicting, ...(open && pr.checks ? { checks: pr.checks } : {}) });
    }
  };
  const closer = await api.closingPullRequest(repo, number);
  if (closer) add({ ...closer, isDraft: false, conflicting: false }, 'merged');
  for (const pr of await openClosingWork(api, repo, number)) add(pr, 'open');
  for (const pr of await api.referencingPullRequests(repo, number)) if (pr.repo.toLowerCase() === repo.toLowerCase() && !fromReleaseBranch(pr)) add(pr, pr.state);
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
  return (await openClosingWork(api, repo, number)).some((pr) => isOwnPullRequest(pr, job) || isUpdatedBy(pr, job));
}

/**
 * The job's issue as the work-item ledger reads it (issue #1067): open, or closed and why — `completed` when it is closed
 * as complete (`isClosedAsCompleted`: by a merged pull request too), else GitHub's reason. A permanent error (the issue
 * gone, no access) is no answer: the failure is reported, and meets the same error there; a transient one throws, to be
 * asked again.
 */
export async function issueState(api: GitHubApi, job: Job): Promise<{ state: 'open' | 'closed'; reason?: string } | undefined> {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  try {
    const issue = await api.getIssue(repo, number);
    if (issue.state !== 'closed') return { state: 'open' };
    const reason = isClosedAsCompleted(issue, await api.closingPullRequest(repo, number)) ? 'completed' : issue.stateReason ?? undefined;
    return { state: 'closed', ...(reason ? { reason } : {}) };
  } catch (err) {
    if (err instanceof GitHubApiError && err.permanent) return undefined;
    throw err;
  }
}
