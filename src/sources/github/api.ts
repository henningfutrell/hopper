// The GitHubApi port: everything the GitHub source asks of GitHub. Adapters: the connected account's (account/api.ts,
// the user's token from the hopper's GitHub App, over the REST and GraphQL calls in app/), and the in-memory fake (fake.ts). Errors are GitHubApiError, classified
// permanent (403/404/410/422, missing scope) or transient (network, 5xx, rate limit, timeout).

import type { ChecksState, FailedCheck } from '../../domain/pull-requests.ts';
import type { CheckFact } from '../../domain/conditional-skills.ts';
import type { LinkedItem } from '../../domain/linked-pulls.ts';
import type { ItemEdit } from '../../domain/item-snapshots.ts';
import type { IssueCrossReferences } from '../../domain/cross-references.ts';
import type { IssuePlace } from '../../domain/issue-graph.ts';
import type { BaseMergeTarget, GitRemote } from '../../git-mirror/mirrors.ts';
import type { BaseMerge } from '../../domain/pull-requests.ts';
import type { ChangedLines } from '../../domain/change-kinds.ts';
import type { RepoListing } from '../../domain/github-listing.ts';
import type { TaggedHit } from '../../domain/tagged.ts';

/** One hit of a tagged-item search (issue #1141), with its labels: an item with the source's label is intake's, not tagged. */
export type TaggedSearchHit = TaggedHit & { labels: string[] };

/** A GitHub Actions workflow run (issue #1508): `status` as GitHub says it (`queued`, `waiting`, `in_progress`, `completed`, …). */
/** A review of a pull request (issue #1694 part 3). */
export interface PullRequestReview { state: string; submittedAt?: string }

export interface WorkflowRun { url: string; status: string; conclusion?: string }

export interface GitHubIssue {
  /** owner/repo */
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  /** The author's GitHub user id (issue #930: trust is by id); absent when GitHub did not say. */
  authorId?: number;
  /** The logins the issue is assigned to (issue #387: intake is by label and assignee). */
  assignees: string[];
  labels: string[];
  state: 'open' | 'closed';
  updatedAt: string;
  closedBy?: string;
  /** When a closed issue was closed last. */
  closedAt?: string;
  /** Why it was closed: `completed`, `not_planned`, `duplicate` (GitHub's state_reason). */
  stateReason?: string;
  /** Its GitHub sub-issues, how many and how many are closed (issue #729: its declared parts without a checklist); absent: none. */
  subIssues?: { total: number; closed: number };
}

/** One of an issue's GitHub sub-issues (issue #729): where it is, and whether it is closed. */
export interface SubIssue { repo: string; number: number; state: 'open' | 'closed' }

/** The pull request whose merge closed an issue (GitHub's ClosedEvent closer). */
export interface ClosingPullRequest {
  url: string;
  createdAt: string;
  mergedAt: string;
}

/** An open pull request whose merge will close the issue (a closing keyword; it targets the default branch). */
export interface OpenPullRequest {
  url: string;
  createdAt: string;
  isDraft: boolean;
  /**
   * It cannot merge as it stands: as the hopper's mirror says (`git merge-tree`, issue #858), else as GitHub says
   * (`mergeable: CONFLICTING`; not yet computed counts as not).
   */
  conflicting: boolean;
  /**
   * When its head commit was committed (issue #618): a push that rebases or updates it makes a new head commit. A job
   * that updated it pushed at or after it began. Absent: GitHub did not say.
   */
  headCommittedAt?: string;
  /** Its head commit's checks (issue #637, GitHub's status check rollup); absent: it has none. */
  checks?: ChecksState;
  /** Why its checks are `unknown` (issue #1244): no read of them works with the connection, and what it lacks. Absent: known. */
  checksWhy?: string;
  /** GitHub refused every read of its checks to the connection (issue #1244): a checks read problem, not a passing error. */
  checksRefused?: true;
  /** The checks of its head commit that failed (issue #927); read only for one pull request by its number. Absent: none, or not read. */
  failedChecks?: FailedCheck[];
  /** Its head commit (issue #858: what the mirror merges); absent: GitHub did not say. */
  headOid?: string;
  /** The branch it merges into (issue #677); absent: GitHub did not say. */
  base?: string;
  /** Its head branch (issue #900: a pull request based on it is stacked on it); absent: GitHub did not say. */
  headRef?: string;
  /**
   * Its commits after its base, newest first, `<short sha> <subject>`, and the files it changes (issue #935 part 2): as the
   * hopper's mirror says, for one read by its number in a pass (`gitAnswers`). Absent: git cannot say.
   */
  commits?: string[];
  files?: string[];
  /** It changes more files than the mirror names (issue #1076): `files` is not all of them. */
  filesCut?: true;
}

/** A pull request by its number (issue #618): one an issue names to update, in any state. */
export interface NumberedPullRequest extends OpenPullRequest {
  state: 'open' | 'closed' | 'merged';
  /** When it was merged; absent unless merged. */
  mergedAt?: string;
  /** When it was closed, merged or not (issue #2219); absent while open. */
  closedAt?: string;
}

/** An open pull request of a repository, with its branch (issue #637) and its body (issue #763: the issue it closes). */
export interface BranchPullRequest extends OpenPullRequest {
  /** Its head branch's name. */
  headRef: string;
  body: string;
  /** Its title (issue #1176: the untracked pull requests list shows it); absent: not read. */
  title?: string;
}

/** A pull request that mentions the issue (its timeline's cross-references), in any state: what a part is told by (issue #579). */
export interface ReferencingPullRequest extends OpenPullRequest {
  state: 'open' | 'closed' | 'merged';
  /** When it merged (issue #637). */
  mergedAt?: string;
  body: string;
  /** owner/repo of the pull request. */
  repo: string;
}

/** A pull request merged into a branch (issue #1337): what tells whether an issue's work waits on its batch run. */
export interface MergedPullRequest { url: string; number: number; createdAt: string; mergedAt: string; body: string }

export interface GitHubComment {
  /** Numeric and increasing: the order of comments on an issue. */
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  /** GitHub's `author_association` (issue #435: a maintainer's reply answers a thread question); absent: not known. */
  association?: string;
  /** When it was last edited (issue #655 part 21: an edited comment command counts as none); absent: not known. */
  updatedAt?: string;
  /** The app it was written through (`performed_via_github_app`), by its slug; absent: none. */
  viaApp?: string;
}

/** The comment a post made (issue #435): its id and link; id 0 when GitHub did not say. */
export interface PostedComment { id: number; url: string }

/**
 * A label or an assignment on an issue, from its events (issue #652): who did it, and through which app. What the trust
 * check of an issue's origin reads.
 */
export interface IssueEvent {
  /** `reopened` (issue #1268): who reopened the issue, for a reopened card's auto-approval. */
  event: 'labeled' | 'assigned' | 'reopened';
  at: string;
  /** Who did it; empty when GitHub did not say. */
  actor: string;
  /** Their GitHub user id (issue #930); absent when GitHub did not say. */
  actorId?: number;
  /** GitHub's type of the actor (`User`, `Bot`, …); absent when GitHub did not say. */
  actorType?: string;
  /** The app it was done through (`performed_via_github_app`), by its slug; absent: none. */
  viaApp?: string;
  /** `labeled`: the label's name. */
  label?: string;
  /** `assigned`: the login assigned. */
  assignee?: string;
}

/** A followed pull request and its issue, as the in-motion cycle's batched read asks them (issue #985). */
export interface PullRequestRef { repo: string; pullRequest: number; issue: number }

/**
 * A pull request and its issue as one batched read tells them (issue #985, the in-motion cycle): what a follow needs to
 * tell whether anything changed. `mergeable`: GitHub's `MERGEABLE`, `CONFLICTING` or `UNKNOWN` (not computed yet).
 * `checks` absent: none. `issue` absent: GitHub did not answer for the issue.
 */
export interface PullRequestState {
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  mergeable: string;
  createdAt: string;
  headCommittedAt?: string;
  headOid?: string;
  headRef?: string;
  base?: string;
  checks?: ChecksState;
  /** Why its checks are `unknown` (issue #1244); absent: known. */
  checksWhy?: string;
  /** GitHub refused every read of its checks to the connection (issue #1244). */
  checksRefused?: true;
  body: string;
  issue?: { state: 'open' | 'closed'; stateReason?: string; updatedAt: string };
}

/**
 * A commit's checks as GitHub's REST API tells them (issue #1244: the read when the rollup is forbidden): its check runs and
 * its commit statuses together; `checks` absent: it has none. `unreadable`: the permissions the credential lacks for them,
 * `checks` (Checks: read), `statuses` (Commit statuses: read): with either one missing, its checks are not known.
 */
export type HeadChecks = { checks?: ChecksState } | { unreadable: ('checks' | 'statuses')[] };

/** The answer of a batched pull request read, each by `pullKey`; one GitHub did not answer for is in `errors`, never a throw. */
export interface PullRequestStates { pulls: Map<string, PullRequestState>; errors: Map<string, string> }

/** The open pull requests of many repositories (issue #985: reconciling), each newest first; a repository GitHub did not answer for is in `repoErrors`. */
export interface OpenPullRequestsIn { repos: Map<string, BranchPullRequest[]>; repoErrors: Map<string, string> }

/** A pull request's key in a batched read: its repository, lowercased, and its number. */
export const pullKey = (repo: string, pullRequest: number): string => `${repo.toLowerCase()}#${pullRequest}`;

export interface GitHubProjectItem {
  /** The issue url. */
  url: string;
  /** Position in the project's item order (0 = top), counting every item returned. */
  index: number;
  /** Field values by key as gh returns them (lowercased names). */
  fields: Record<string, string | number>;
}

/** GitHub's web origin, where its git is, from its REST API base (`https://api.github.com`, `<url>/api/v3` for GitHub Enterprise). */
export const webOriginOf = (apiUrl: string): string =>
  apiUrl.replace(/\/+$/, '') === 'https://api.github.com' ? 'https://github.com' : apiUrl.replace(/\/+$/, '').replace(/\/api\/v3$/, '');

export interface GitHubApi {
  getIssue(repo: string, number: number): Promise<GitHubIssue>;
  /** The issue's GitHub sub-issues, all pages (issue #729: a sub-issue no checklist item "Parts" names is a part too). */
  subIssues(repo: string, number: number): Promise<SubIssue[]>;
  /** Every comment, all pages, oldest first. */
  listComments(repo: string, number: number): Promise<GitHubComment[]>;
  /** Who edited the issue's title or body, and when, from its timeline (issue #662), oldest first. Absent: not read. */
  issueEdits?(repo: string, number: number): Promise<ItemEdit[]>;
  /**
   * Item `number` of `repo` as an issue's text names it (issue #655 part 19): the repository's visibility, and the pull
   * request when it is one, with its author and whether its head is a fork. Absent: not read.
   */
  linkedItem?(repo: string, number: number): Promise<LinkedItem>;
  /** The issue's place for the issue graph (issue #437): owner, Projects, linked issues and pull requests. Absent: not read. */
  issuePlace?(repo: string, number: number): Promise<IssuePlace>;
  /** Throws a permanent GitHubApiError mentioning `read:project` when that scope is missing. */
  projectItems(owner: string, number: number): Promise<GitHubProjectItem[]>;
  ensureLabel(repo: string, name: string, color: string, description: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabels(repo: string, number: number, labels: string[]): Promise<void>;
  /** When the issue was last assigned to `login` (its newest `assigned` event), or undefined when never (issue #387). */
  assignedAt(repo: string, number: number, login: string): Promise<string | undefined>;
  /** The issue's `labeled` and `assigned` events, oldest first (issue #652: who added the label and the assignment). */
  issueEvents(repo: string, number: number): Promise<IssueEvent[]>;
  /** Add assignees to an issue (Assign to me in Sources, issue #440): the user's own act, never the hopper's. */
  addAssignees(repo: string, number: number, logins: string[]): Promise<void>;
  /** Reopen a closed issue (Run again, issue #354); an open one stays open. */
  reopenIssue(repo: string, number: number): Promise<void>;
  /**
   * Close an issue as completed (issue #677): only after the hopper's own merge — yolo mode or a person's Merge now — of a
   * pull request that did not close it and ships no part.
   */
  closeAsCompleted(repo: string, number: number): Promise<void>;
  /** Close an issue as not planned (issue #1710): only a person's Decline of its request card with the choice Close. A closed one stays closed. */
  closeAsNotPlanned(repo: string, number: number): Promise<void>;
  /**
   * Post a comment on an issue: only a person's resolution of a hand-off (issue #551), the user's own act, and the one
   * that links the merged pull request when the hopper closes the issue after its merge (issue #677), and a question asked on
   * the issue thread (issue #435). Or on a job's pull request, by its number (issue #1143, `pr-notes.ts`): what the hopper
   * does with it — a tend job started, moved to the landing branch, closed as superseded. Answers the comment made.
   */
  postComment(repo: string, number: number, body: string): Promise<PostedComment>;
  /**
   * File an issue on `repo` (issue #1143 reopened: a done item's companion rebase issue), with its labels and assignees, as
   * the connected account. Answers its number and URL. Absent: the hopper files none.
   */
  fileIssue?(repo: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<{ number: number; url: string }>;
  /** The merged pull request that closed the issue last; undefined when a person or a commit closed it. */
  closingPullRequest(repo: string, number: number): Promise<ClosingPullRequest | undefined>;
  /** The open pull requests whose merge will close the issue, drafts included; none is []. */
  openClosingPullRequests(repo: string, number: number): Promise<OpenPullRequest[]>;
  /** The pull requests that mention the issue, newest 100, any state (issue #579); none is []. */
  referencingPullRequests(repo: string, number: number): Promise<ReferencingPullRequest[]>;
  /**
   * The issue's cross-references (issue #430): the pull requests and commits that mention it, with their text, and the
   * ones GitHub links as closing it — a pull request of any repository and state, a commit that closed it.
   */
  crossReferences(repo: string, number: number): Promise<IssueCrossReferences>;
  /** Pull request `number` of `repo` (issue #618); undefined when the number is an issue or names nothing. */
  pullRequest(repo: string, number: number): Promise<NumberedPullRequest | undefined>;
  /** The open pull requests of `repo`, newest 100, each with its branch (issue #637: one named for an issue); none is []. */
  openPullRequests(repo: string): Promise<BranchPullRequest[]>;
  /** The pull requests merged into branch `base` of `repo`, the newest 50 by their last update (issue #1337: the landing branch); none is []. */
  mergedPullRequestsInto(repo: string, base: string): Promise<MergedPullRequest[]>;
  /**
   * The open pull requests of each of `repos`, newest 100 each (issue #985: reconciling): batched GraphQL, about one request
   * for each 25 repositories with one credential, never one listing for each repository.
   */
  openPullRequestsIn(repos: string[]): Promise<OpenPullRequestsIn>;
  /**
   * The followed pull requests `refs` and their issues (issue #985, the in-motion cycle): batched GraphQL, about one request
   * for each 50 pull requests with one credential. A pull request GitHub does not answer for is in `errors`, never a throw.
   */
  pullRequestStates(refs: PullRequestRef[]): Promise<PullRequestStates>;
  /**
   * Merge pull request `number` of `repo` with a merge commit (issue #637: yolo mode, the hopper's own merge of a ready
   * pull request it follows). GitHub's refusal — not mergeable, checks required, no access — throws.
   */
  merge(repo: string, number: number): Promise<void>;
  /**
   * Close pull request `number` of `repo` without a merge (issue #677: a person's Close PR; issue #1143: a job's pull
   * request with nothing left to land).
   */
  closeWithoutMerge(repo: string, number: number): Promise<void>;
  /** Change the base branch of open pull request `number` of `repo` to `base` (issue #1143: to the landing branch). GitHub's refusal throws. */
  retarget(repo: string, number: number, base: string): Promise<void>;
  /**
   * The log of GitHub Actions job `jobId` of `repo` (issue #993): what a failed check printed, the whole text. Through the
   * shared rate limiter as every call. GitHub refuses it (403) without the Actions read permission. Absent: not read.
   */
  jobLog?(repo: string, jobId: number): Promise<string>;
  /**
   * Run GitHub Actions job `jobId` of `repo` again (issue #1230: a failed check of a job's own pull request, once, before the
   * job is sent back to fix it). GitHub refuses it (403) without the Actions write permission; a refusal throws. Absent: not run.
   */
  rerunJob?(repo: string, jobId: number): Promise<void>;
  /**
   * GitHub Actions workflow run `runId` of `repo` (issue #1508: a run a job's wait names): its link, its status and, once it
   * completed, its conclusion. GitHub refuses it (403) without the Actions read permission; a refusal throws. Absent: not read.
   */
  workflowRun?(repo: string, runId: number): Promise<WorkflowRun>;
  /**
   * The reviews of pull request `number` of `repo` (issue #1694 part 3: a job's wait on its review), oldest first, each its
   * state in lower case (`approved`, `changes_requested`, `commented`, `dismissed`) and when it was sent. A review not yet
   * sent is none. Absent: not read.
   */
  pullRequestReviews?(repo: string, number: number): Promise<PullRequestReview[]>;
  /**
   * The checks of commit `ref` (a head commit, or a branch) of `repo` (issue #1244), over REST: its check runs and its
   * combined status. What the hopper reads when GitHub refuses the GraphQL rollup (`checksFallback`). A refusal of either
   * read (403, 404) is in `unreadable`; any other error throws. Absent: not read.
   */
  headChecks?(repo: string, ref: string): Promise<HeadChecks>;
  /**
   * Each check of commit `ref` of `repo` (issue #1924, the done criteria of a conditional skill): each check run by its name,
   * its state and its output's text (title, summary and text), and each commit status by its context, with no text. Over
   * REST; an error throws. Absent: not read.
   */
  checkRuns?(repo: string, ref: string): Promise<CheckFact[]>;
  /** Make open pull request `number` of `repo` a draft (issue #724: a person sent it back for rework). A draft stays one. GitHub's refusal throws. */
  toDraft(repo: string, number: number): Promise<void>;

  /**
   * Open issues with `label` assigned to the user, across every repo the token reaches (`GET /issues`, one
   * listing, not a search; issue #440). Only to suggest repos outside the job repositories, never intake. Absent: none is read.
   */
  listAssignedIssues?(label: string): Promise<GitHubIssue[]>;
  /**
   * The open issues and pull requests of `repos` that carry one of `labels` (issue #985, a **repository listing**): batched
   * GraphQL, about one request for each 25 repositories with one credential. A repository GitHub does not answer for is in
   * `repoErrors`, never a throw. What intake reads (issue #985 part 2): never one REST listing per repository.
   */
  listRepos(repos: string[], labels: string[]): Promise<RepoListing>;
  /**
   * The issues and pull requests of `repo` changed since `since` (GitHub's `updatedAt`; undefined: any), newest change
   * first, one page of at most CHANGE_READ_PAGE (issue #1125, a **change read**): `GET /repos/{owner}/{repo}/issues` with
   * `state=all` and `since`, a conditional request, so an answer GitHub has not changed costs no call (304). Through the
   * intake reserve, and never waits for the rate limit: a call that would wait is not made (GitHubRateLimited). Absent: not
   * read, and intake waits for the timed listing.
   */
  issuesChangedSince?(repo: string, since: string | undefined): Promise<IssueChange[]>;
  /**
   * The open issues and pull requests of `repos` where `login` is a requested reviewer, is @mentioned, or is assigned (issue
   * #1141, **tagged items**): GitHub's issue search, batched GraphQL, one hit per item and reason. Through the intake reserve.
   * Absent: none is read.
   */
  taggedItems?(login: string, repos: string[]): Promise<TaggedSearchHit[]>;

  /** Where git fetches `repo` and the token it fetches with, this adapter's own (issue #858: the hopper's mirror). Absent: no mirror. */
  gitRemote?(repo: string): Promise<GitRemote>;
  /**
   * Whether pull requests `a` and `b` of `repo`, both into `base`, conflict with each other, as the hopper's mirror says
   * (issue #939, `gitAnswers`); undefined: git cannot say. Absent: no mirror.
   */
  conflictBetween?(repo: string, base: string, a: number, b: number): Promise<boolean | undefined>;
  /**
   * Merge the base branch into pull request `pr` of `repo` in the hopper's mirror and push the merge commit to its branch
   * (issue #967, `gitAnswers`); undefined: git cannot. A write: it drops what the pass read of `repo`. Absent: no mirror.
   */
  baseMerge?(repo: string, pr: BaseMergeTarget): Promise<BaseMerge | undefined>;
  /**
   * The commit branch `base` of `repo` is at, as the hopper's mirror fetched it this pass (issue #1143 part 3,
   * `gitAnswers`); undefined: git cannot say. Absent: no mirror.
   */
  baseTip?(repo: string, base: string): Promise<string | undefined>;
  /**
   * The lines open pull request `pr` of `repo` changes in `paths`, as the hopper's mirror says (issue #1076, `gitAnswers`);
   * undefined: git cannot say. Absent: no mirror.
   */
  changedLines?(repo: string, pr: { number: number; base?: string; headOid?: string }, paths: string[]): Promise<ChangedLines | undefined>;
}

/** The most changes one change read answers (issue #1125): a full page may hold more, so it counts as a change. */
export const CHANGE_READ_PAGE = 100;

/** One issue or pull request a change read answered (issue #1125): what tells whether the listing cache still holds it, and its row if so. */
export interface IssueChange {
  number: number;
  kind: 'issue' | 'pull';
  state: 'open' | 'closed';
  title: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
}

export class GitHubApiError extends Error {
  readonly permanent: boolean;
  readonly status?: number;
  /** Rate-limited (issue #822): when the call is tried again, ms since the epoch. */
  readonly retryAt?: number;
  constructor(message: string, permanent: boolean, status?: number, retryAt?: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.permanent = permanent;
    if (status !== undefined) this.status = status;
    if (retryAt !== undefined) this.retryAt = retryAt;
  }
}

const PERMANENT_STATUSES = new Set([403, 404, 410, 422]);

/** Classify an HTTP status (and its message): rate limits are transient even as 403. */
export function isPermanent(status: number | undefined, message: string): boolean {
  if (/rate limit/i.test(message)) return false;
  if (/missing required scopes/i.test(message)) return true;
  return status !== undefined && PERMANENT_STATUSES.has(status);
}
