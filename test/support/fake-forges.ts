// A fake GitHub for sign-in and connected-account tests (issue #214): the hopper's GitHub App's device
// flow (the client id only, never a secret), who a token belongs to, where the app is installed, and the
// issue API a connected account reads through.
// node:http on 127.0.0.1; every request is recorded. The user at the device page is the test:
// `approve(login)` or `deny()` settles the pending device code. The browser redirect (issue #258) is
// GitHub's web flow, which takes the app's client secret: GitHub signs `webLogin` in at
// `/login/oauth/authorize` and sends the browser back with a code, exchanged with the secret and the PKCE verifier.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state?: 'open' | 'closed';
}

export interface ForgeRequest { method: string; path: string; query: Record<string, string>; body: Record<string, unknown>; auth: string }

interface Device { code: string; userCode: string; state: 'pending' | 'approved' | 'denied'; login?: string }

export interface FakeForge {
  url: string;
  requests: ForgeRequest[];
  issues: FakeIssue[];
  /** Approve the newest pending device code as `login`. */
  approve(login: string): void;
  deny(): void;
  /** Tokens the forge accepts now, by token → login. */
  tokens: Map<string, string>;
  /** GitHub: who is signed in at GitHub when a browser reaches `/login/oauth/authorize`; unset: nobody, the person denies it. */
  webLogin?: string;
  /** GitHub: the accounts the app is installed on (GET /user/installations); default: the token's own login. */
  installedOn?: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text }; }
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

type Handler = (r: ForgeRequest, login: string | undefined) => { status: number; body?: unknown; location?: string };

async function serve(handler: (base: string) => Handler, extra: { issues: FakeIssue[]; tokens: Map<string, string>; devices: Device[] }): Promise<FakeForge> {
  const requests: ForgeRequest[] = [];
  let base = '';
  let handle: Handler = () => ({ status: 500 });
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', base);
      const auth = req.headers.authorization ?? '';
      const r: ForgeRequest = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body: await readBody(req), auth };
      requests.push(r);
      const token = /^(?:token|bearer)\s+(\S+)$/i.exec(auth)?.[1];
      const out = handle(r, token ? extra.tokens.get(token) : undefined);
      if (out.location) { res.writeHead(out.status, { location: out.location }); res.end(); return; }
      send(res, out.status, out.body);
    })().catch((err: unknown) => send(res, 500, { message: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handle = handler(base);
  const pending = () => extra.devices.filter((d) => d.state === 'pending').at(-1);
  return {
    url: base, requests, issues: extra.issues, tokens: extra.tokens,
    approve(login) { const d = pending(); if (!d) throw new Error('no pending device code'); d.state = 'approved'; d.login = login; },
    deny() { const d = pending(); if (!d) throw new Error('no pending device code'); d.state = 'denied'; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const issueKey = (repo: string, n: number) => `${repo}#${n}`;
/** A stable numeric id per login, as GitHub gives one. */
const idOf = (login: string) => [...login].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1_000_000, 7);

/** GitHub: OAuth at the root (`/login/device/code`, `/login/oauth/access_token`), REST under `/api/v3`. */
export function createFakeGitHub(o: { clientId: string; clientSecret?: string; issues?: FakeIssue[] }): Promise<FakeForge> {
  const issues = o.issues ?? [];
  const tokens = new Map<string, string>();
  const devices: Device[] = [];
  /** Web flow codes GitHub handed back to the browser: code → who, and what it was asked with. */
  const codes = new Map<string, { login: string; redirectUri: string; challenge: string }>();
  let n = 0;
  let forge: FakeForge | undefined;
  return serve((base) => {
    const restIssue = (i: FakeIssue) => ({
      number: i.number, title: i.title, body: i.body, state: i.state ?? 'open', html_url: `${base}/${i.repo}/issues/${i.number}`,
      updated_at: '2026-10-06T00:00:00Z', user: { login: i.author }, labels: i.labels.map((name) => ({ name })),
      repository_url: `${base}/api/v3/repos/${i.repo}`,
    });
    const find = (repo: string, num: number) => issues.find((i) => issueKey(i.repo, i.number) === issueKey(repo, num));
    return (r, login) => {
      if (r.method === 'POST' && r.path === '/login/device/code') {
        if (r.body.client_id !== o.clientId || 'client_secret' in r.body) return { status: 401, body: { error: 'incorrect_client_credentials' } };
        const d: Device = { code: `dc-${++n}`, userCode: `GH${n}-CODE`, state: 'pending' };
        devices.push(d);
        return { status: 200, body: { device_code: d.code, user_code: d.userCode, verification_uri: `${base}/login/device`, expires_in: 900, interval: 1 } };
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
        const token = `gho_${c.login}_${++n}`;
        tokens.set(token, c.login);
        return { status: 200, body: { access_token: token, token_type: 'bearer', scope: '' } };
      }
      if (r.method === 'POST' && r.path === '/login/oauth/access_token') {
        if (r.body.client_id !== o.clientId || 'client_secret' in r.body) return { status: 200, body: { error: 'incorrect_client_credentials' } };
        const d = devices.find((x) => x.code === r.body.device_code);
        if (!d) return { status: 200, body: { error: 'expired_token', error_description: 'The device code has expired.' } };
        if (d.state === 'pending') return { status: 200, body: { error: 'authorization_pending', error_description: 'The authorization request is still pending.' } };
        if (d.state === 'denied') return { status: 200, body: { error: 'access_denied', error_description: 'The authorization request was denied.' } };
        const token = `gho_${d.login}_${++n}`;
        tokens.set(token, d.login!);
        d.state = 'denied'; // a device code is used once
        return { status: 200, body: { access_token: token, token_type: 'bearer', scope: 'repo,read:project' } };
      }
      if (!r.path.startsWith('/api/v3/')) return { status: 404, body: { message: 'Not Found' } };
      if (!login) return { status: 401, body: { message: 'Bad credentials' } };
      const path = r.path.slice('/api/v3'.length);
      if (r.method === 'GET' && path === '/user') return { status: 200, body: { id: idOf(login), login, name: `${login} name` } };
      if (r.method === 'GET' && path === '/user/emails') return { status: 200, body: [{ email: `${login}@example.com`, primary: true, verified: true }] };
      if (r.method === 'GET' && path === '/user/installations') {
        const on = forge?.installedOn ?? [login];
        return { status: 200, body: { total_count: on.length, installations: on.map((a, i) => ({ id: i + 1, account: { login: a } })) } };
      }
      if (r.method === 'GET' && path === '/search/issues') {
        const q = r.query.q ?? '';
        const label = /label:"?([^"\s]+)"?/.exec(q)?.[1];
        const users = [...q.matchAll(/user:(\S+)/g)].map((m) => m[1]);
        const authors = [...q.matchAll(/author:(\S+)/g)].map((m) => m[1]);
        const found = issues.filter((i) => (i.state ?? 'open') === 'open' && (!label || i.labels.includes(label))
          && (users.length === 0 || users.includes(i.repo.split('/')[0])) && (authors.length === 0 || authors.includes(i.author)));
        return { status: 200, body: { total_count: found.length, incomplete_results: false, items: found.map(restIssue) } };
      }
      const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
      if (!m) return { status: 404, body: { message: 'Not Found' } };
      const [, repo, rest] = m as unknown as [string, string, string];
      if (r.method === 'POST' && rest === 'labels') return { status: 201, body: { name: r.body.name } };
      if (r.method === 'GET' && rest === 'issues') {
        return { status: 200, body: issues.filter((i) => i.repo === repo && (i.state ?? 'open') === 'open' && i.labels.includes(r.query.labels ?? '')).map(restIssue) };
      }
      const im = /^issues\/(\d+)(?:\/(comments|labels)(?:\/(.+))?)?$/.exec(rest);
      const issue = im ? find(repo, Number(im[1])) : undefined;
      if (!im || !issue) return { status: 404, body: { message: 'Not Found' } };
      if (r.method === 'GET' && !im[2]) return { status: 200, body: restIssue(issue) };
      if (r.method === 'GET' && im[2] === 'comments') return { status: 200, body: [] };
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
  }, { issues, tokens, devices }).then((f) => (forge = f));
}
