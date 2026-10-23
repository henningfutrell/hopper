// Following a done job's pull request after its end was reported (issue #579, design.md "Done is a pull request"). The
// report kept it in the job's source state (`pullRequest`, `follow: open`, `part` for a part). Merged — the issue
// closed as complete by it, or the pull request merged —: the item is done, `hopper:pr-ready` → `hopper:done`; a part's
// `hopper:partly-done` only comes off, so the issue is offered again and its next part runs. Closed without a merge:
// flagged, → `hopper:pr-closed`, which keeps the issue out until a person removes it. Still open (PR waiting, issue #637):
// what is seen of it — a draft, merge conflicts, its checks — is kept for the Pull requests list; and with yolo mode on for
// its repository, whatever its job's origin (issue #805; issue #652 merged only a job with one), the hopper merges it once it is ready: not a draft, no merge conflicts, and its checks passed — or it
// has none, and none started within a grace window after its last push (issue #677; issue #652 had it wait for ever). A
// refused merge is kept on it (`mergeError`) and asked again next sync: it never fails the job. A pull request the
// report could not name is looked for again each sync, and named once found (issue #677); none open, the job's own part
// merged since it began is named, so its merge is followed as a part's (issue #1231). A merge marks the item done
// only when it closes the issue (issue #721): the issue is closed as completed, or the merged pull request's body closes it
// with a closing keyword. Any other merge — a part, a mention, a pull request named for the issue only on its branch — is a
// part: the issue is offered again — unless it makes every part the issue declares done (issue #729, parts.ts): then the
// issue is done, `hopper:done`. A merge recorded as the whole item before that rule is checked once by the same rule
// (`mergeChecked`), and one that did not close the issue loses `hopper:done`. A throw is asked again on a later sync.
// A person's Merge now or Close PR (issue #677) takes the same path: merged whatever yolo mode and its checks say — GitHub
// still refuses a draft, merge conflicts or a required check —, or closed without a merge; a refusal throws to the person.
// Closing finishes the loop (issue #677): after the hopper's own merge — yolo mode or Merge now — of a pull request that
// did not close the issue and ships no part ("Part of #N"), the hopper closes the issue as completed, with one comment
// that links the pull request, and the item is done. A merge a person made on GitHub stays as issue #721 has it.
// Pull-based completion (issue #428): the item is resolved upstream, the hopper only follows. Closed as completed, it is
// merged, as above — unless the followed pull request is still open on GitHub: it is followed to its end (issues #786, #927). Closed as not planned while its pull request is still open, or none is found yet: abandoned — followed
// no more, never merged, its pull request left as it is; the waiting labels come off and no end label goes on. A person's
// act still goes through. Reopened with that pull request open, reconciling follows it again (issue #763).
// A merge held (issue #939, merge-gate.ts): ready, it conflicts with a pull request of its repository the hopper merged
// earlier in the same sync pass, so the hopper does not merge it (`seen.mergeHeldBehind`); the next sync sees it conflict
// with the new base and tends it. A person's Merge now still merges it. The done criteria of the job's conditional skills
// (issue #1924 part 3, done-criteria.ts) are read again just before the hopper's merge: one not met, or a `person-merges`
// that applies, holds it (`mergeError`, asked again next sync); a person's Merge now still merges.
// The batch first (issue #985, the in-motion cycle): after the source read the followed pull requests in one batch
// (`readFollowed`), a follow of an open one takes its state from that read, once, and reads GitHub only when something
// changed that a read must confirm — merged or closed, a new head or base, merge conflicts changed or not known yet, checks
// that fail now (the tend is told which), its item closed as not planned, a part that names it no more — or before the
// hopper's merge. A follow with no batch answer reads GitHub as before.
// Strays (issue #1143 part 4): a pull request a job named that no job follows, of an item no job works on, gets the same
// housekeeping, with no follow (`housekeepStrays`): moved to the landing branch, or closed as superseded, and said on it.
// Change kinds (issue #1076, change-kinds.ts): each read of an open pull request classifies it by the files and lines it
// changes, under its repository's change rule, and keeps the kind on what is seen of it (`seen.change`); the lines come
// from the hopper's mirror, only for the files whose content can change the kind. The kind's merge gate says whether the
// hopper merges it once ready: with no person (docs, low-risk), only with yolo mode on, or never (a person merges). The
// same files under the same rule and head are not read again; a batch answer under another rule reads it again.
// The merge marker (issue #1588): before its merge call — yolo mode or Merge now — the hopper keeps in the job's source
// state the pull request, the head it merges and who merges it (`merging`). A stop after the call and before the record
// leaves the pull request merged on GitHub: read merged with the marker on it at that head, it is the hopper's merge, so
// the issue is closed as above, once, and who merged it is recorded. Seen open, or ended, the marker goes. A stop after
// the close and before its comment (issue #1959): the close is made again, and the comment only when the issue lacks it.
// The labels follow the ledger (issue #1892 part 14): each end names the state it moves the item to (`followLabels`,
// item-labels.ts), `labelsFor` that state names the end labels, and the change is GitHub outbox rows (act `follow`), kept
// before they are sent, so a refusal for now is sent again later and a follow again sends nothing twice.

import {
  classifyChange, contentNeeded, DEFAULT_CHANGE_RULE, mergesOnReady, pullRequestRepo, rechecksMerge, readyToMerge, ruleKey,
  type ActingPerson, type ChangeClass, type ChangeKind, type ChangeRule, type EndedPullRequest, type FollowAt, type FollowUp, type Job, type MergeMarker, type PullRequestAct, type PullRequestSeen, type Stray, type StrayHousekept, type TendStep,
} from '../../domain/types.ts';
import { SourceError } from '../../domain/ports.ts';
import { GitHubApiError, type GitHubApi, type GitHubIssue, type NumberedPullRequest, type OpenPullRequest, type ReferencingPullRequest } from './api.ts';
import { retargetNote, supersededNote, tendNote } from './pr-notes.ts';
import { closesByKeyword, fromReleaseBranch, isClosedAsCompleted, isPartOf, namesIssue, openClosingWork, ownOpenPullRequestOf, worksOnAnotherIssue } from './completion.ts';
import { blockedForPullRequest, followLabels, type FollowEnd } from './item-labels.ts';
import { allPartsDone, partsOf } from './parts.ts';
import { mergeGateOf } from './merge-gate.ts';
import { closedByMerge, closesIssue, mergedByMarker, type OwnMerge } from './own-merge.ts';
import type { FollowContext, PullRequestContext } from './follow-context.ts';
import { killPoint } from '../../sagas/kill-points.ts';

/** `mention`: the pull request only mentions the issue, with no "Part of #N" (issue #1891): followed as a part all the same. */
interface Followed { pullRequest?: string; follow?: string; part?: boolean; mention?: boolean; seen?: PullRequestSeen; mergeChecked?: boolean }

/** The label change of the follow's `end` on the issue that carries `carried`, through the outbox; none when it carries what the end's state wants. */
async function endLabels(ctx: FollowContext, key: string, repo: string, f: FollowEnd, carried: readonly string[]): Promise<void> {
  const change = followLabels(f, carried);
  if (change) await ctx.labels(key, repo, change, f.end === 'found_open' ? `found_open:${f.part ? 'part' : 'whole'}` : f.end);
}

type PullState = 'open' | 'merged' | 'closed';

const ruleOf = (ctx: PullRequestContext, repo: string): ChangeRule => ctx.changeRule?.(repo) ?? DEFAULT_CHANGE_RULE;
/** Whether the hopper merges a ready pull request of `repo` of this kind (issue #1076): its gate, yolo mode for `yolo`. */
const merges = (ctx: PullRequestContext, repo: string, kind: ChangeKind | undefined): boolean =>
  mergesOnReady(ruleOf(ctx, repo), ctx.yoloMode?.(repo) ?? false, kind);

export const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
const repoOfPull = (url: string): string => /([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? '';
const pushedAtOf = (pr: { createdAt: string; headCommittedAt?: string }): string =>
  (pr.headCommittedAt && pr.headCommittedAt > pr.createdAt ? pr.headCommittedAt : pr.createdAt);

/**
 * What is seen of the open pull request as the batch tells it (issue #985), when nothing changed that a read must confirm;
 * undefined: read it from GitHub. The batch reads the newest run of each check (issue #2129), so its pending is the
 * checks' own state: a failed check that runs again on the same head is pending, not failing (issue #2230).
 */
function seenFromBatch(ctx: PullRequestContext, job: Job, s: Followed, url: string): PullRequestSeen | undefined {
  const { repo, number } = job.source as { repo: string; number: number };
  const before = s.seen;
  const b = repoOfPull(url).toLowerCase() === repo.toLowerCase() ? ctx.batched?.(repo, numberOf(url)) : undefined;
  if (!b || !before || b.state !== 'open' || b.mergeable === 'UNKNOWN') return undefined;
  // Its issue closed (abandoned, or superseded), or a base off the landing branch (issue #1143): a read decides.
  const landing = ctx.landingBranch?.(repo);
  if (b.issue?.state === 'closed' || (landing && b.base && b.base !== landing)) return undefined;
  if (s.part && !new RegExp(`\\bpart of #${number}\\b`, 'i').test(b.body)) return undefined;
  const conflicting = b.mergeable === 'CONFLICTING';
  const pushedAt = pushedAtOf(b);
  if (pushedAt !== before.pushedAt || b.base !== before.base || conflicting !== before.conflicting) return undefined;
  const failing = b.checks === 'failing';
  if (failing && before.checks !== 'failing') return undefined;
  // Classified under another rule, or never though its files are known: read, so it is classified again.
  if (before.files && before.change?.rule !== ruleKey(ruleOf(ctx, repo))) return undefined;
  const seen: PullRequestSeen = {
    draft: b.isDraft, conflicting, checks: b.checks ?? 'none', openedAt: b.createdAt, pushedAt, ...(b.base ? { base: b.base } : {}),
    ...(!failing && b.checksWhy ? { checksWhy: b.checksWhy } : {}), ...(!failing && b.checksRefused ? { checksRefused: true } : {}),
    ...(b.headRef ? { headRef: b.headRef } : {}), ...(failing && before.failedChecks ? { failedChecks: before.failedChecks } : {}),
    ...(before.commits ? { commits: before.commits } : {}), ...(before.files ? { files: before.files } : {}), ...(before.change ? { change: before.change } : {}),
  };
  return merges(ctx, repo, seen.change?.kind) && readyToMerge(seen, (ctx.clock?.now() ?? new Date()).getTime()) ? undefined : seen;
}

/**
 * The newest open pull request of the issue, in any state of review (issue #677: the report names only a ready one): one
 * that closes it, else one in its repository that mentions it (a part says "Part of #N"), else one on a branch named for it,
 * else the job's own open one those miss (issue #2510: in another repository, or one it opened through the hopper).
 */
async function openPullRequestOf(ctx: FollowContext, job: Job, repo: string, number: number): Promise<{ url: string; part: boolean } | undefined> {
  const { api } = ctx;
  const newest = <P extends { createdAt: string }>(prs: P[]): P | undefined => [...prs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const closing = newest(await openClosingWork(api, repo, number));
  if (closing) return { url: closing.url, part: false };
  const referencing = await api.referencingPullRequests(repo, number);
  const mention = newest(referencing
    .filter((pr) => pr.state === 'open' && pr.repo.toLowerCase() === repo.toLowerCase() && !worksOnAnotherIssue(pr, repo, number)));
  if (mention) return { url: mention.url, part: isPartOf(mention, repo, number) };
  const branch = newest((await api.openPullRequests(repo)).filter((pr) => namesIssue(pr.headRef, number)));
  return branch ? { url: branch.url, part: false } : ownOpenPullRequestOf(api, job, repo, number, referencing, ctx.opened);
}

/**
 * A pull request of the issue's repository that mentions the issue and merged since the job began: one that closes it
 * with a closing keyword first (issue #2132: merged into the landing branch, which closes no issue, before the job's end
 * was reported), followed as the whole item; else the job's own part ("Part of #N", issue #1231), merged before the job's
 * end was reported, so the report named none; else any other that only mentions it (issue #1891: a pull request of
 * several issues, no "Part of #N"), so a job that ended with no pull request is not followed for ever. A part or a mention
 * ends as a merged part: the next part is taken, or the issue is done when every part it declares is done. Never a pull
 * request from a release branch or a batch run's branch (`fromReleaseBranch`).
 */
async function mergedPartOf(api: GitHubApi, repo: string, number: number, job: Job): Promise<{ url: string; part: boolean; mention?: true } | undefined> {
  const part = (pr: ReferencingPullRequest) => isPartOf(pr, repo, number);
  const rank = (pr: ReferencingPullRequest) => (part(pr) ? 1 : closesByKeyword(pr.body, repo, number) ? 2 : 0);
  const merged = (await api.referencingPullRequests(repo, number))
    .filter((pr) => pr.state === 'merged' && !fromReleaseBranch(pr) && (part(pr) || pr.repo.toLowerCase() === repo.toLowerCase()) && pr.mergedAt !== undefined && Date.parse(pr.mergedAt) >= Date.parse(job.createdAt))
    .sort((a, b) => rank(b) - rank(a) || (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
  return merged && (rank(merged) === 2 ? { url: merged.url, part: false } : { url: merged.url, part: true, ...(part(merged) ? {} : { mention: true as const }) });
}

/** Where the named pull request is now; undefined: none is named, or a part names it no more. */
async function namedStateOf(api: GitHubApi, repo: string, number: number, s: Followed): Promise<{ state: PullState; url: string } | undefined> {
  if (!s.pullRequest) return undefined;
  const mention = (await api.referencingPullRequests(repo, number)).find((pr) => pr.url === s.pullRequest);
  if (mention) return s.part && !s.mention && !isPartOf(mention, repo, number) ? undefined : { state: mention.state, url: mention.url };
  // Not a mention (issue #637: a pull request named for the issue only on its branch): asked by its number.
  return { state: (await api.pullRequest(pullRequestRepo(s.pullRequest, repo), numberOf(s.pullRequest)))?.state ?? 'closed', url: s.pullRequest };
}

/**
 * Where the pull request is now; undefined: it cannot be told yet (none named nor found, and nothing merged). The named pull
 * request still open on GitHub is open, whatever its issue (issues #786, #927): an issue closed as completed under it does
 * not make it merged, or reconciling follows it again at each sync and it is never tended.
 */
async function stateOf(api: GitHubApi, repo: string, number: number, s: Followed): Promise<{ state: PullState; url: string } | undefined> {
  const named = await namedStateOf(api, repo, number, s);
  if (named?.state === 'open') return named;
  if (!s.part) {
    const closer = await api.closingPullRequest(repo, number);
    if (isClosedAsCompleted(await api.getIssue(repo, number), closer)) return { state: 'merged', url: closer?.url ?? s.pullRequest ?? '' };
  }
  return named;
}

/**
 * The change kind of open pull request `pr` (issue #1076), from the files it changes and, read from the mirror, the lines
 * of the files whose content can change it. The same files, head and rule as `before`: `before`'s kind, nothing read.
 * Its files not known, or not all of them: `before`'s kind while its head is the same, else none.
 */
async function classified(ctx: PullRequestContext, repo: string, pr: OpenPullRequest, number: number, pushedAt: string, before: PullRequestSeen | undefined): Promise<ChangeClass | undefined> {
  const rule = ruleOf(ctx, repo);
  const same = before?.change && before.pushedAt === pushedAt && before.change.rule === ruleKey(rule);
  if (!pr.files || pr.filesCut) return same ? before.change : undefined;
  if (same && JSON.stringify(before.files) === JSON.stringify(pr.files)) return before.change;
  const needed = contentNeeded(rule, pr.files);
  const lines = needed.length > 0 ? await ctx.api.changedLines?.(repo, { number, ...(pr.base ? { base: pr.base } : {}), ...(pr.headOid ? { headOid: pr.headOid } : {}) }, needed) : {};
  return classifyChange(rule, pr.files, lines ?? {});
}

/**
 * An open pull request: what is seen of it, its change kind (issue #1076), and, its kind's gate open — yolo mode on, or a
 * kind merged with no person — and it ready, the hopper's merge, through the merge gate (issue #939). A person's act
 * (issue #677): merged or closed now, GitHub's refusal thrown.
 */
/** Say `body` on pull request `url` (issue #1143): only what the hopper did with it; a refusal loses only the comment. */
async function note(api: GitHubApi, repo: string, url: string, body: string): Promise<void> {
  await api.postComment(pullRequestRepo(url, repo), numberOf(url), body).catch(() => undefined);
}

/** `JobSource.tendStarted` over `api` (issue #1143): the tend note on the job's own pull request. */
export const tendStartedOn = (api: GitHubApi) => async (job: Job, pullRequest: string, step: TendStep): Promise<void> => {
  if (repoOfPull(pullRequest).toLowerCase() !== job.source?.repo?.toLowerCase()) return;
  await note(api, repoOfPull(pullRequest), pullRequest, tendNote(step));
};

/**
 * The landing branch to move the open pull request to (issue #1143): its repository's, as its landing batch setting names
 * it (never GitHub's default branch, issue #1142), when its base is another branch that is no open pull request's head (a
 * stack, issue #900). Undefined: it stays, and so does every pull request of a repository with no landing batches.
 */
async function retargetTo(ctx: PullRequestContext, repo: string, pr: NumberedPullRequest): Promise<string | undefined> {
  const to = ctx.landingBranch?.(repo);
  if (!to || !pr.base || pr.base === to) return undefined;
  const stacked = (await ctx.api.openPullRequests(repo)).some((p) => p.headRef === pr.base);
  return stacked ? undefined : to;
}

/** `mark`, when given, keeps the merge marker with the head it merges, before the merge call (issue #1588). */
export async function waiting(ctx: PullRequestContext, job: Job, url: string, before: PullRequestSeen | undefined, act?: PullRequestAct, mark?: (head: string | undefined) => void):
  Promise<{ ended: 'merged' | 'closed'; superseded?: string; seen?: PullRequestSeen } | { seen: PullRequestSeen; retargeted?: { from: string; to: string } }> {
  // Its own repository's (issue #1778): read, merged and moved there, under that repository's yolo mode and rules.
  const repo = pullRequestRepo(url, job.source!.repo!);
  if (act === 'close') {
    await ctx.api.closeWithoutMerge(repo, numberOf(url));
    return { ended: 'closed' };
  }
  if (act === 'merge') {
    if (mark) mark((await ctx.api.pullRequest(repo, numberOf(url)))?.headOid);
    await ctx.api.merge(repo, numberOf(url));
    killPoint('follow:merge:after-call');
    return { ended: 'merged' };
  }
  const pr = await ctx.api.pullRequest(repo, numberOf(url));
  if (!pr) return { seen: before ?? { draft: false, conflicting: false, checks: 'none' } };
  const pushedAt = pushedAtOf(pr);
  const seen: PullRequestSeen = {
    draft: pr.isDraft, conflicting: pr.conflicting, checks: pr.checks ?? 'none', openedAt: pr.createdAt, pushedAt, ...(pr.base ? { base: pr.base } : {}),
    ...(pr.checksWhy ? { checksWhy: pr.checksWhy } : {}), ...(pr.checksRefused ? { checksRefused: true } : {}),
    ...(pr.headRef ? { headRef: pr.headRef } : {}), ...(pr.failedChecks?.length ? { failedChecks: pr.failedChecks } : {}),
    ...(pr.commits ? { commits: pr.commits } : before?.commits ? { commits: before.commits } : {}),
    ...(pr.files ? { files: pr.files } : before?.files ? { files: before.files } : {}),
  };
  // Housekeeping (issue #1143), never on a person's act: off the landing branch, it moves there, and waits for the next
  // read; with no commit its base lacks, nothing is left to land, and it is closed.
  const kept = !act ? await housekeep(ctx, repo, url, pr) : undefined;
  if (kept && 'retargeted' in kept) return { seen: { ...seen, base: kept.retargeted.to }, retargeted: kept.retargeted };
  if (kept) return { ended: 'closed', superseded: kept.superseded };
  const change = pr.state === 'open' ? await classified(ctx, repo, pr, numberOf(url), pushedAt, before) : undefined;
  if (change) seen.change = change;
  const now = (ctx.clock?.now() ?? new Date()).getTime();
  // Whatever its job's origin (issue #805): the trust decision was made when the job ran, before its pull request.
  if (pr.state !== 'open' || !merges(ctx, repo, change?.kind) || !readyToMerge(seen, now)) return { seen };
  try {
    // The done criteria of the job's conditional skills, read again now (issue #1924 part 3): not met, the merge waits.
    const hold = await ctx.mergeHold?.(job, repo, url);
    if (hold) return { seen: { ...seen, mergeError: hold } };
    const heldBehind = await mergeGateOf(ctx.api).merge(repo, pr.base, url, () => { mark?.(pr.headOid); return ctx.api.merge(repo, numberOf(url)); });
    if (heldBehind) return { seen: { ...seen, mergeHeldBehind: heldBehind } };
    return { ended: 'merged', seen };
  } catch (err) {
    if (err instanceof GitHubApiError && !err.permanent) throw err;
    return { seen: { ...seen, mergeError: (err as Error).message } };
  }
}

/**
 * Housekeeping of the open pull request `url` (issue #1143): off the landing branch, it is moved there; with no commit its
 * base lacks, nothing is left to land, and it is closed. Each said on it. Undefined: it stays as it is.
 */
async function housekeep(ctx: PullRequestContext, repo: string, url: string, pr: NumberedPullRequest):
  Promise<{ retargeted: { from: string; to: string } } | { superseded: string } | undefined> {
  if (pr.state !== 'open') return undefined;
  const to = await retargetTo(ctx, repo, pr);
  if (to) {
    await ctx.api.retarget(repo, numberOf(url), to);
    await note(ctx.api, repo, url, retargetNote(pr.base!, to));
    return { retargeted: { from: pr.base!, to } };
  }
  if (pr.commits?.length === 0 && pr.base) return closeSuperseded(ctx.api, repo, url, `its changes are already on ${pr.base}`);
  return undefined;
}

/**
 * Housekeeping of stray pull requests (issue #1143 part 4, `JobSource.housekeepStrays`): which are open, from one batched read
 * of their repositories' open pull requests; each open one of its job's own repository is read, then closed as superseded by
 * the pull request that closed its issue, or as `housekeep` says. Its item closed as not planned, it is left as it is, as an
 * abandoned follow leaves it. One not open is read once by its number (issue #1420): merged or closed, it has `ended`, so
 * the job that holds it is no longer shown with it open. A repository GitHub does not answer for, or a stray whose
 * housekeeping throws, is logged and asked again at the next round.
 */
export async function housekeepStrays(ctx: PullRequestContext, strays: Stray[]): Promise<StrayHousekept[]> {
  const own = strays.filter((s) => s.job.source?.repo && s.job.source.number && repoOfPull(s.pullRequest).toLowerCase() === s.job.source.repo.toLowerCase());
  if (own.length === 0) return [];
  const open = await ctx.api.openPullRequestsIn([...new Set(own.map((s) => s.job.source!.repo!))]);
  for (const [repo, error] of open.repoErrors) console.warn(`hopper: the stray pull requests of ${repo} were not read, asked again at the next round: ${error}`);
  const done: StrayHousekept[] = [];
  for (const s of own) {
    const listed = open.repos.get(s.job.source!.repo!);
    if (!listed) continue;
    try {
      const kept = listed.some((p) => p.url === s.pullRequest) ? await housekeepStray(ctx, s) : await endedStray(ctx, s);
      if (kept) done.push({ jobId: s.job.id, pullRequest: s.pullRequest, part: s.part, ...kept });
    } catch (e) {
      console.warn(`hopper: housekeeping of the stray pull request ${s.pullRequest} failed, asked again at the next round: ${(e as Error).message}`);
    }
  }
  return done;
}

/** A stray not among its repository's open pull requests (issue #1420): how it ended on GitHub; undefined: open after all. */
async function endedStray(ctx: PullRequestContext, s: Stray): Promise<{ ended: 'merged' | 'closed' } | undefined> {
  const state = (await ctx.api.pullRequest(s.job.source!.repo!, numberOf(s.pullRequest)))?.state;
  return state === 'merged' || state === 'closed' ? { ended: state } : undefined;
}

async function housekeepStray(ctx: PullRequestContext, s: Stray): Promise<{ retargeted: { from: string; to: string } } | { superseded: string } | undefined> {
  const { repo, number } = s.job.source as { repo: string; number: number };
  const issue = await ctx.api.getIssue(repo, number);
  if (issue.state === 'closed' && issue.stateReason === 'not_planned') return undefined;
  const elsewhere = await supersededBy(ctx.api, repo, number, issue, s.pullRequest);
  if (elsewhere) return { superseded: (await closeSuperseded(ctx.api, repo, s.pullRequest, elsewhere)).superseded };
  const pr = await ctx.api.pullRequest(repo, numberOf(s.pullRequest));
  return pr && housekeep(ctx, repo, s.pullRequest, pr);
}

/**
 * The pull requests jobs wait on that ended (issue #1433, `JobSource.endedPullRequests`): each read by its number. One GitHub
 * does not know, or whose read throws, is logged and left out: asked again at the next sync.
 */
export async function endedPullRequests(api: GitHubApi, pulls: { repo: string; number: number }[]): Promise<EndedPullRequest[]> {
  const ended: EndedPullRequest[] = [];
  for (const { repo, number } of pulls) {
    try {
      const pr = await api.pullRequest(repo, number);
      if (pr && pr.state !== 'open') ended.push({ repo, number, pullRequest: pr.url, state: pr.state });
    } catch (e) {
      console.warn(`hopper: the waited pull request ${repo}#${number} was not read, asked again at the next sync: ${(e as Error).message}`);
    }
  }
  return ended;
}

/** Close pull request `url` without a merge, as nothing is left to land (issue #1143), and say why on it. */
async function closeSuperseded(api: GitHubApi, repo: string, url: string, why: string): Promise<{ ended: 'closed'; superseded: string }> {
  await api.closeWithoutMerge(pullRequestRepo(url, repo), numberOf(url));
  await note(api, repo, url, supersededNote(why));
  return { ended: 'closed', superseded: why };
}

/**
 * Why the open pull request `url` is superseded by its issue (issue #1143): the issue closed as completed by the merge of
 * another pull request. Undefined: it is not. A part is too (issue #1433): the close says the whole is done, so the part
 * has nothing left to land, and an open part left so is a stale pull request that jobs may wait on.
 */
async function supersededBy(api: GitHubApi, repo: string, number: number, issue: GitHubIssue | undefined, url: string): Promise<string | undefined> {
  if (issue?.state !== 'closed' || issue.stateReason === 'not_planned') return undefined;
  const closer = await api.closingPullRequest(repo, number);
  return closer && closer.url !== url && isClosedAsCompleted(issue, closer) ? `its issue was closed by ${closer.url}` : undefined;
}

/**
 * A merge recorded as the whole item before issue #721, checked once: closed by it, it is marked checked; else it was a
 * part — its end labels come off (`hopper:done`), so the issue is offered again and its next part runs.
 */
async function recheckMerge(ctx: FollowContext, key: string, repo: string, number: number, s: Followed & Record<string, unknown>): Promise<FollowUp> {
  const url = s.pullRequest ?? '';
  if (!s.pullRequest || await closedByMerge(ctx.api, repo, number, s.pullRequest)) {
    return { outcome: 'checked', pullRequest: url, part: false, state: { ...s, mergeChecked: true } };
  }
  await endLabels(ctx, key, repo, { end: 'part_merged' }, (await ctx.api.getIssue(repo, number)).labels);
  return { outcome: 'merged', pullRequest: url, part: true, state: { ...s, part: true } };
}

/** The item closed as not planned upstream (issue #428): the follow ends abandoned; the waiting labels come off. */
async function abandon(ctx: FollowContext, key: string, repo: string, issue: GitHubIssue, s: Followed & Record<string, unknown>, url: string | undefined): Promise<FollowUp> {
  await endLabels(ctx, key, repo, { end: 'abandoned' }, issue.labels);
  const pullRequest = url ?? s.pullRequest ?? '';
  return { outcome: 'abandoned', pullRequest, part: s.part === true, state: { ...s, ...(pullRequest ? { pullRequest } : {}), follow: 'abandoned' } };
}

/**
 * Followed after its end; with `act`, a person's Merge now or Close PR on its open pull request (issue #677). With `at`, the
 * merge marker is kept before the hopper's merge call (issue #1588).
 */
export async function followPullRequest(ctx: FollowContext, job: Job, act?: PullRequestAct, at?: FollowAt): Promise<FollowUp | undefined> {
  // The marker an earlier follow kept (issue #1588); no state this follow keeps carries it on.
  const { merging: marker, ...kept } = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown> & { merging?: MergeMarker };
  let s: Followed & Record<string, unknown> = kept;
  const { repo, number, key } = job.source ?? {};
  if (!repo || !number || !key) return undefined;
  try {
    if (act && s.follow !== 'open') throw new SourceError('its pull request is not open', true);
    if (rechecksMerge(job)) return await recheckMerge(ctx, key, repo, number, s);
    if (s.follow !== 'open') return undefined;
    if (!s.pullRequest) {
      const open = await openPullRequestOf(ctx, job, repo, number);
      const found = open ?? await mergedPartOf(ctx.api, repo, number, job);
      if (found) s = { ...s, pullRequest: found.url, ...(found.part ? { part: true } : {}), ...('mention' in found && found.mention ? { mention: true } : {}) };
      // Blocked for want of a pull request (issue #1891), one found open: its issue waits on it, as a report says. The ledger says it is blocked (issue #1892 part 27).
      const carried = open ? (await ctx.api.getIssue(repo, number)).labels : [];
      if (open && blockedForPullRequest(ctx.item?.(key), job.id, carried)) await endLabels(ctx, key, repo, { end: 'found_open', part: open.part === true }, carried);
    }
    const batched = !act && s.pullRequest ? seenFromBatch(ctx, job, s, s.pullRequest) : undefined;
    if (batched) {
      if (JSON.stringify(batched) === JSON.stringify(s.seen)) return undefined;
      return { outcome: 'open', pullRequest: s.pullRequest!, part: s.part === true, state: { ...s, seen: batched } };
    }
    let now = await stateOf(ctx.api, repo, number, s);
    const issue = !act && (!now || now.state === 'open') ? await ctx.api.getIssue(repo, number) : undefined;
    if (issue?.state === 'closed' && issue.stateReason === 'not_planned') return await abandon(ctx, key, repo, issue, s, now?.url);
    if (!now && act) throw new SourceError('no pull request is found for it yet', true);
    if (!now) return undefined;
    const part = s.part === true;
    let byHopper = false;
    let merged: OwnMerge | undefined;
    let acting: ActingPerson | undefined;
    let superseded: string | undefined;
    // Done by another pull request (issue #1143): nothing is left to land, and the item is done. A part too (issue #1433):
    // its issue closed as completed, every part of it is done.
    const doneElsewhere = now.state === 'open' ? await supersededBy(ctx.api, repo, number, issue, now.url) : undefined;
    if (doneElsewhere) {
      superseded = (await closeSuperseded(ctx.api, repo, now.url, doneElsewhere)).superseded;
      now = { state: 'closed', url: now.url };
    } else if (now.state === 'open') {
      const url = now.url;
      const mark = at && ((head: string | undefined) => at.keep({
        ...s, merging: { pullRequest: url, ...(head ? { head } : {}), ...(!act ? { byHopper: true } : {}), ...(at.acting ? { acting: at.acting } : {}) } satisfies MergeMarker,
      }));
      const w = await waiting(ctx, job, now.url, s.seen, act, mark);
      if (!('ended' in w)) {
        if (JSON.stringify(w.seen) === JSON.stringify(s.seen) && !w.retargeted) return undefined;
        return { outcome: 'open', pullRequest: now.url, part, state: { ...s, seen: w.seen }, ...(w.retargeted ? { retargeted: w.retargeted } : {}) };
      }
      now = { state: w.ended, url: now.url };
      // The hopper's merge keeps what it saw: the change kind it merged by (issue #1076).
      if (w.seen?.change) s = { ...s, seen: w.seen };
      byHopper = !act;
      merged = w.ended === 'merged' ? 'here' : undefined;
      superseded = w.superseded;
    } else if (now.state === 'merged' && await mergedByMarker(ctx.api, pullRequestRepo(now.url, repo), now.url, marker)) {
      // The hopper's merge call went through, and a stop came before its record (issue #1588).
      byHopper = marker!.byHopper === true;
      merged = 'again';
      acting = marker!.acting;
    }
    // A merge that did not close the issue is a part (issue #721), whatever the report took it for — unless the hopper
    // merged it and it ships no part: then the hopper closes the issue (issue #677), again after a stop (issue #1959).
    const whole = now.state === 'merged' && !part && await closesIssue(ctx.api, repo, number, now.url, merged);
    const shipsPart = part || (now.state === 'merged' && !whole);
    // A merged part that makes every declared part done (issue #729): the issue is done.
    const parts = now.state === 'merged' && shipsPart ? await partsOf(ctx.api, await ctx.api.getIssue(repo, number), now.url) : undefined;
    // A failed job's followed pull request (issue #786) ends its `hopper:failed` too. Only what the issue carries changes
    // (issue #1154): the issue as read in this follow, else read now.
    const end: FollowEnd['end'] = doneElsewhere ? 'merged' : now.state === 'closed' ? 'closed' : shipsPart && !allPartsDone(parts) ? 'part_merged' : 'merged';
    await endLabels(ctx, key, repo, { end }, (issue ?? await ctx.api.getIssue(repo, number)).labels);
    const after = { ...s, pullRequest: now.url, follow: now.state, ...(shipsPart ? { part: true } : {}), ...(whole ? { mergeChecked: true } : {}), ...(parts ? { parts } : {}) };
    return {
      outcome: now.state, pullRequest: now.url, part: shipsPart, ...(byHopper && !superseded ? { byHopper } : {}), ...(acting ? { acting } : {}),
      ...(superseded ? { superseded } : {}), state: after,
    };
  } catch (err) {
    if (err instanceof SourceError) throw err;
    // A person's act is answered GitHub's refusal as it is (issue #677); a sync asks again later.
    if (act && err instanceof GitHubApiError) throw new SourceError(err.message, err.permanent, err.status);
    throw new SourceError((err as Error).message, false);
  }
}
