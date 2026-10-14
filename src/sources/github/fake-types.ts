// The in-memory GitHub's types (fake.ts): the helpers a test plays the other side with, apart for the fake's size.
import type { ChecksState, FailedCheck } from '../../domain/pull-requests.ts';
import type { FakeBaseMerge } from './fake-conflicts.ts';
import type { FakeMentionInput } from './fake-cross-references.ts';
import type { GitHubApi, GitHubComment, GitHubIssue, OpenPullRequest, ClosingPullRequest } from './api.ts';

export type Method = keyof GitHubApi;

/** Who did an act on GitHub (issue #652): a login, or a login with GitHub's actor type and the app it went through. */
export type FakeActor = string | { login: string; id?: number; type?: string; viaApp?: string };

export interface FakeGitHub extends GitHubApi {
  /** An issue; its labels and assignees are events by `labelledBy` and `assignedBy` (default: its author, issue #652); `authorId`: the author's GitHub user id (issue #930), absent: not told; `parent`: it is a sub-issue of that issue of the same repo (issue #729). */
  createIssue(o: { repo: string; title?: string; body?: string; author?: string; authorId?: number; assignees?: string[]; labels?: string[]; labelledBy?: FakeActor; assignedBy?: FakeActor; parent?: number }): GitHubIssue;
  /** Assign `login`, recorded as an `assigned` event at `at` (default the fake's clock) by `by` (default the fake's login). */
  assign(repo: string, number: number, login: string, at?: string, by?: FakeActor): void;
  unassign(repo: string, number: number, login: string): void;
  /** A repository GitHub does not answer for in a repository listing (issue #985), with GitHub's message; undefined answers again. */
  failRepo(repo: string, message: string | undefined): void;
  /** A comment by `author`; `association`: GitHub's `author_association` of it (issue #435), absent: none told. */
  addComment(repo: string, number: number, author: string, body: string, association?: string): GitHubComment;
  /** Edit the issue's title or body as `editor`, at `at` (default now), kept on its timeline (issue #662); its `updatedAt` becomes `at`. */
  editIssue(repo: string, number: number, change: { title?: string; body?: string }, editor: string, at?: string): void;
  /**
   * Closed by hand or by a commit, no pull request: as `reason` (default completed), at `at` (default the
   * fake's clock, 2026-10-02T09:00, before any test job is created).
   */
  closeIssue(repo: string, number: number, closedBy?: string, o?: { at?: string; reason?: 'completed' | 'not_planned' }): void;
  /** A pull request (opened at createdAt) whose merge will close the issue; the issue stays open. */
  openPullRequest(repo: string, number: number, pr: PullRequestInput): OpenPullRequest;
  /** A pull request (opened at createdAt) that ships part of the issue: its body says "Part of #N"; the issue stays open. */
  openPartPullRequest(repo: string, number: number, pr: PullRequestInput): OpenPullRequest;
  /** A pull request (opened at createdAt) that only mentions the issue (issue #637): its body says "Refs #N", no closing keyword. */
  openReferencingPullRequest(repo: string, number: number, pr: PullRequestInput): OpenPullRequest;
  /** A pull request (opened at createdAt) that names no issue in its text, only on its branch `headRef` (issue #637). */
  openUnlinkedPullRequest(repo: string, pr: PullRequestInput & { headRef: string }): OpenPullRequest;
  /**
   * A pull request (default; of `from`, default the issue's repository) or a commit that mentions the issue with `text`
   * (issue #430). `closes`: GitHub links it as closing the issue — a commit that closes it closes it now. Its URL.
   */
  mentionIssue(repo: string, number: number, m: FakeMentionInput): string;
  /** Its head commit's checks now (issue #637); undefined: none. */
  setChecks(url: string, checks: ChecksState | undefined, failedChecks?: FailedCheck[]): void;
  /** The log of GitHub Actions job `jobId` of `repo` (issue #993): its text, or the error GitHub answers for it. */
  setJobLog(repo: string, jobId: number, log: string | Error): void;
  /** Its base branch moved (issue #736): it has merge conflicts with it now, or not, with no push to it. */
  setConflicting(url: string, conflicting: boolean): void;
  /** Whether two pull requests conflict with each other, as git would say (issue #939); never set: git cannot say. */
  setConflictBetween(a: string, b: string, conflict: boolean): void;
  /** What the hopper's base merge of a pull request does (issue #967): pushed, resolving `resolved`, or the conflicts it leaves; undefined: git cannot. */
  setBaseMerge(url: string, answer: FakeBaseMerge | undefined): void;
  /** The commit base branch `base` of `repo` is at, as the hopper's mirror would say (issue #1143 part 3); undefined: git cannot say. */
  setBaseTip(repo: string, base: string, tip: string | undefined): void;
  /** A push to a pull request's branch (issue #618): a new head commit at `at`, with or without merge conflicts after it. */
  pushToPullRequest(url: string, at: string, o?: { conflicting?: boolean }): void;
  /** Mark an open draft pull request ready for review (issue #626). */
  markReady(url: string): void;
  /** Merge an open pull request (at `at`, default now): one that closes its issue closes it. */
  mergePullRequest(url: string, at?: string): void;
  /** Close an open pull request without a merge. */
  closePullRequest(url: string): void;
  /** The merge of a pull request (opened at createdAt) closes the issue; no open one is left. */
  closeByPullRequest(repo: string, number: number, pr: { createdAt: string; mergedAt: string }): ClosingPullRequest;
  deleteIssue(repo: string, number: number): void;
  /** Add `label`, a `labeled` event by `by` (default the fake's login). */
  addLabel(repo: string, number: number, label: string, by?: FakeActor): void;
  removeLabel(repo: string, number: number, label: string): void;
  setProjectItems(owner: string, number: number, items: { url: string; fields?: Record<string, string | number> }[] | Error): void;
  /** The next call of `method` rejects with `error`. */
  failNext(method: Method, error: Error): void;
  issue(repo: string, number: number): GitHubIssue;
  commentsOn(repo: string, number: number): GitHubComment[];
  /** The bodies of the comments on a pull request, by its URL, oldest first (issue #1143). */
  pullRequestComments(url: string): string[];
  labelsIn(repo: string): string[];
  /** App identity only: replace the repos the app is installed on. */
  setInstalledRepos(repos: string[]): void;
  readonly calls: { method: Method; args: unknown[] }[];
}

/** A pull request to open: when, a draft or not, merge conflicts or not, and its head commit's time (default createdAt). */
export interface PullRequestInput {
  createdAt: string; isDraft?: boolean; conflicting?: boolean; headCommittedAt?: string; checks?: ChecksState; failedChecks?: FailedCheck[]; headRef?: string; base?: string;
  /** What it changes, as the mirror would say (issue #935 part 2): answered when it is read by its number. */
  commits?: string[]; files?: string[];
  /** The lines it changes per file, as the mirror would say (issue #1076); absent: git cannot say. */
  diff?: Record<string, string[] | 'binary'>;
  /** Its body in place of the fixed text (issue #786); it still mentions the issue. */
  body?: string;
}

export interface FakeAppIdentity {
  botLogin: string;
  installedRepos?: string[];
}

