// The GitHub App adapter of the GitHubApi port: writes appear as the app bot, and the app's
// installations are the repo allowlist. Lazy: the app's identity is asked for on first use and
// again whenever it changes (a new key), so the credentials are never read twice for nothing.

import type { Clock } from '../../../domain/ports.ts';
import { GitHubApiError, webOriginOf } from '../api.ts';
import type { GitHubApi } from '../api.ts';
import { createAuth } from './auth.ts';
import type { AppAuth } from './auth.ts';
import type { GitHubApp, GitHubAppLoad } from './config.ts';
import { closingPullRequest, crossReferences, issueEdits, issuePlace, openClosingPullRequests, openPullRequests, projectItems, pullRequest, referencingPullRequests } from './graphql.ts';
import { batchGraphQL } from './graphql-batch.ts';
import { listRepos } from './graphql-listing.ts';
import { openPullRequestsIn, pullRequestStates } from './graphql-pulls.ts';
import type { RepoListing } from '../../../domain/github-listing.ts';
import type { OpenPullRequestsIn, PullRequestStates } from '../api.ts';
import { pullKey } from '../api.ts';
import { SOURCE_DEFER_AFTER_MS, makeRequest, paginate, splitRepo, statusOf, toApiError } from './http.ts';
import * as rest from './rest.ts';

export type AppStatus = { ok: true; slug: string; botLogin: string; htmlUrl: string } | { ok: false; reason: string };
export type GitHubAppApi = GitHubApi & { appStatus(): AppStatus };

interface Loaded {
  /** What it was built from: the same identity means the same credentials. */
  key: string;
  app: GitHubApp;
  auth: AppAuth;
  /** owner/repo → installation id, from listInstalledRepos or a cold lookup. */
  installs: Map<string, number>;
  /** owner/repo → the cold lookup under way: the reads asked meanwhile wait on it. */
  asking: Map<string, Promise<number>>;
  /** installation account login → installation id, from GET /app/installations. */
  accounts?: Map<string, number>;
}

interface Installation { id: number; account?: { login?: string } | null }
interface InstalledRepo { full_name: string }

/** `app`: the identity now (github-app options + the key's variable); `keyEnv` names that variable in messages. */
export function createGitHubAppApi(o: { app(): GitHubAppLoad; keyEnv: string; baseUrl?: string; clock: Clock }): GitHubAppApi {
  const req = makeRequest(o.baseUrl ?? 'https://api.github.com', undefined, { deferAfterMs: SOURCE_DEFER_AFTER_MS });
  // The reads that look for new jobs stop at the intake reserve, so a job's own calls still go (issue #983).
  const intake = makeRequest(o.baseUrl ?? 'https://api.github.com', undefined, { deferAfterMs: SOURCE_DEFER_AFTER_MS, intake: true });
  const ask = batchGraphQL(req);
  let loaded: Loaded | undefined;
  let authError: string | undefined;

  const current = (): Loaded | { reason: string } => {
    const r = o.app();
    if (!r.ok) {
      loaded = undefined;
      return { reason: r.reason };
    }
    const key = `${r.app.appId}:${r.app.slug}:${r.app.privateKey}`;
    if (loaded?.key === key) return loaded;
    authError = undefined;
    loaded = { key, app: r.app, auth: createAuth(r.app, req), installs: new Map(), asking: new Map() };
    return loaded;
  };

  const need = (): Loaded => {
    const c = current();
    if ('reason' in c) {
      const why = c.reason === 'missing' ? `set appId and slug in the plugins config and ${o.keyEnv} in the environment (create-github-app.sh)` : c.reason;
      throw new GitHubApiError(`no app configured: ${why}`, true);
    }
    return c;
  };

  const call = async <T>(what: string, fn: (l: Loaded) => Promise<T>): Promise<T> => {
    const l = need();
    try {
      const v = await fn(l);
      authError = undefined;
      return v;
    } catch (err) {
      const e = toApiError(err, what, o.keyEnv);
      if (e.status === 401) authError = e.message;
      throw e;
    }
  };

  const bearer = async (l: Loaded) => `bearer ${await l.auth.jwt()}`;

  /** The installation covering `repo`; a cold cache asks GitHub (design B6), once for every read that waits on it (issue #822). */
  const installationFor = async (l: Loaded, repo: string): Promise<number> => {
    const hit = l.installs.get(repo);
    if (hit !== undefined) return hit;
    const asked = l.asking.get(repo);
    if (asked) return asked;
    const asking = (async () => {
      try {
        const r = await req('GET /repos/{owner}/{repo}/installation', { ...splitRepo(repo), headers: { authorization: await bearer(l) } });
        const id = (r.data as Installation).id;
        l.installs.set(repo, id);
        return id;
      } catch (err) {
        // No status: the 404 is about the installation, not the item asked for (an issue is not gone).
        if (statusOf(err) === 404) throw new GitHubApiError(`app not installed on ${repo}`, true);
        throw err;
      }
    })().finally(() => l.asking.delete(repo));
    l.asking.set(repo, asking);
    return asking;
  };

  const tokenFor = async (l: Loaded, repo: string) => l.auth.installationToken(await installationFor(l, repo));

  /**
   * `repos` grouped by the installation token that reaches them (issue #985: one batched read for each); a repository the app
   * is not installed on goes in `failed`, any other error throws.
   */
  const byInstallation = async (l: Loaded, repos: string[], failed: Map<string, string>): Promise<Map<string, string[]>> => {
    const byId = new Map<number, string[]>();
    const unique = [...new Set(repos)];
    const found = await Promise.allSettled(unique.map((repo) => installationFor(l, repo)));
    found.forEach((f, i) => {
      const repo = unique[i]!;
      if (f.status === 'fulfilled') byId.set(f.value, [...(byId.get(f.value) ?? []), repo]);
      else if (f.reason instanceof GitHubApiError && f.reason.permanent) failed.set(repo, f.reason.message);
      else throw f.reason;
    });
    const out = new Map<string, string[]>();
    for (const [id, some] of byId) out.set(await l.auth.installationToken(id), some);
    return out;
  };

  const listInstallations = async (l: Loaded): Promise<Installation[]> => {
    const all = await paginate(req, 'GET /app/installations', { per_page: 100 }, await bearer(l), (d) => d as Installation[]);
    l.accounts = new Map(all.filter((i) => i.account?.login).map((i) => [i.account!.login!, i.id]));
    return all;
  };

  return {
    appStatus() {
      const c = current();
      if ('reason' in c) return { ok: false, reason: c.reason };
      if (authError) return { ok: false, reason: authError };
      return { ok: true, slug: c.app.slug, botLogin: c.app.botLogin, htmlUrl: c.app.htmlUrl };
    },
    async botLogin() {
      return need().app.botLogin;
    },
    listInstalledRepos: () => call('list installed repos', async (l) => {
      const out: { repo: string; installationId: number }[] = [];
      for (const inst of await listInstallations(l)) {
        const token = await l.auth.installationToken(inst.id);
        const repos = await paginate(intake, 'GET /installation/repositories', { per_page: 100 }, `token ${token}`,
          (d) => (d as { repositories?: InstalledRepo[] }).repositories ?? []);
        for (const r of repos) {
          l.installs.set(r.full_name, inst.id);
          out.push({ repo: r.full_name, installationId: inst.id });
        }
      }
      return out;
    }),
    // One listing for each installation's token (issue #985): a repository the app is not installed on fails only itself.
    listRepos: (repos, labels) => call(`list ${repos.length} repositories`, async (l) => {
      const out: RepoListing = { repos: new Map(), repoErrors: new Map() };
      for (const [token, some] of await byInstallation(l, repos, out.repoErrors)) {
        const got = await listRepos(intake, token, some, labels);
        for (const [repo, items] of got.repos) out.repos.set(repo, items);
        for (const [repo, error] of got.repoErrors) out.repoErrors.set(repo, error);
      }
      return out;
    }),
    // The in-motion cycle's reads (issue #985), one batch for each installation's token, as a listing.
    openPullRequestsIn: (repos) => call(`open pull requests of ${repos.length} repositories`, async (l) => {
      const out: OpenPullRequestsIn = { repos: new Map(), repoErrors: new Map() };
      for (const [token, some] of await byInstallation(l, repos, out.repoErrors)) {
        const got = await openPullRequestsIn(req, token, some);
        for (const [repo, prs] of got.repos) out.repos.set(repo, prs);
        for (const [repo, error] of got.repoErrors) out.repoErrors.set(repo, error);
      }
      return out;
    }),
    pullRequestStates: (refs) => call(`${refs.length} pull requests`, async (l) => {
      const out: PullRequestStates = { pulls: new Map(), errors: new Map() };
      const failed = new Map<string, string>();
      for (const [token, some] of await byInstallation(l, refs.map((r) => r.repo), failed)) {
        const got = await pullRequestStates(req, token, refs.filter((r) => some.includes(r.repo)));
        for (const [k, v] of got.pulls) out.pulls.set(k, v);
        for (const [k, v] of got.errors) out.errors.set(k, v);
      }
      for (const r of refs) { const why = failed.get(r.repo); if (why !== undefined) out.errors.set(pullKey(r.repo, r.pullRequest), why); }
      return out;
    }),
    getIssue: (repo, number) => call(`get ${repo}#${number}`, async (l) => rest.getIssue(req, await tokenFor(l, repo), repo, number)),
    subIssues: (repo, number) => call(`sub-issues of ${repo}#${number}`, async (l) => rest.subIssues(req, await tokenFor(l, repo), repo, number)),
    listComments: (repo, number) => call(`comments ${repo}#${number}`, async (l) => rest.listComments(req, await tokenFor(l, repo), repo, number)),
    issueEdits: (repo, number) => call(`edits of ${repo}#${number}`, async (l) => issueEdits(ask, await tokenFor(l, repo), repo, number)),
    issuePlace: (repo, number) => call(`place of ${repo}#${number}`, async (l) => issuePlace(ask, await tokenFor(l, repo), repo, number)),
    ensureLabel: (repo, name, color, description) => call(`label ${repo} ${name}`, async (l) =>
      rest.ensureLabel(req, await tokenFor(l, repo), repo, name, color, description)),
    addLabels: (repo, number, labels) => call(`add labels ${repo}#${number}`, async (l) => rest.addLabels(req, await tokenFor(l, repo), repo, number, labels)),
    removeLabels: (repo, number, labels) => call(`remove labels ${repo}#${number}`, async (l) =>
      rest.removeLabels(req, await tokenFor(l, repo), repo, number, labels)),
    issueEvents: (repo, number) => call(`events of ${repo}#${number}`, async (l) => rest.issueEvents(req, await tokenFor(l, repo), repo, number)),
    assignedAt: (repo, number, login) => call(`events of ${repo}#${number}`, async (l) => rest.assignedAt(req, await tokenFor(l, repo), repo, number, login)),
    addAssignees: (repo, number, logins) => call(`assign ${repo}#${number}`, async (l) => rest.addAssignees(req, await tokenFor(l, repo), repo, number, logins)),
    reopenIssue: (repo, number) => call(`reopen ${repo}#${number}`, async (l) => rest.reopenIssue(req, await tokenFor(l, repo), repo, number)),
    closeAsCompleted: (repo, number) => call(`close ${repo}#${number}`, async (l) => rest.closeIssue(req, await tokenFor(l, repo), repo, number)),
    postComment: (repo, number, body) => call(`comment on ${repo}#${number}`, async (l) => rest.postComment(req, await tokenFor(l, repo), repo, number, body)),
    closingPullRequest: (repo, number) => call(`closer of ${repo}#${number}`, async (l) =>
      closingPullRequest(ask, await tokenFor(l, repo), repo, number)),
    openClosingPullRequests: (repo, number) => call(`pull requests of ${repo}#${number}`, async (l) =>
      openClosingPullRequests(ask, await tokenFor(l, repo), repo, number)),
    referencingPullRequests: (repo, number) => call(`pull requests mentioning ${repo}#${number}`, async (l) =>
      referencingPullRequests(ask, await tokenFor(l, repo), repo, number)),
    crossReferences: (repo, number) => call(`cross-references of ${repo}#${number}`, async (l) =>
      crossReferences(ask, await tokenFor(l, repo), repo, number)),
    pullRequest: (repo, number) => call(`pull request ${repo}#${number}`, async (l) =>
      pullRequest(ask, await tokenFor(l, repo), repo, number)),
    openPullRequests: (repo) => call(`open pull requests of ${repo}`, async (l) => openPullRequests(req, await tokenFor(l, repo), repo)),
    merge: (repo, number) => call(`merge ${repo}#${number}`, async (l) => rest.mergePullRequest(req, await tokenFor(l, repo), repo, number)),
    closeWithoutMerge: (repo, number) => call(`close ${repo}#${number}`, async (l) => rest.closePullRequest(req, await tokenFor(l, repo), repo, number)),
    toDraft: (repo, number) => call(`draft ${repo}#${number}`, async (l) => rest.convertToDraft(req, await tokenFor(l, repo), repo, number)),
    jobLog: (repo, jobId) => call(`log of Actions job ${jobId} of ${repo}`, async (l) => rest.jobLog(req, await tokenFor(l, repo), repo, jobId)),
    gitRemote: (repo) => call(`git of ${repo}`, async (l) => ({ url: `${webOriginOf(o.baseUrl ?? 'https://api.github.com')}/${repo}.git`, token: await tokenFor(l, repo) })),
    projectItems: (owner, number) => call(`project ${owner}/projects/${number}`, async (l) => {
      if (!l.accounts) await listInstallations(l);
      const id = l.accounts!.get(owner) ?? l.accounts!.values().next().value;
      if (id === undefined) throw new GitHubApiError(`project ${owner}/projects/${number}: the app has no installations`, true);
      return projectItems(intake, await l.auth.installationToken(id), owner, number);
    }),
  };
}
