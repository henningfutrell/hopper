// The GitHubApi port: everything the GitHub source asks of GitHub. Adapters: the `gh` CLI
// (gh-cli.ts, posts as the owner), the GitHub App (app/, posts as the app bot), and the in-memory
// fake (fake.ts, either identity). Errors are GitHubApiError, classified
// permanent (403/404/410/422, missing scope) or transient (network, 5xx, rate limit, timeout).

import type { ChecksState } from '../../domain/pull-requests.ts';

export interface GitHubIssue {
  /** owner/repo */
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
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
}

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
  /** GitHub says it cannot merge as it stands (`mergeable: CONFLICTING`); not yet computed counts as not. */
  conflicting: boolean;
  /**
   * When its head commit was committed (issue #618): a push that rebases or updates it makes a new head commit. A job
   * that updated it pushed at or after it began. Absent: GitHub did not say.
   */
  headCommittedAt?: string;
  /** Its head commit's checks (issue #637, GitHub's status check rollup); absent: it has none. */
  checks?: ChecksState;
}

/** A pull request by its number (issue #618): one an issue names to update, in any state. */
export interface NumberedPullRequest extends OpenPullRequest {
  state: 'open' | 'closed' | 'merged';
  /** When it was merged; absent unless merged. */
  mergedAt?: string;
}

/** An open pull request of a repository, with its branch (issue #637). */
export interface BranchPullRequest extends OpenPullRequest {
  /** Its head branch's name. */
  headRef: string;
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
}

export interface GitHubProjectItem {
  /** The issue url. */
  url: string;
  /** Position in the project's item order (0 = top), counting every item returned. */
  index: number;
  /** Field values by key as gh returns them (lowercased names). */
  fields: Record<string, string | number>;
}

export interface GitHubApi {
  listOpenIssues(repo: string, label: string): Promise<GitHubIssue[]>;
  getIssue(repo: string, number: number): Promise<GitHubIssue>;
  /** Every comment, all pages, oldest first. */
  listComments(repo: string, number: number): Promise<GitHubComment[]>;
  /** Throws a permanent GitHubApiError mentioning `read:project` when that scope is missing. */
  projectItems(owner: string, number: number): Promise<GitHubProjectItem[]>;
  ensureLabel(repo: string, name: string, color: string, description: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabels(repo: string, number: number, labels: string[]): Promise<void>;
  /** When the issue was last assigned to `login` (its newest `assigned` event), or undefined when never (issue #387). */
  assignedAt(repo: string, number: number, login: string): Promise<string | undefined>;
  /** Add assignees to an issue (Assign to me in Sources, issue #440): the user's own act, never the hopper's. */
  addAssignees(repo: string, number: number, logins: string[]): Promise<void>;
  /** Reopen a closed issue (Run again, issue #354); an open one stays open. */
  reopenIssue(repo: string, number: number): Promise<void>;
  /** Post a comment on an issue: only a person's resolution of a hand-off (issue #551), the user's own act. */
  postComment(repo: string, number: number, body: string): Promise<void>;
  /** The merged pull request that closed the issue last; undefined when a person or a commit closed it. */
  closingPullRequest(repo: string, number: number): Promise<ClosingPullRequest | undefined>;
  /** The open pull requests whose merge will close the issue, drafts included; none is []. */
  openClosingPullRequests(repo: string, number: number): Promise<OpenPullRequest[]>;
  /** The pull requests that mention the issue, newest 100, any state (issue #579); none is []. */
  referencingPullRequests(repo: string, number: number): Promise<ReferencingPullRequest[]>;
  /** Pull request `number` of `repo` (issue #618); undefined when the number is an issue or names nothing. */
  pullRequest(repo: string, number: number): Promise<NumberedPullRequest | undefined>;
  /** The open pull requests of `repo`, newest 100, each with its branch (issue #637: one named for an issue); none is []. */
  openPullRequests(repo: string): Promise<BranchPullRequest[]>;
  /**
   * Merge pull request `number` of `repo` with a merge commit (issue #637: yolo mode, the hopper's own merge of a ready
   * pull request it follows). GitHub's refusal — not mergeable, checks required, no access — throws.
   */
  merge(repo: string, number: number): Promise<void>;

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
  /** Every repo (owner/repo) the app is installed on, across installations: the allowlist. */
  listInstalledRepos?(): Promise<{ repo: string; installationId: number }[]>;
}

export class GitHubApiError extends Error {
  readonly permanent: boolean;
  readonly status?: number;
  constructor(message: string, permanent: boolean, status?: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.permanent = permanent;
    if (status !== undefined) this.status = status;
  }
}

const PERMANENT_STATUSES = new Set([403, 404, 410, 422]);

/** Classify an HTTP status (and its message): rate limits are transient even as 403. */
export function isPermanent(status: number | undefined, message: string): boolean {
  if (/rate limit/i.test(message)) return false;
  if (/missing required scopes/i.test(message)) return true;
  return status !== undefined && PERMANENT_STATUSES.has(status);
}
