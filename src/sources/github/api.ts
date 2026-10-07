// The GitHubApi port: everything the GitHub source asks of GitHub. Adapters: the `gh` CLI
// (gh-cli.ts, posts as the owner), the GitHub App (app/, posts as the app bot), and the in-memory
// fake (fake.ts, either identity). Errors are GitHubApiError, classified
// permanent (403/404/410/422, missing scope) or transient (network, 5xx, rate limit, timeout).

export interface GitHubIssue {
  /** owner/repo */
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
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
  /** Reopen a closed issue (Run again, issue #354); an open one stays open. */
  reopenIssue(repo: string, number: number): Promise<void>;
  /** The merged pull request that closed the issue last; undefined when a person or a commit closed it. */
  closingPullRequest(repo: string, number: number): Promise<ClosingPullRequest | undefined>;
  /** The open pull requests whose merge will close the issue, drafts included; none is []. */
  openClosingPullRequests(repo: string, number: number): Promise<OpenPullRequest[]>;

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
