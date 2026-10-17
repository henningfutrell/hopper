// A fake GitLab on loopback (issue #1448 part 2): GitLab's REST API v4 as the GitLab source asks it — who a personal access
// token is and its emails, the projects it reaches, a project's open issues with a label —, paged by `x-next-page`. Each
// request is recorded with the token it carried.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGitLabUser { id: number; username: string; email: string; emails?: { email: string; confirmed?: boolean }[]; projects: string[]; mayReadEmails?: boolean }
export interface FakeGitLabIssue { project: string; iid: number; title: string; description?: string; author: string; assignees?: string[]; labels: string[]; state?: 'opened' | 'closed' }

export interface FakeGitLab {
  url: string;
  /** Token → its user. */
  tokens: Map<string, FakeGitLabUser>;
  /** Tokens GitLab refuses now (401): revoked. */
  refused: Set<string>;
  issues: FakeGitLabIssue[];
  /** Projects whose issue reads fail with 500. */
  failing: Set<string>;
  requests: { path: string; token: string | undefined }[];
  /** Items per page (default 100). */
  perPage?: number;
  close(): Promise<void>;
}

export async function createFakeGitLab(o: { issues?: FakeGitLabIssue[] } = {}): Promise<FakeGitLab> {
  const fake: Omit<FakeGitLab, 'url' | 'close'> = { tokens: new Map(), refused: new Set(), issues: [...(o.issues ?? [])], failing: new Set(), requests: [] };
  const send = (res: ServerResponse, status: number, body: unknown, next?: string) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(next ? { 'x-next-page': next } : {}) });
    res.end(JSON.stringify(body));
  };
  const paged = (res: ServerResponse, url: URL, list: unknown[]) => {
    const per = Math.min(Number(url.searchParams.get('per_page') ?? 20), fake.perPage ?? 100), page = Number(url.searchParams.get('page') ?? 1);
    const slice = list.slice((page - 1) * per, page * per);
    send(res, 200, slice, page * per < list.length ? String(page + 1) : undefined);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const token = req.headers['private-token'] as string | undefined;
    fake.requests.push({ path: url.pathname + url.search, token });
    const user = token ? fake.tokens.get(token) : undefined;
    if (!user || fake.refused.has(token!)) return send(res, 401, { message: '401 Unauthorized' });
    if (url.pathname === '/api/v4/user') return send(res, 200, { id: user.id, username: user.username, email: user.email });
    if (url.pathname === '/api/v4/user/emails') {
      if (user.mayReadEmails === false) return send(res, 403, { message: '403 Forbidden' });
      return send(res, 200, (user.emails ?? []).map((e, i) => ({ id: i + 1, email: e.email, confirmed_at: e.confirmed === false ? null : '2026-01-01T00:00:00Z' })));
    }
    if (url.pathname === '/api/v4/projects') return paged(res, url, user.projects.map((p, i) => ({ id: i + 1, path_with_namespace: p })));
    const m = /^\/api\/v4\/projects\/([^/]+)\/issues$/.exec(url.pathname);
    if (m) {
      const project = decodeURIComponent(m[1]!);
      if (!user.projects.includes(project)) return send(res, 404, { message: '404 Project Not Found' });
      if (fake.failing.has(project)) return send(res, 500, { message: '500 Internal Server Error' });
      const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      const list = fake.issues.filter((i) => i.project === project && (i.state ?? 'opened') === (url.searchParams.get('state') ?? 'opened') && labels.every((l) => i.labels.includes(l)));
      return paged(res, url, list.map((i) => ({
        iid: i.iid, title: i.title, description: i.description ?? '', web_url: `${fakeUrl}/${project}/-/issues/${i.iid}`,
        author: { username: i.author }, assignees: (i.assignees ?? []).map((username) => ({ username })), labels: i.labels,
      })));
    }
    send(res, 404, { message: '404 Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, { url: fakeUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
}
