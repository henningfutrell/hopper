// State and shapes of the node:http fake GitHub (fake-server.ts). Test support only: the daemon
// never imports it.

export interface FakeCommentInput { author: string; body: string }

export interface FakeIssueInput {
  number: number;
  title?: string;
  body?: string;
  author?: string;
  /** Default: the author (issue #387: intake is by label and assignee). */
  assignees?: string[];
  labels?: string[];
  state?: 'open' | 'closed';
  /** A pull request: the issues list returns it (with `pull_request`), the adapter skips it. */
  pullRequest?: boolean;
  /** A pull request's head, base, mergeable and check rollup state as a repository listing reads them (issue #985). */
  pull?: FakePullFields;
  /** Default: when the fake started. */
  updatedAt?: string;
  closedBy?: string;
  closedAt?: string;
  stateReason?: string;
  /** The merged pull request that closed it (GraphQL ClosedEvent closer). */
  closedByPullRequest?: { url: string; createdAt: string; mergedAt: string };
  /** Open pull requests whose merge will close it (GraphQL closedByPullRequestsReferences). */
  openPullRequests?: FakePullRequest[];
  /** Pull requests that mention it, any state (GraphQL CrossReferencedEvent sources; issue #579). */
  mentionedBy?: FakeMention[];
  comments?: FakeCommentInput[];
}

/**
 * What a repository listing and a batched pull request read tell of a pull request (issue #985): `checks`, GitHub's rollup
 * state, absent for no checks; `state`, GitHub's (default `OPEN`); `committedAt`, when its head commit was made; its body is
 * the issue entry's.
 */
export interface FakePullFields {
  headRef?: string; headOid?: string; base?: string; isDraft?: boolean; mergeable?: string; checks?: string;
  state?: 'OPEN' | 'CLOSED' | 'MERGED'; createdAt?: string; committedAt?: string;
  /** Its head commit's check runs and commit statuses as REST tells them (issue #1244); absent: none. */
  checkRuns?: { status: string; conclusion?: string | null }[];
  statuses?: { state: string }[];
}

/**
 * What a token may not read in a repository (issue #1244): `checks` (Checks: read) and `statuses` (Commit statuses: read)
 * refuse their REST reads and the GraphQL rollup; `rollup` refuses only the rollup.
 */
export type FakeLack = 'checks' | 'statuses' | 'rollup';

/** A pull request as GraphQL tells it; `headCommittedAt`: when its head commit was made (issue #618). */
export interface FakePullRequest { url: string; createdAt: string; isDraft: boolean; mergeable?: string; headCommittedAt?: string }

export interface FakeMention extends FakePullRequest { state: 'OPEN' | 'CLOSED' | 'MERGED'; body: string; repo: string; mergedAt?: string }

export interface FakeRepoInput { owner: string; name: string; labels?: string[]; issues?: FakeIssueInput[]; lacks?: FakeLack[] }

export interface FakeInstallationInput {
  id: number;
  /** The account login the installation is on. */
  account: string;
  accountType?: 'User' | 'Organization';
  repos: FakeRepoInput[];
}

export interface FakeProjectInput {
  owner: string;
  number: number;
  items: { url: string; fields: Record<string, string | number> }[];
}

/** The connected account's token the fake takes when its options name none. */
export const FAKE_USER_TOKEN = 'ghu_fake-user-token';

export interface FakeGitHubOptions {
  /** The connected account's login: its writes appear under it. Default "owner". */
  login?: string;
  /** The connected account's token (a user-to-server token of the hopper's app). Default FAKE_USER_TOKEN. */
  token?: string;
  /** Where the hopper's app is installed: the token reaches these repositories, and no other. */
  installations: FakeInstallationInput[];
  projects?: FakeProjectInput[];
  /** Forces this page size on every paginated endpoint (to exercise pagination). */
  pageSize?: number;
}

export interface FakeComment { id: number; author: string; body: string; createdAt: string }

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  assignees: string[];
  labels: string[];
  state: 'open' | 'closed';
  pullRequest: boolean;
  pull?: FakePullFields;
  closedBy?: string;
  closedAt?: string;
  stateReason?: string;
  closedByPullRequest?: { url: string; createdAt: string; mergedAt: string };
  openPullRequests: FakePullRequest[];
  mentionedBy: FakeMention[];
  updatedAt: string;
  comments: FakeComment[];
}

export interface FakeRepo {
  owner: string;
  name: string;
  installationId: number;
  labels: Set<string>;
  issues: Map<number, FakeIssue>;
  lacks: FakeLack[];
}

export interface FakeTokenRecord {
  token: string;
  expiresAt: string;
}

export interface FakeRequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Which credential the request carried and the fake accepted ('none' when absent or refused). */
  auth: 'token' | 'none';
  body?: unknown;
  /** Answered 304 (issue #1125): its ETag still held, so GitHub would not charge it. */
  notModified?: true;
}

export interface FakeState {
  /** By "owner/name". */
  repos: Map<string, FakeRepo>;
  tokens: FakeTokenRecord[];
  requests: FakeRequestRecord[];
  installations: FakeInstallationInput[];
  projects: FakeProjectInput[];
  nextCommentId: number;
}

export function buildState(o: FakeGitHubOptions, now: string): FakeState {
  const state: FakeState = {
    repos: new Map(), tokens: [{ token: o.token ?? FAKE_USER_TOKEN, expiresAt: new Date(Date.parse(now) + 24 * 3600_000).toISOString() }], requests: [], installations: o.installations, projects: o.projects ?? [], nextCommentId: 1000,
  };
  for (const inst of o.installations) {
    for (const r of inst.repos) {
      const issues = new Map<number, FakeIssue>();
      for (const i of r.issues ?? []) {
        const comments = (i.comments ?? []).map((c) => ({ id: state.nextCommentId++, author: c.author, body: c.body, createdAt: now }));
        issues.set(i.number, {
          number: i.number, title: i.title ?? `Issue ${i.number}`, body: i.body ?? '', author: i.author ?? 'owner', assignees: [...(i.assignees ?? [i.author ?? 'owner'])],
          labels: [...(i.labels ?? [])], state: i.state ?? 'open', pullRequest: i.pullRequest ?? false,
          ...(i.pull ? { pull: { ...i.pull } } : {}),
          ...(i.closedBy ? { closedBy: i.closedBy } : {}),
          ...(i.closedAt ? { closedAt: i.closedAt } : {}),
          ...(i.stateReason ? { stateReason: i.stateReason } : {}),
          ...(i.closedByPullRequest ? { closedByPullRequest: { ...i.closedByPullRequest } } : {}),
          openPullRequests: (i.openPullRequests ?? []).map((pr) => ({ ...pr })), mentionedBy: (i.mentionedBy ?? []).map((m) => ({ ...m })), updatedAt: i.updatedAt ?? now, comments,
        });
      }
      state.repos.set(`${r.owner}/${r.name}`, {
        owner: r.owner, name: r.name, installationId: inst.id, labels: new Set(r.labels ?? []), issues, lacks: r.lacks ?? [],
      });
    }
  }
  return state;
}
