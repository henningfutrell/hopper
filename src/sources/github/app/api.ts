// The GitHub App adapter of the GitHubApi port: writes appear as the app bot, and the app's
// installations are the repo allowlist. Lazy: the app file is read on first use and re-read when
// its mtime changes, so creating (or --force recreating) the app needs no daemon restart.

import { statSync } from 'node:fs';
import type { Clock } from '../../../domain/ports.ts';
import { GitHubApiError } from '../api.ts';
import type { GitHubApi } from '../api.ts';
import { createAuth } from './auth.ts';
import type { AppAuth } from './auth.ts';
import { expandHome, loadGitHubAppFile } from './config.ts';
import type { GitHubApp } from './config.ts';
import { projectItems } from './graphql.ts';
import { makeRequest, paginate, splitRepo, statusOf, toApiError } from './http.ts';
import * as rest from './rest.ts';

export type AppStatus = { ok: true; slug: string; botLogin: string; htmlUrl: string } | { ok: false; reason: string };
export type GitHubAppApi = GitHubApi & { appStatus(): AppStatus };

interface Loaded {
  mtimeMs: number;
  app: GitHubApp;
  auth: AppAuth;
  /** owner/repo → installation id, from listInstalledRepos or a cold lookup. */
  installs: Map<string, number>;
  /** installation account login → installation id, from GET /app/installations. */
  accounts?: Map<string, number>;
}

interface Installation { id: number; account?: { login?: string } | null }
interface InstalledRepo { full_name: string }

export function createGitHubAppApi(o: { appFile: string; baseUrl?: string; clock: Clock }): GitHubAppApi {
  const file = expandHome(o.appFile);
  const req = makeRequest(o.baseUrl ?? 'https://api.github.com');
  let loaded: Loaded | undefined;
  let failed: { mtimeMs: number; reason: string } | undefined;
  let authError: string | undefined;

  const current = (): Loaded | { reason: string } => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      loaded = undefined;
      return { reason: 'missing' };
    }
    if (loaded?.mtimeMs === mtimeMs) return loaded;
    if (!loaded && failed?.mtimeMs === mtimeMs) return { reason: failed.reason };
    const r = loadGitHubAppFile(file);
    authError = undefined;
    if (!r.ok) {
      loaded = undefined;
      failed = { mtimeMs, reason: r.reason };
      return { reason: r.reason };
    }
    for (const w of r.warnings) console.warn(`job-hopper: github app: ${w}`);
    failed = undefined;
    loaded = { mtimeMs, app: r.app, auth: createAuth(r.app, req), installs: new Map() };
    return loaded;
  };

  const need = (): Loaded => {
    const c = current();
    if ('reason' in c) {
      const why = c.reason === 'missing' ? `${file} is missing (run create-github-app.sh)` : c.reason;
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
      const e = toApiError(err, what, file);
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
      if (statusOf(err) === 404) throw new GitHubApiError(`app not installed on ${repo}`, true, 404);
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
    async whoami() {
      return need().app.botLogin;
    },
    async searchOpenIssues() {
      throw new GitHubApiError('searchOpenIssues: not used in app mode (the installations are the allowlist)', true);
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
    mintRepoToken: (repo) => call(`mint token for ${repo}`, async (l) =>
      l.auth.mint(await installationFor(l, repo), splitRepo(repo).repo)),
    listOpenIssues: (repo, label) => call(`list issues ${repo}`, async (l) => rest.listOpenIssues(req, await tokenFor(l, repo), repo, label)),
    getIssue: (repo, number) => call(`get ${repo}#${number}`, async (l) => rest.getIssue(req, await tokenFor(l, repo), repo, number)),
    listComments: (repo, number) => call(`comments ${repo}#${number}`, async (l) => rest.listComments(req, await tokenFor(l, repo), repo, number)),
    comment: (repo, number, body) => call(`comment ${repo}#${number}`, async (l) => rest.comment(req, await tokenFor(l, repo), repo, number, body)),
    editComment: (repo, id, body) => call(`edit comment ${repo} ${id}`, async (l) => rest.editComment(req, await tokenFor(l, repo), repo, id, body)),
    ensureLabel: (repo, name, color, description) => call(`label ${repo} ${name}`, async (l) =>
      rest.ensureLabel(req, await tokenFor(l, repo), repo, name, color, description)),
    addLabels: (repo, number, labels) => call(`add labels ${repo}#${number}`, async (l) => rest.addLabels(req, await tokenFor(l, repo), repo, number, labels)),
    removeLabels: (repo, number, labels) => call(`remove labels ${repo}#${number}`, async (l) =>
      rest.removeLabels(req, await tokenFor(l, repo), repo, number, labels)),
    projectItems: (owner, number) => call(`project ${owner}/projects/${number}`, async (l) => {
      if (!l.accounts) await listInstallations(l);
      const id = l.accounts!.get(owner) ?? l.accounts!.values().next().value;
      if (id === undefined) throw new GitHubApiError(`project ${owner}/projects/${number}: the app has no installations`, true);
      return projectItems(req, await l.auth.installationToken(id), owner, number);
    }),
  };
}
