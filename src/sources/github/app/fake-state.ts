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
  closedBy?: string;
  closedAt?: string;
  stateReason?: string;
  /** The merged pull request that closed it (GraphQL ClosedEvent closer). */
  closedByPullRequest?: { url: string; createdAt: string; mergedAt: string };
  /** Open pull requests whose merge will close it (GraphQL closedByPullRequestsReferences). */
  openPullRequests?: { url: string; createdAt: string; isDraft: boolean; mergeable?: string }[];
  /** Pull requests that mention it, any state (GraphQL CrossReferencedEvent sources; issue #579). */
  mentionedBy?: FakeMention[];
  comments?: FakeCommentInput[];
}

export interface FakeMention { url: string; createdAt: string; isDraft: boolean; state: 'OPEN' | 'CLOSED' | 'MERGED'; body: string; repo: string; mergeable?: string }

export interface FakeRepoInput { owner: string; name: string; labels?: string[]; issues?: FakeIssueInput[] }

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

export interface FakeGitHubOptions {
  appId: number;
  publicKeyPem: string;
  /** The app slug; comments post as `<slug>[bot]`. Default "hopper". */
  slug?: string;
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
  closedBy?: string;
  closedAt?: string;
  stateReason?: string;
  closedByPullRequest?: { url: string; createdAt: string; mergedAt: string };
  openPullRequests: { url: string; createdAt: string; isDraft: boolean; mergeable?: string }[];
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
}

export interface FakeTokenRecord {
  token: string;
  installationId: number;
  /** The mint request body, as sent. */
  body: { repositories?: string[]; permissions?: Record<string, string> };
  expiresAt: string;
}

export interface FakeRequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Which credential the request carried and the fake accepted ('none' when absent or refused). */
  auth: 'jwt' | 'token' | 'none';
  body?: unknown;
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
    repos: new Map(), tokens: [], requests: [], installations: o.installations, projects: o.projects ?? [], nextCommentId: 1000,
  };
  for (const inst of o.installations) {
    for (const r of inst.repos) {
      const issues = new Map<number, FakeIssue>();
      for (const i of r.issues ?? []) {
        const comments = (i.comments ?? []).map((c) => ({ id: state.nextCommentId++, author: c.author, body: c.body, createdAt: now }));
        issues.set(i.number, {
          number: i.number, title: i.title ?? `Issue ${i.number}`, body: i.body ?? '', author: i.author ?? 'owner', assignees: [...(i.assignees ?? [i.author ?? 'owner'])],
          labels: [...(i.labels ?? [])], state: i.state ?? 'open', pullRequest: i.pullRequest ?? false,
          ...(i.closedBy ? { closedBy: i.closedBy } : {}),
          ...(i.closedAt ? { closedAt: i.closedAt } : {}),
          ...(i.stateReason ? { stateReason: i.stateReason } : {}),
          ...(i.closedByPullRequest ? { closedByPullRequest: { ...i.closedByPullRequest } } : {}),
          openPullRequests: (i.openPullRequests ?? []).map((pr) => ({ ...pr })), mentionedBy: (i.mentionedBy ?? []).map((m) => ({ ...m })), updatedAt: now, comments,
        });
      }
      state.repos.set(`${r.owner}/${r.name}`, {
        owner: r.owner, name: r.name, installationId: inst.id, labels: new Set(r.labels ?? []), issues,
      });
    }
  }
  return state;
}
