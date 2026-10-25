// A fake GitHub for sign-in and connected-account tests (issue #214): the hopper's GitHub App's device
// flow (the client id only, never a secret), who a token belongs to, where the app is installed, and the
// issue API a connected account reads through.
// node:http on 127.0.0.1; every request is recorded. The user at the device page is the test:
// `approve(login)` or `deny()` settles the pending device code. The browser redirect (issue #258) is
// GitHub's web flow, which takes the app's client secret: GitHub signs `webLogin` in at
// `/login/oauth/authorize` and sends the browser back with a code, exchanged with the secret and the PKCE verifier.
// With `tokenLifetimeS`, GitHub grants as an app with token expiration on does (issue #358): every access
// token comes with `expires_in` and a refresh token, which the refresh grant trades for a new pair once
// (with the client secret for a web flow grant; without it for a device flow grant, as GitHub allows),
// and then refuses the access token that refresh token came with, as GitHub does (issue #441).
// `refreshDown` makes the refresh grant answer that status instead (a 5xx, a rate limit).
// Each device or web flow grant is one token of the user at the app, renewed within itself by the refresh
// grant. With `tokenLimit`, GitHub keeps at most that many per user (ten, issue #514): one more revokes the
// one never used, else the least recently used. `POST /api/v3/credentials/revoke` (no authentication, as
// GitHub's) revokes the access and refresh tokens it is given; `revokeDown` makes it answer that status.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { commentEditRoute, editIssue, pullEditRoute, forksRoute, type ForksForge } from './fake-forks.ts';
import { serveGit } from './fake-git.ts';
import { readBody, send } from './fake-http.ts';
import { jobLogBlobRoute, tagged, jobLogsRoute, runsRoute, repoChecksRoute, type JobLogsForge, type RepoChecksForge } from './fake-repo-checks.ts';
import { issueIdOf, subIssuesRoute, type SubIssuesForge } from './fake-sub-issues.ts';
import { watchRoute, type WatchForge } from './fake-github-watch.ts';
import { contentsRoute, headsRoute, type ContentsForge, type HeadsForge } from './fake-heads.ts'; import { skillTreeRoute } from './fake-skill-tree.ts';
import { peopleRoute, type PeopleForge } from './fake-people.ts'; import { GRANTED, orgAppsRoute, type OrgAppsForge } from './fake-org-apps.ts';
import { listingRoute, updatedAtOf } from './fake-listing.ts'; import { pullListRoute, pullReadsRoute, type PullReadsForge } from './fake-pull-reads.ts';

export interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  /** Default: the author (issue #387: intake is by label and assignee). */
  assignees?: string[];
  state?: 'open' | 'closed';
  /** Why it was closed (issue #652: a job closes its own issue as completed), and when (issue #1147). */
  stateReason?: string; closedAt?: string;
  /** The comments posted on it, as GitHub's REST answers them (issue #673). */
  comments?: Record<string, unknown>[];
  /** Its sub-issues, each `owner/name#N` (issue #729). */
  subIssues?: string[];
}

/** A pull request opened on the fake (issue #563); `draft` is marked ready through GraphQL (issue #652). */
export interface FakePull { repo: string; number: number; title: string; body: string; head: string; base: string; draft?: boolean; state?: 'open' | 'closed' }

/** `notModified`: answered 304, as it named the ETag of an answer that still holds (issue #1250). */
export interface ForgeRequest { method: string; path: string; query: Record<string, string>; body: Record<string, unknown>; auth: string; notModified?: boolean }

interface Device { code: string; userCode: string; state: 'pending' | 'approved' | 'denied'; login?: string }

export interface FakeForge extends PullReadsForge, ContentsForge, RepoChecksForge, SubIssuesForge, ForksForge, WatchForge, HeadsForge, PeopleForge, OrgAppsForge, JobLogsForge {
  url: string;
  requests: ForgeRequest[];
  issues: FakeIssue[];
  /** Approve the newest pending device code as `login`. */
  approve(login: string): void;
  deny(): void;
  /** Tokens the forge accepts now, by token → login. Delete one to have GitHub refuse it (401). */
  tokens: Map<string, string>;
  /** Refresh tokens the forge accepts now (with `tokenLifetimeS`), by refresh token → whose, and whether the web flow granted it. Delete one to revoke it. */
  refreshTokens: Map<string, { login: string; web: boolean }>;
  /** GitHub: who is signed in at GitHub when a browser reaches `/login/oauth/authorize`; unset: nobody, the person denies it. */
  webLogin?: string;
  /** GitHub: the accounts the app is installed on (GET /user/installations); default: the token's own login. */
  installedOn?: string[];
  /** GitHub: an install that reaches only chosen repositories, by account → its repos (owner/name); an account not named here reaches all of its repos (those its issues are in). */
  chosenRepos?: Record<string, string[]>;
  /** GitHub: where the app is installed cannot be read (GET /user/installations answers 503). */
  installationsDown?: boolean; /** GitHub: drops these assignees from a new issue with no error (issue #1856); `unassignable` drops them from a later assign too. */ dropsAssignees?: string[]; unassignable?: string[];
  /** GitHub: a new issue or comment answers this status and is not made (issue #694: no access to the repository, GitHub down). */
  issuesRefused?: number; /** GitHub: a new issue or comment is made, then its answer is lost: this status (issue #1591: a stop or a timeout). */ answerLost?: number;
  /** GitHub: the refresh grant answers this status, refusing nothing (issue #441: a 5xx, a rate limit). */
  refreshDown?: number;
  /** The credentials revoke requests named (issue #514), in order. */
  revoked: string[][];
  /** Called as a revoke request arrives, before GitHub answers it. */
  onRevoke?: (credentials: string[]) => void;
  /** GitHub: the revoke endpoint and the grant deletion (`DELETE /applications/{client_id}/grant`, issue #463) answer this status, revoking nothing. */
  revokeDown?: number;
  /**
   * GitHub's git over HTTP (issue #652), when made with `gitRoot`: the bare repositories `<gitRoot>/<owner>/<name>.git`,
   * served by git's own `git-http-backend`. A read without credentials is answered as for a public repository (a private
   * one, with a file `hopper-private` in it, needs a token, as a push does), the token as the password of Basic auth.
   * Each request is recorded with its auth.
   */
  gitRequests: ForgeRequest[];
  /** Mint a pair as the device flow grants it (issue #441), for tests that start with an account already connected. */
  mint(login: string, web?: boolean): { accessToken: string; refreshToken: string };
  close(): Promise<void>;
}

type Handler = (r: ForgeRequest, login: string | undefined) => { status: number; body?: unknown; location?: string; text?: string; etag?: string };

async function serve(handler: (base: string) => Handler, extra: { issues: FakeIssue[]; tokens: Map<string, string>; refreshTokens: Map<string, { login: string; web: boolean }>; devices: Device[]; mint: FakeForge['mint']; revoked: string[][]; gitRoot?: string }): Promise<FakeForge> {
  const requests: ForgeRequest[] = [];
  const gitRequests: ForgeRequest[] = [];
  let base = '';
  let handle: Handler = () => ({ status: 500 });
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', base);
      const auth = req.headers.authorization ?? '';
      if (extra.gitRoot && serveGit(extra.gitRoot, extra.tokens, req, res, u, (r) => gitRequests.push(r))) return;
      const r: ForgeRequest = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body: await readBody(req), auth };
      requests.push(r);
      const token = /^(?:token|bearer)\s+(\S+)$/i.exec(auth)?.[1];
      const out = handle(r, token ? extra.tokens.get(token) : undefined);
      if (out.location || out.text !== undefined) { res.writeHead(out.status, out.location ? { location: out.location } : { 'content-type': 'text/plain; charset=utf-8' }); res.end(out.text); return; }
      // A conditional request whose ETag still holds: 304, no body, as GitHub answers it (and does not charge it).
      const same = out.etag !== undefined && req.headers['if-none-match'] === out.etag; if (same) r.notModified = true; send(res, same ? 304 : out.status, same ? undefined : out.body, out.etag);
    })().catch((err: unknown) => send(res, 500, { message: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handle = handler(base);
  const pending = () => extra.devices.filter((d) => d.state === 'pending').at(-1);
  return {
    url: base, requests, gitRequests, issues: extra.issues, tokens: extra.tokens, refreshTokens: extra.refreshTokens, mint: extra.mint, revoked: extra.revoked,
    approve(login) { const d = pending(); if (!d) throw new Error('no pending device code'); d.state = 'approved'; d.login = login; },
    deny() { const d = pending(); if (!d) throw new Error('no pending device code'); d.state = 'denied'; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** One page of a GitHub list (`per_page`, `page`). */
const pageOf = <T>(all: T[], q: Record<string, string>): T[] => {
  const per = Number(q.per_page ?? 30);
  const page = Number(q.page ?? 1);
  return all.slice((page - 1) * per, page * per);
};

const issueKey = (repo: string, n: number) => `${repo}#${n}`;
/** A stable numeric id per login, as GitHub gives one. */
const idOf = (login: string) => [...login].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1_000_000, 7);

/** GitHub: OAuth at the root (`/login/device/code`, `/login/oauth/access_token`), REST under `/api/v3`. */
export function createFakeGitHub(o: { clientId: string; clientSecret?: string; issues?: FakeIssue[]; pulls?: FakePull[]; tokenLifetimeS?: number; tokenLimit?: number; gitRoot?: string; deviceInterval?: number }): Promise<FakeForge> {
  const issues = o.issues ?? [];
  const pulls = o.pulls ?? [];
  const tokens = new Map<string, string>();
  const refreshTokens = new Map<string, { login: string; web: boolean }>();
  /** The access token each refresh token came with: GitHub refuses it once the refresh token is used. */
  const accessOf = new Map<string, string>();
  const devices: Device[] = [];
  /** Web flow codes GitHub handed back to the browser: code → who, and what it was asked with. */
  const codes = new Map<string, { login: string; redirectUri: string; challenge: string }>();
  const revoked: string[][] = [];
  /** GitHub's tokens of the app per user (issue #514): each grant's current pair, and when it was last used (0: never). */
  const grants: { login: string; access: string; refresh?: string; used: number }[] = [];
  let tick = 0;
  const drop = (g: (typeof grants)[number]) => {
    tokens.delete(g.access);
    if (g.refresh) refreshTokens.delete(g.refresh);
    grants.splice(grants.indexOf(g), 1);
  };
  let n = 0;
  let forge: FakeForge | undefined;
  /** A new access token for `login`, with its refresh token when tokens expire; `renewing`: the grant its refresh token renews. */
  const grant = (login: string, web: boolean, scope: string, renewing?: (typeof grants)[number]) => {
    const token = `gho_${login}_${++n}`;
    tokens.set(token, login);
    const refresh = o.tokenLifetimeS === undefined ? undefined : `ghr_${login}_${n}`;
    if (renewing) Object.assign(renewing, { access: token, refresh, used: ++tick });
    else {
      const mine = grants.filter((g) => g.login === login);
      if (o.tokenLimit !== undefined && mine.length >= o.tokenLimit) drop(mine.reduce((a, b) => (b.used < a.used ? b : a)));
      grants.push({ login, access: token, ...(refresh ? { refresh } : {}), used: 0 });
    }
    if (!refresh) return { access_token: token, token_type: 'bearer', scope };
    refreshTokens.set(refresh, { login, web });
    accessOf.set(refresh, token);
    return { access_token: token, token_type: 'bearer', scope, expires_in: o.tokenLifetimeS, refresh_token: refresh, refresh_token_expires_in: 15_897_600 };
  };
  return serve((base) => {
    const restIssue = (i: FakeIssue) => ({
      number: i.number, title: i.title, body: i.body, state: i.state ?? 'open', html_url: `${base}/${i.repo}/issues/${i.number}`,
      updated_at: updatedAtOf(i), user: { login: i.author }, assignees: (i.assignees ?? [i.author]).map((login) => ({ login })), labels: i.labels.map((name) => ({ name })),
      repository_url: `${base}/api/v3/repos/${i.repo}`, id: issueIdOf(i.repo, i.number), ...(i.state === 'closed' ? { state_reason: i.stateReason ?? 'completed', closed_at: i.closedAt ?? null } : {}),
    });
    const find = (repo: string, num: number) => issues.find((i) => issueKey(i.repo, i.number) === issueKey(repo, num));
    const restPull = (p: FakePull) => ({
      number: p.number, node_id: `PR_${p.repo}_${p.number}`, title: p.title, body: p.body, state: p.state ?? 'open', draft: p.draft === true, merged: false, html_url: `${base}/${p.repo}/pull/${p.number}`,
      head: { ref: p.head, sha: `sha-${p.number}` }, base: { ref: p.base },
    });
    return (r, login) => {
      if (r.method === 'POST' && r.path === '/login/device/code') {
        if (r.body.client_id !== o.clientId || 'client_secret' in r.body) return { status: 401, body: { error: 'incorrect_client_credentials' } };
        const d: Device = { code: `dc-${++n}`, userCode: `GH${n}-CODE`, state: 'pending' };
        devices.push(d);
        // The poll interval, in seconds: short unless `deviceInterval`, so a test sign-in does not wait a second per poll (issue #949).
        return { status: 200, body: { device_code: d.code, user_code: d.userCode, verification_uri: `${base}/login/device`, expires_in: 900, interval: o.deviceInterval ?? 0.05 } };
      }
      if (r.method === 'GET' && r.path === '/login/oauth/authorize') {
        const q = r.query;
        if (q.client_id !== o.clientId || !q.redirect_uri || !q.state) return { status: 400, body: { message: 'bad authorize request' } };
        const back = new URL(q.redirect_uri);
        back.searchParams.set('state', q.state);
        const who = forge?.webLogin;
        if (!who) { back.searchParams.set('error', 'access_denied'); return { status: 302, location: back.href }; }
        const code = `wc-${++n}`;
        codes.set(code, { login: who, redirectUri: q.redirect_uri, challenge: q.code_challenge ?? '' });
        back.searchParams.set('code', code);
        return { status: 302, location: back.href };
      }
      if (r.method === 'POST' && r.path === '/login/oauth/access_token' && 'code' in r.body) {
        const c = codes.get(String(r.body.code));
        codes.delete(String(r.body.code));
        if (r.body.client_id !== o.clientId || !o.clientSecret || r.body.client_secret !== o.clientSecret) return { status: 200, body: { error: 'incorrect_client_credentials' } };
        if (!c || r.body.redirect_uri !== c.redirectUri) return { status: 200, body: { error: 'bad_verification_code' } };
        const verifier = String(r.body.code_verifier ?? '');
        if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return { status: 200, body: { error: 'bad_verification_code' } };
        return { status: 200, body: grant(c.login, true, '') };
      }
      if (r.method === 'POST' && r.path === '/login/oauth/access_token' && r.body.grant_type === 'refresh_token') {
        if (forge?.refreshDown) return { status: forge.refreshDown, body: { message: 'Service Unavailable' } };
        const g = refreshTokens.get(String(r.body.refresh_token));
        if (r.body.client_id !== o.clientId) return { status: 200, body: { error: 'incorrect_client_credentials' } };
        if (g?.web && (!o.clientSecret || r.body.client_secret !== o.clientSecret)) return { status: 200, body: { error: 'incorrect_client_credentials' } };
        if (!g) return { status: 200, body: { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } };
        refreshTokens.delete(String(r.body.refresh_token)); // a refresh token is used once,
        tokens.delete(accessOf.get(String(r.body.refresh_token)) ?? ''); // and the access token it came with goes with it
        return { status: 200, body: grant(g.login, g.web, '', grants.find((x) => x.refresh === String(r.body.refresh_token))) };
      }
      if (r.method === 'POST' && r.path === '/login/oauth/access_token') {
        if (r.body.client_id !== o.clientId || 'client_secret' in r.body) return { status: 200, body: { error: 'incorrect_client_credentials' } };
        const d = devices.find((x) => x.code === r.body.device_code);
        if (!d) return { status: 200, body: { error: 'expired_token', error_description: 'The device code has expired.' } };
        if (d.state === 'pending') return { status: 200, body: { error: 'authorization_pending', error_description: 'The authorization request is still pending.' } };
        if (d.state === 'denied') return { status: 200, body: { error: 'access_denied', error_description: 'The authorization request was denied.' } };
        d.state = 'denied'; // a device code is used once
        return { status: 200, body: grant(d.login!, false, 'repo,read:project') };
      }
      if (r.method === 'POST' && r.path === '/api/v3/credentials/revoke') {
        if (r.auth) return { status: 403, body: { message: 'Must not be authenticated' } };
        const credentials = (r.body.credentials as string[] | undefined) ?? [];
        forge?.onRevoke?.(credentials);
        if (forge?.revokeDown) return { status: forge.revokeDown, body: { message: 'Server Error' } };
        revoked.push(credentials);
        for (const g of grants.filter((x) => credentials.includes(x.access) || (x.refresh !== undefined && credentials.includes(x.refresh)))) drop(g);
        for (const c of credentials) { tokens.delete(c); refreshTokens.delete(c); }
        return { status: 202, body: {} };
      }
      if (r.method === 'DELETE' && r.path === `/api/v3/applications/${o.clientId}/grant`) { if (forge?.revokeDown) return { status: forge.revokeDown, body: { message: 'Server Error' } }; if (!o.clientSecret || r.auth !== `basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`) return { status: 404, body: { message: 'Not Found' } }; const who = tokens.get(String(r.body.access_token)); if (!who) return { status: 404, body: { message: 'Not Found' } }; for (const g of grants.filter((x) => x.login === who)) drop(g); return { status: 204 }; } // the grant and every token of it (issue #463)
      if (!r.path.startsWith('/api/v3/')) return jobLogBlobRoute(forge, r.method, r.path) ?? { status: 404, body: { message: 'Not Found' } };
      if (!login) return { status: 401, body: { message: 'Bad credentials' } };
      const usedNow = grants.find((g) => r.auth.endsWith(` ${g.access}`)); if (usedNow) usedNow.used = ++tick;
      const path = r.path.slice('/api/v3'.length);
      // A repository listing (issue #985: first, it asks check rollups too); a repository's checks (issue #677); the accounts GitHub knows (issue #930).
      const checks = listingRoute(base, issues, r.method, path, r.body) ?? repoChecksRoute(forge?.repoChecks, r.method, path, r.body) ?? peopleRoute(forge, base, issues, r.method, path, r.query) ?? orgAppsRoute(forge, base, r.method, path, r.query);
      if (checks) return checks;
      if (r.method === 'GET' && path === '/user') return { status: 200, body: { id: idOf(login), login, name: `${login} name`, avatar_url: `${base}/avatars/${login}` } };
      if (r.method === 'GET' && path === '/user/emails') return { status: 200, body: [{ email: `${login}@example.com`, primary: true, verified: true }] }; if (r.method === 'GET' && path === '/user/repos') return tagged(pageOf([...new Set(issues.map((i) => i.repo))].map((full_name) => ({ full_name, owner: { login: full_name.split('/')[0], avatar_url: `${base}/avatars/${full_name.split('/')[0]}` } })), r.query)); // the repositories a personal access token reaches (issue #1380): every repository the issues are in
      if (r.method === 'GET' && path === '/user/installations') {
        if (forge?.installationsDown) return { status: 503, body: { message: 'Service Unavailable' } };
        const on = forge?.installedOn ?? [login];
        const page = pageOf(on.map((a, i) => ({
          id: i + 1, account: { login: a, avatar_url: `${base}/avatars/${a}` }, html_url: `${base}/settings/installations/${i + 1}`,
          repository_selection: forge?.chosenRepos?.[a] ? 'selected' : 'all',
          // What the installation grants, as GitHub answers it: the shipped app's permissions, unless the test says otherwise.
          permissions: forge?.installationPermissions?.[a] ?? GRANTED,
        })), r.query);
        return tagged({ total_count: on.length, installations: page }); // with an ETag (issue #1250)
      }
      const ir = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      if (r.method === 'GET' && ir) {
        const account = (forge?.installedOn ?? [login])[Number(ir[1]) - 1];
        if (!account) return { status: 404, body: { message: 'Not Found' } };
        const repos = forge?.chosenRepos?.[account] ?? [...new Set(issues.map((i) => i.repo).filter((repo) => repo.split('/')[0] === account))];
        return tagged({ total_count: repos.length, repositories: pageOf(repos.map((full_name) => ({ full_name })), r.query) });
      }
      if (r.method === 'GET' && path === '/search/issues') {
        const q = r.query.q ?? '';
        const label = /label:"?([^"\s]+)"?/.exec(q)?.[1];
        const users = [...q.matchAll(/user:(\S+)/g)].map((m) => m[1]);
        const authors = [...q.matchAll(/author:(\S+)/g)].map((m) => m[1]);
        const repos = [...q.matchAll(/repo:(\S+)/g)].map((m) => m[1]);
        // `in:title` or `in:body` with words joined by OR (issue #694: Report a bug's duplicate search, by title or by a
        // failure's signature): a title, or a body, with any of them.
        const where = q.includes('in:title') ? 'title' : q.includes('in:body') ? 'body' : undefined;
        const words = where ? q.replace(/\S+:\S+/g, ' ').replace(/[()"]/g, ' ').split(/\s+/).filter((w) => w && w !== 'OR').map((w) => w.toLowerCase()) : [];
        const found = issues.filter((i) => (i.state ?? 'open') === 'open' && (!label || i.labels.includes(label))
          && (users.length === 0 || users.includes(i.repo.split('/')[0])) && (authors.length === 0 || authors.includes(i.author))
          && (repos.length === 0 || repos.includes(i.repo)) && (words.length === 0 || words.some((w) => (where === 'body' ? i.body : i.title).toLowerCase().includes(w))));
        return { status: 200, body: { total_count: found.length, incomplete_results: false, items: found.map(restIssue) } };
      }
      if (r.method === 'POST' && path === '/graphql') {
        // An issue's edits (issue #662) and an item its text names (issue #655 part 19): none, and a private repository.
        if (/userContentEdits|issueOrPullRequest/.test(String(r.body.query))) return { status: 200, body: { data: { repository: { visibility: 'PRIVATE', issue: {}, issueOrPullRequest: null } } } }; const id = String((r.body.variables as Record<string, unknown> | undefined)?.id ?? '');
        const pull = pulls.find((p) => `PR_${p.repo}_${p.number}` === id);
        if (!String(r.body.query).includes('markPullRequestReadyForReview') || !pull) return { status: 200, body: { errors: [{ message: `Could not resolve to a node with the global id of '${id}'` }] } };
        pull.draft = false;
        return { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false, url: `${base}/${pull.repo}/pull/${pull.number}` } } } } };
      }
      const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(path);
      if (!m) return { status: 404, body: { message: 'Not Found' } };
      const repo = m[1]!;
      const rest = m[2] ?? '';
      const sub = pullReadsRoute(forge, r.method, repo, rest) ?? pullListRoute(pulls, restPull, r.method, repo, rest, r.query) ?? subIssuesRoute(forge, issues, restIssue, r.method, repo, rest, r.body) ?? watchRoute(forge, issues, restIssue, r.method, repo, rest) ?? headsRoute(forge, r.method, repo, rest) ?? commentEditRoute(issues, r.method, repo, rest, r.body) ?? pullEditRoute(pulls, restPull, r.method, repo, rest, r.body) ?? contentsRoute(forge ?? {}, base, r.method, repo, rest, r.query, r.body) ?? jobLogsRoute(forge, base, r.method, rest) ?? runsRoute(forge, base, r.method, repo, rest, r.query) ?? skillTreeRoute(forge ?? {}, r.method, repo, rest, r.query); if (sub) return sub;
      if (r.method === 'POST' && rest === 'labels') return { status: 201, body: { name: r.body.name } };
      // A repository's issues by label, or by `creator` (issue #1591: a post key looked for), `state=all` too; `since` is not read.
      if (r.method === 'GET' && rest === 'issues') { const { state = 'open', labels, creator } = r.query; return { status: 200, body: issues.filter((i) => i.repo === repo && (state === 'all' || (i.state ?? 'open') === state) && (labels ?? '').split(',').every((l) => i.labels.includes(l) || (!labels && !!creator)) && (creator === undefined || i.author === creator)).map(restIssue) }; }
      // Filing an issue and opening a pull request (the GitHub proxy, issue #563): GitHub numbers both in one sequence per repository.
      const nextNumber = () => Math.max(0, ...issues.filter((i) => i.repo === repo).map((i) => i.number), ...pulls.filter((p) => p.repo === repo).map((p) => p.number)) + 1;
      const repoAnswer = forksRoute(forge, o.gitRoot, base, login, r.method, repo, rest, r.body); if (repoAnswer) return repoAnswer;
      if (r.method === 'POST' && (rest === 'issues' || /^issues\/\d+\/comments$/.test(rest)) && forge?.issuesRefused) return { status: forge.issuesRefused, body: { message: 'Resource not accessible by integration' } };
      if (r.method === 'POST' && rest === 'issues') {
        const issue: FakeIssue = {
          repo, number: nextNumber(), title: String(r.body.title), body: String(r.body.body ?? ''), author: login,
          labels: (r.body.labels as string[] | undefined) ?? [], assignees: ((r.body.assignees as string[] | undefined) ?? []).filter((a) => !forge?.dropsAssignees?.includes(a)),
        };
        issues.push(issue); if (forge?.answerLost) return { status: forge.answerLost, body: { message: 'Bad Gateway' } };
        return { status: 201, body: restIssue(issue) };
      }
      if (r.method === 'POST' && rest === 'pulls') {
        if (r.body.head === r.body.base) return { status: 422, body: { message: 'Validation Failed', errors: [{ message: `No commits between ${String(r.body.base)} and ${String(r.body.head)}` }] } };
        const pull = { repo, number: nextNumber(), title: String(r.body.title), body: String(r.body.body ?? ''), head: String(r.body.head), base: String(r.body.base) };
        pulls.push(pull);
        return { status: 201, body: restPull(pull) };
      }
      const pm = /^pulls\/(\d+)$/.exec(rest);
      const pull = pm ? pulls.find((p) => p.repo === repo && p.number === Number(pm[1])) : undefined;
      if (r.method === 'GET' && pm) return pull ? { status: 200, body: restPull(pull) } : { status: 404, body: { message: 'Not Found' } };
      const im = /^issues\/(\d+)(?:\/(comments|labels|events|assignees)(?:\/(.+))?)?$/.exec(rest);
      const issue = im ? find(repo, Number(im[1])) : undefined;
      if (!im || !issue) return { status: 404, body: { message: 'Not Found' } };
      if (r.method === 'GET' && !im[2]) return { status: 200, body: restIssue(issue) };
      // Its labels and assignments, each by its author (issue #652: who added them is what intake trusts).
      if (r.method === 'GET' && im[2] === 'events') {
        const actor = { login: issue.author, type: 'User' };
        return { status: 200, body: [
          ...issue.labels.map((name) => ({ event: 'labeled', created_at: '2026-10-06T00:00:00Z', actor, label: { name } })),
          ...(issue.assignees ?? [issue.author]).map((login) => ({ event: 'assigned', created_at: '2026-10-06T00:00:00Z', actor, assignee: { login } })),
        ] };
      }
      if (r.method === 'PATCH' && !im[2]) {
        if (r.body.state === 'closed') Object.assign(issue, { state: 'closed', stateReason: String(r.body.state_reason ?? 'completed') }); else editIssue(issue, r.body);
        return { status: 200, body: restIssue(issue) };
      }
      if (r.method === 'POST' && im[2] === 'assignees') { for (const a of (r.body.assignees as string[] | undefined) ?? []) if (!forge?.unassignable?.includes(a) && !(issue.assignees ??= []).includes(a)) issue.assignees.push(a); return { status: 201, body: restIssue(issue) }; }
      if (r.method === 'GET' && im[2] === 'comments') return { status: 200, body: issue.comments ?? [] };
      if (r.method === 'POST' && im[2] === 'comments' && !im[3]) {
        const id = ++n;
        const comment = { id, body: r.body.body, user: { login }, created_at: '2026-10-09T00:00:00Z', html_url: `${base}/${repo}/issues/${issue.number}#issuecomment-${id}` };
        (issue.comments ??= []).push(comment); if (forge?.answerLost) return { status: forge.answerLost, body: { message: 'Bad Gateway' } };
        return { status: 201, body: comment };
      }
      if (r.method === 'POST' && im[2] === 'labels') {
        for (const l of (r.body.labels as string[] | undefined) ?? []) if (!issue.labels.includes(l)) issue.labels.push(l);
        return { status: 200, body: issue.labels.map((name) => ({ name })) };
      }
      if (r.method === 'DELETE' && im[2] === 'labels' && im[3]) {
        const name = decodeURIComponent(im[3]);
        if (!issue.labels.includes(name)) return { status: 404, body: { message: 'Label does not exist' } };
        issue.labels = issue.labels.filter((l) => l !== name);
        return { status: 200, body: [] };
      }
      return { status: 404, body: { message: 'Not Found' } };
    };
  }, {
    issues, tokens, refreshTokens, devices, revoked, ...(o.gitRoot ? { gitRoot: o.gitRoot } : {}),
    mint: (login, web = false) => { const g = grant(login, web, ''); return { accessToken: g.access_token, refreshToken: g.refresh_token! }; },
  }).then((f) => (forge = f));
}
