// The GitHubApi port: everything the GitHub source asks of GitHub. Adapters: the `gh` CLI
// (gh-cli.ts, posts as the owner), the GitHub App (app/, posts as the app bot), and the in-memory
// fake (fake.ts, either identity). Errors are GitHubApiError, classified
// permanent (403/404/410/422, missing scope) or transient (network, 5xx, rate limit, timeout).

import type { ChecksState, FailedCheck } from '../../domain/pull-requests.ts';
import type { ItemEdit } from '../../domain/item-snapshots.ts';
import type { IssueCrossReferences } from '../../domain/cross-references.ts';
import type { IssuePlace } from '../../domain/issue-graph.ts';
import type { BaseMergeTarget, GitRemote } from '../../git-mirror/mirrors.ts';
import type { BaseMerge } from '../../domain/pull-requests.ts';

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
  /** The checks of its head commit that failed (issue #927); read only for one pull request by its number. Absent: none, or not read. */
  failedChecks?: FailedCheck[];
  /** Its head commit (issue #858: what the mirror merges); absent: GitHub did not say. */
  headOid?: string;
  /** The branch it merges into (issue #677); absent: GitHub did not say. */
  base?: string;
  /** Its head branch (issue #900: a pull request based on it is stacked on it); absent: GitHub did not say. */
  headRef?: string;
}

/** A pull request by its number (issue #618): one an issue names to update, in any state. */
export interface NumberedPullRequest extends OpenPullRequest {
  state: 'open' | 'closed' | 'merged';
  /** When it was merged; absent unless merged. */
  mergedAt?: string;
}

/** An open pull request of a repository, with its branch (issue #637) and its body (issue #763: the issue it closes). */
export interface BranchPullRequest extends OpenPullRequest {
  /** Its head branch's name. */
  headRef: string;
  body: string;
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

export interface GitHubComment {
  /** Numeric and increasing: the order of comments on an issue. */
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  /** GitHub's `author_association` (issue #435: a maintainer's reply answers a thread question); absent: not known. */
  association?: string;
}

/** The comment a post made (issue #435): its id and link; id 0 when GitHub did not say. */
export interface PostedComment { id: number; url: string }

/**
 * A label or an assignment on an issue, from its events (issue #652): who did it, and through which app. What the trust
 * check of an issue's origin reads.
 */
export interface IssueEvent {
  event: 'labeled' | 'assigned';
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
  listOpenIssues(repo: string, label: string): Promise<GitHubIssue[]>;
  getIssue(repo: string, number: number): Promise<GitHubIssue>;
  /** The issue's GitHub sub-issues, all pages (issue #729: a sub-issue no checklist item "Parts" names is a part too). */
  subIssues(repo: string, number: number): Promise<SubIssue[]>;
  /** Every comment, all pages, oldest first. */
  listComments(repo: string, number: number): Promise<GitHubComment[]>;
  /** Who edited the issue's title or body, and when, from its timeline (issue #662), oldest first. Absent: not read. */
  issueEdits?(repo: string, number: number): Promise<ItemEdit[]>;
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
  /**
   * Post a comment on an issue: only a person's resolution of a hand-off (issue #551), the user's own act, and the one
   * that links the merged pull request when the hopper closes the issue after its merge (issue #677), and a question asked on
   * the issue thread (issue #435). Answers the comment made.
   */
  postComment(repo: string, number: number, body: string): Promise<PostedComment>;
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
  /**
   * Merge pull request `number` of `repo` with a merge commit (issue #637: yolo mode, the hopper's own merge of a ready
   * pull request it follows). GitHub's refusal — not mergeable, checks required, no access — throws.
   */
  merge(repo: string, number: number): Promise<void>;
  /** Close pull request `number` of `repo` without a merge (issue #677: a person's Close PR). */
  closeWithoutMerge(repo: string, number: number): Promise<void>;
  /** Make open pull request `number` of `repo` a draft (issue #724: a person sent it back for rework). A draft stays one. GitHub's refusal throws. */
  toDraft(repo: string, number: number): Promise<void>;

  /**
   * Open issues with `label` assigned to the user, across every repo the token reaches (`GET /issues`, one
   * listing, not a search; issue #440). Only to suggest repos outside the job repositories, never intake.
   * Absent on the App adapter: an installation token has no user.
   */
  listAssignedIssues?(label: string): Promise<GitHubIssue[]>;

  // ---- GitHub App mode only (absent on the connected account's adapter) ----------------------------

  /**
   * The login the adapter's writes appear under — the app bot, e.g. "hopper-owner[bot]".
   * Present ⇒ hopper comments are identified by this author (the marker is a secondary check).
   */
  botLogin?(): Promise<string>;
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
  /** Every repo (owner/repo) the app is installed on, across installations: the allowlist. */
  listInstalledRepos?(): Promise<{ repo: string; installationId: number }[]>;
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
