// In-memory GitHub implementing GitHubApi, plus helpers for tests to play the owner (or a
// stranger) on the other side: create issues, reply, open a pull request that closes one on merge,
// close (by hand or by merging a pull request),
// unlabel, delete, set project items.
// Default identity: gh (writes appear as `login`). With `app`, writes appear as the bot and the
// app-only methods exist: the bot login and the installed repos.

import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest, GitHubApi, GitHubComment, GitHubIssue, GitHubProjectItem, OpenPullRequest } from './api.ts';

type Method = keyof GitHubApi;

export interface FakeGitHub extends GitHubApi {
  createIssue(o: { repo: string; title?: string; body?: string; author?: string; labels?: string[] }): GitHubIssue;
  addComment(repo: string, number: number, author: string, body: string): GitHubComment;
  /**
   * Closed by hand or by a commit, no pull request: as `reason` (default completed), at `at` (default the
   * fake's clock, 2026-10-02T09:00, before any test job is created).
   */
  closeIssue(repo: string, number: number, closedBy?: string, o?: { at?: string; reason?: 'completed' | 'not_planned' }): void;
  reopenIssue(repo: string, number: number): void;
  /** A pull request (opened at createdAt) whose merge will close the issue; the issue stays open. */
  openPullRequest(repo: string, number: number, pr: { createdAt: string; isDraft?: boolean }): OpenPullRequest;
  /** The merge of a pull request (opened at createdAt) closes the issue; no open one is left. */
  closeByPullRequest(repo: string, number: number, pr: { createdAt: string; mergedAt: string }): ClosingPullRequest;
  deleteIssue(repo: string, number: number): void;
  addLabel(repo: string, number: number, label: string): void;
  removeLabel(repo: string, number: number, label: string): void;
  setProjectItems(owner: string, number: number, items: { url: string; fields?: Record<string, string | number> }[] | Error): void;
  /** The next call of `method` rejects with `error`. */
  failNext(method: Method, error: Error): void;
  issue(repo: string, number: number): GitHubIssue;
  commentsOn(repo: string, number: number): GitHubComment[];
  labelsIn(repo: string): string[];
  /** App identity only: replace the repos the app is installed on. */
  setInstalledRepos(repos: string[]): void;
  readonly calls: { method: Method; args: unknown[] }[];
}

export interface FakeAppIdentity {
  botLogin: string;
  installedRepos?: string[];
}

const notFound = (what: string) => new GitHubApiError(`gh: Not Found (HTTP 404): ${what}`, true, 404);

export function createFakeGitHub(o: { login?: string; app?: FakeAppIdentity } = {}): FakeGitHub {
  const human = o.login ?? 'owner';
  const login = o.app?.botLogin ?? human;
  let installed = [...(o.app?.installedRepos ?? [])];
  const issues = new Map<string, GitHubIssue>();
  const comments = new Map<string, GitHubComment[]>();
  const labels = new Map<string, Set<string>>();
  const closers = new Map<string, ClosingPullRequest>();
  const opened = new Map<string, OpenPullRequest[]>();
  let pullNumber = 1000;
  const projects = new Map<string, GitHubProjectItem[] | Error>();
  const failures = new Map<Method, Error[]>();
  const calls: { method: Method; args: unknown[] }[] = [];
  let commentId = 1000;
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 2, 9, 0, tick++)).toISOString();
  const key = (repo: string, n: number) => `${repo}#${n}`;
  const repoLabels = (repo: string) => labels.get(repo) ?? labels.set(repo, new Set()).get(repo)!;

  const find = (repo: string, n: number): GitHubIssue => {
    const i = issues.get(key(repo, n));
    if (!i) throw notFound(`${repo}#${n}`);
    return i;
  };
  const copy = (i: GitHubIssue): GitHubIssue => ({ ...i, labels: [...i.labels] });
  const enter = (method: Method, args: unknown[]) => {
    calls.push({ method, args });
    const err = failures.get(method)?.shift();
    if (err) throw err;
  };
  const open = (label: string) => [...issues.values()].filter((i) => i.state === 'open' && i.labels.includes(label));

  const api: GitHubApi = {
    async whoami() { enter('whoami', []); return login; },
    async searchOpenIssues(q) {
      enter('searchOpenIssues', [q]);
      return open(q.label).filter((i) => q.owners.includes(i.repo.split('/')[0]!)).map(copy);
    },
    async listOpenIssues(repo, label) {
      enter('listOpenIssues', [repo, label]);
      return open(label).filter((i) => i.repo === repo).map(copy);
    },
    async getIssue(repo, n) { enter('getIssue', [repo, n]); return copy(find(repo, n)); },
    async listComments(repo, n) {
      enter('listComments', [repo, n]);
      find(repo, n);
      return (comments.get(key(repo, n)) ?? []).map((c) => ({ ...c }));
    },
    async projectItems(owner, n) {
      enter('projectItems', [owner, n]);
      const p = projects.get(`${owner}/${n}`);
      if (p instanceof Error) throw p;
      if (!p) throw new GitHubApiError(`project ${owner}/${n} not found`, true, 404);
      return p.map((i) => ({ ...i, fields: { ...i.fields } }));
    },
    async ensureLabel(repo, name, color, description) { enter('ensureLabel', [repo, name, color, description]); repoLabels(repo).add(name); },
    async addLabels(repo, n, names) {
      enter('addLabels', [repo, n, names]);
      const i = find(repo, n);
      const missing = names.find((l) => !repoLabels(repo).has(l));
      if (missing) throw new GitHubApiError(`gh: label '${missing}' not found (HTTP 422)`, true, 422);
      for (const l of names) if (!i.labels.includes(l)) i.labels.push(l);
    },
    async removeLabels(repo, n, names) {
      enter('removeLabels', [repo, n, names]);
      const i = find(repo, n);
      i.labels = i.labels.filter((l) => !names.includes(l));
    },
    async closingPullRequest(repo, n) {
      enter('closingPullRequest', [repo, n]);
      find(repo, n);
      const pr = closers.get(key(repo, n));
      return pr ? { ...pr } : undefined;
    },
    async openClosingPullRequests(repo, n) {
      enter('openClosingPullRequests', [repo, n]);
      find(repo, n);
      return (opened.get(key(repo, n)) ?? []).map((pr) => ({ ...pr }));
    },
  };

  if (o.app) {
    const app = o.app;
    api.botLogin = async () => { enter('botLogin', []); return app.botLogin; };
    api.listInstalledRepos = async () => { enter('listInstalledRepos', []); return installed.map((repo, i) => ({ repo, installationId: 100 + i })); };
  }

  const fake: FakeGitHub = {
    ...api,
    setInstalledRepos(repos) { installed = [...repos]; },
    calls,
    createIssue({ repo, title, body, author, labels: ls }) {
      const number = [...issues.values()].filter((i) => i.repo === repo).length + 1;
      for (const l of ls ?? []) repoLabels(repo).add(l);
      const issue: GitHubIssue = {
        repo, number, url: `https://github.com/${repo}/issues/${number}`, title: title ?? `Issue ${number}`,
        body: body ?? `Do thing ${number}.`, author: author ?? human, labels: [...(ls ?? [])], state: 'open', updatedAt: stamp(),
      };
      issues.set(key(repo, number), issue);
      return copy(issue);
    },
    addComment(repo, n, author, body) {
      const i = find(repo, n);
      const c: GitHubComment = { id: ++commentId, author, body, createdAt: stamp(), url: `${i.url}#issuecomment-${commentId}` };
      comments.set(key(repo, n), [...(comments.get(key(repo, n)) ?? []), c]);
      return { ...c };
    },
    closeIssue(repo, n, closedBy, c = {}) {
      const i = find(repo, n);
      Object.assign(i, { state: 'closed', closedBy: closedBy ?? human, closedAt: c.at ?? stamp(), stateReason: c.reason ?? 'completed' });
      closers.delete(key(repo, n));
    },
    reopenIssue(repo, n) { const i = find(repo, n); i.state = 'open'; delete i.closedBy; delete i.closedAt; delete i.stateReason; },
    openPullRequest(repo, n, { createdAt, isDraft }) {
      find(repo, n);
      const pr = { url: `https://github.com/${repo}/pull/${++pullNumber}`, createdAt, isDraft: isDraft ?? false };
      opened.set(key(repo, n), [...(opened.get(key(repo, n)) ?? []), pr]);
      return { ...pr };
    },
    closeByPullRequest(repo, n, { createdAt, mergedAt }) {
      const i = find(repo, n);
      opened.delete(key(repo, n));
      Object.assign(i, { state: 'closed', closedBy: human, closedAt: mergedAt, stateReason: 'completed' });
      const pr = { url: `https://github.com/${repo}/pull/${++pullNumber}`, createdAt, mergedAt };
      closers.set(key(repo, n), pr);
      return { ...pr };
    },
    deleteIssue(repo, n) { find(repo, n); issues.delete(key(repo, n)); },
    addLabel(repo, n, label) { repoLabels(repo).add(label); const i = find(repo, n); if (!i.labels.includes(label)) i.labels.push(label); },
    removeLabel(repo, n, label) { const i = find(repo, n); i.labels = i.labels.filter((l) => l !== label); },
    setProjectItems(owner, n, items) {
      projects.set(`${owner}/${n}`, items instanceof Error ? items : items.map((it, index) => ({ url: it.url, index, fields: { ...(it.fields ?? {}) } })));
    },
    failNext(method, error) { failures.set(method, [...(failures.get(method) ?? []), error]); },
    issue(repo, n) { return copy(find(repo, n)); },
    commentsOn(repo, n) { return (comments.get(key(repo, n)) ?? []).map((c) => ({ ...c })); },
    labelsIn(repo) { return [...repoLabels(repo)]; },
  };
  return fake;
}
