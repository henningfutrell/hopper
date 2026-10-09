// The GitHub App adapter of the GitHubApi port: writes appear as the app bot, and the app's
// installations are the repo allowlist. Lazy: the app's identity is asked for on first use and
// again whenever it changes (a new key), so the credentials are never read twice for nothing.

import type { Clock } from '../../../domain/ports.ts';
import { GitHubApiError } from '../api.ts';
import type { GitHubApi } from '../api.ts';
import { createAuth } from './auth.ts';
import type { AppAuth } from './auth.ts';
import type { GitHubApp, GitHubAppLoad } from './config.ts';
import { closingPullRequest, openClosingPullRequests, projectItems, referencingPullRequests } from './graphql.ts';
import { makeRequest, paginate, splitRepo, statusOf, toApiError } from './http.ts';
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
  /** installation account login → installation id, from GET /app/installations. */
  accounts?: Map<string, number>;
}

interface Installation { id: number; account?: { login?: string } | null }
interface InstalledRepo { full_name: string }

/** `app`: the identity now (github-app options + the key's variable); `keyEnv` names that variable in messages. */
export function createGitHubAppApi(o: { app(): GitHubAppLoad; keyEnv: string; baseUrl?: string; clock: Clock }): GitHubAppApi {
  const req = makeRequest(o.baseUrl ?? 'https://api.github.com');
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
    loaded = { key, app: r.app, auth: createAuth(r.app, req), installs: new Map() };
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

  /** The installation covering `repo`; a cold cache asks GitHub (design B6). */
  const installationFor = async (l: Loaded, repo: string): Promise<number> => {
    const hit = l.installs.get(repo);
    if (hit !== undefined) return hit;
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
  };

  const tokenFor = async (l: Loaded, repo: string) => l.auth.installationToken(await installationFor(l, repo));

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
        const repos = await paginate(req, 'GET /installation/repositories', { per_page: 100 }, `token ${token}`,
          (d) => (d as { repositories?: InstalledRepo[] }).repositories ?? []);
        for (const r of repos) {
          l.installs.set(r.full_name, inst.id);
          out.push({ repo: r.full_name, installationId: inst.id });
        }
      }
      return out;
    }),
    listOpenIssues: (repo, label) => call(`list issues ${repo}`, async (l) => rest.listOpenIssues(req, await tokenFor(l, repo), repo, label)),
    getIssue: (repo, number) => call(`get ${repo}#${number}`, async (l) => rest.getIssue(req, await tokenFor(l, repo), repo, number)),
    listComments: (repo, number) => call(`comments ${repo}#${number}`, async (l) => rest.listComments(req, await tokenFor(l, repo), repo, number)),
    ensureLabel: (repo, name, color, description) => call(`label ${repo} ${name}`, async (l) =>
      rest.ensureLabel(req, await tokenFor(l, repo), repo, name, color, description)),
    addLabels: (repo, number, labels) => call(`add labels ${repo}#${number}`, async (l) => rest.addLabels(req, await tokenFor(l, repo), repo, number, labels)),
    removeLabels: (repo, number, labels) => call(`remove labels ${repo}#${number}`, async (l) =>
      rest.removeLabels(req, await tokenFor(l, repo), repo, number, labels)),
    assignedAt: (repo, number, login) => call(`events of ${repo}#${number}`, async (l) => rest.assignedAt(req, await tokenFor(l, repo), repo, number, login)),
    addAssignees: (repo, number, logins) => call(`assign ${repo}#${number}`, async (l) => rest.addAssignees(req, await tokenFor(l, repo), repo, number, logins)),
    reopenIssue: (repo, number) => call(`reopen ${repo}#${number}`, async (l) => rest.reopenIssue(req, await tokenFor(l, repo), repo, number)),
    postComment: (repo, number, body) => call(`comment on ${repo}#${number}`, async (l) => rest.postComment(req, await tokenFor(l, repo), repo, number, body)),
    closingPullRequest: (repo, number) => call(`closer of ${repo}#${number}`, async (l) =>
      closingPullRequest(req, await tokenFor(l, repo), repo, number)),
    openClosingPullRequests: (repo, number) => call(`pull requests of ${repo}#${number}`, async (l) =>
      openClosingPullRequests(req, await tokenFor(l, repo), repo, number)),
    referencingPullRequests: (repo, number) => call(`pull requests mentioning ${repo}#${number}`, async (l) =>
      referencingPullRequests(req, await tokenFor(l, repo), repo, number)),
    projectItems: (owner, number) => call(`project ${owner}/projects/${number}`, async (l) => {
      if (!l.accounts) await listInstallations(l);
      const id = l.accounts!.get(owner) ?? l.accounts!.values().next().value;
      if (id === undefined) throw new GitHubApiError(`project ${owner}/projects/${number}: the app has no installations`, true);
      return projectItems(req, await l.auth.installationToken(id), owner, number);
    }),
  };
}
