// A fake GitLab on loopback (issue #1448 part 2): GitLab's REST API v4 as the GitLab source asks it — who a personal access
// token is and its emails, the projects it reaches, a project's open issues with a label —, paged by `x-next-page`; for a job
// (part 3): a project's default branch, an issue's label events and system notes (who labelled, assigned or edited it), and
// the hopper's label edits; for a job's merge request (issue #1642): one issue, the merge requests that close it, and one
// merge request with its pipeline; the hopper's merge of one (issue #1642 part 2), which closes the issues it closes; for the done
// criteria (issue #1924 part 4): its head pipeline's jobs and each job's log, its notes, its changed files, and its head commit.
// Each request is recorded with the token it carried.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gitBackend } from './fake-git.ts';

export interface FakeGitLabUser { id: number; username: string; email: string; emails?: { email: string; confirmed?: boolean }[]; projects: string[]; mayReadEmails?: boolean }
/**
 * `labelledBy`, `assignedBy`: who added the label `hopper` and who assigned it (default: its author); `editedBy`: who edited
 * its description since; `highBy`: who added `hopper:high` (default: its author), when it has it. A username's id is its
 * token's user's, else `ids`, else 900.
 */
export interface FakeGitLabIssue {
  project: string; iid: number; title: string; description?: string; author: string; assignees?: string[]; labels: string[]; state?: 'opened' | 'closed';
  labelledBy?: string; assignedBy?: string; editedBy?: string[]; highBy?: string;
}

/**
 * A merge request (issue #1642): `closes` the issues its description closes; `pipeline` its head pipeline's status, absent: none.
 * `sha`: its head (default `abc123`); `mergeRefusal`: a merge of it is refused with this status (405, 409, …).
 */
export interface FakeGitLabMergeRequest {
  project: string; iid: number; closes: number[]; state: 'opened' | 'closed' | 'merged'; createdAt: string; mergedAt?: string;
  draft?: boolean; conflicts?: boolean; pipeline?: string; sha?: string; updatedAt?: string; mergeRefusal?: number;
  /**
   * Issue #1924 part 4: its head pipeline's jobs, each with its log (`trace`); its notes (`system`: GitLab's own line); its changed
   * files (absent: none); its head commit's time (default its `createdAt`).
   */
  jobs?: { name: string; status: string; trace?: string }[]; notes?: { body: string; at: string; system?: boolean }[]; files?: string[]; committedAt?: string;
}

export interface FakeGitLab {
  url: string;
  /** Token → its user. */
  tokens: Map<string, FakeGitLabUser>;
  /** Tokens GitLab refuses now (401): revoked. */
  refused: Set<string>;
  issues: FakeGitLabIssue[];
  mergeRequests: FakeGitLabMergeRequest[];
  /** Projects whose issue reads fail with 500. */
  failing: Set<string>;
  /** Projects whose issue label writes fail with 500 (issue #1892 part 17). */
  failingWrites: Set<string>;
  requests: { path: string; token: string | undefined; method?: string; body?: unknown }[];
  /** Its git over HTTP (part 3), with `gitRoot`: each request with the token it carried as Basic auth's password. */
  gitRequests: { path: string; user: string; token: string }[];
  /** A username's user id, for the people with no token here. */
  ids: Map<string, number>;
  /** A project's default branch (default `main`). */
  defaultBranches: Map<string, string>;
  /** Items per page (default 100). */
  perPage?: number;
  close(): Promise<void>;
}

/** `gitRoot`: the bare repositories `<root>/<project>.git` its git serves, by git's own `git-http-backend`; absent: no git. */
export async function createFakeGitLab(o: { issues?: FakeGitLabIssue[]; gitRoot?: string } = {}): Promise<FakeGitLab> {
  const fake: Omit<FakeGitLab, 'url' | 'close'> = { tokens: new Map(), refused: new Set(), issues: [...(o.issues ?? [])], mergeRequests: [], failing: new Set(), failingWrites: new Set(), requests: [], gitRequests: [], ids: new Map(), defaultBranches: new Map() };
  const idOf = (username: string): number => [...fake.tokens.values()].find((u) => u.username === username)?.id ?? fake.ids.get(username) ?? 900;
  const person = (username: string) => ({ id: idOf(username), username });
  const send = (res: ServerResponse, status: number, body: unknown, next?: string) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(next ? { 'x-next-page': next } : {}) });
    res.end(JSON.stringify(body));
  };
  const paged = (res: ServerResponse, url: URL, list: unknown[]) => {
    const per = Math.min(Number(url.searchParams.get('per_page') ?? 20), fake.perPage ?? 100), page = Number(url.searchParams.get('page') ?? 1);
    const slice = list.slice((page - 1) * per, page * per);
    send(res, 200, slice, page * per < list.length ? String(page + 1) : undefined);
  };
  /** A merge request as GitLab answers it; its head pipeline only in the answer for one (`one`), as GitLab's list leaves it out. */
  const mergeRequestJson = (x: FakeGitLabMergeRequest, one: boolean) => ({
    iid: x.iid, web_url: `${fakeUrl}/${x.project}/-/merge_requests/${x.iid}`, state: x.state, draft: x.draft ?? false, has_conflicts: x.conflicts ?? false,
    target_branch: 'main', source_branch: `issue-${x.closes[0] ?? x.iid}`, created_at: x.createdAt, updated_at: x.updatedAt ?? x.createdAt, merged_at: x.mergedAt ?? null, sha: x.sha ?? 'abc123', description: x.closes.map((n) => `Closes #${n}`).join('\n'),
    ...(one ? { head_pipeline: x.pipeline ? { id: x.iid, status: x.pipeline } : null } : {}),
  });
  /** What the done criteria read (issue #1924 part 4): a pipeline's jobs, a job's log, a merge request's notes and diffs, a commit. */
  const doneFacts = (res: ServerResponse, url: URL, projects: string[]): boolean => {
    const at = /^\/api\/v4\/projects\/([^/]+)\/(pipelines\/(\d+)\/jobs|jobs\/(\d+)\/trace|merge_requests\/(\d+)\/(notes|diffs)|repository\/commits\/([^/]+))$/.exec(url.pathname);
    if (!at) return false;
    const project = decodeURIComponent(at[1]!);
    const mine = fake.mergeRequests.filter((x) => x.project === project && projects.includes(project));
    if (at[3]) {
      const found = mine.find((x) => x.iid === Number(at[3]));
      if (!found) { send(res, 404, { message: '404 Not found' }); return true; }
      paged(res, url, (found.jobs ?? []).map((j, i) => ({ id: found.iid * 100 + i, name: j.name, status: j.status })));
    } else if (at[4]) {
      const id = Number(at[4]), found = mine.find((x) => x.iid === Math.floor(id / 100))?.jobs?.[id % 100];
      if (!found) { send(res, 404, { message: '404 Not found' }); return true; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(found.trace ?? '');
    } else if (at[5]) {
      const found = mine.find((x) => x.iid === Number(at[5]));
      if (!found) { send(res, 404, { message: '404 Not found' }); return true; }
      paged(res, url, at[6] === 'notes'
        ? (found.notes ?? []).map((n, i) => ({ id: i + 1, body: n.body, system: n.system ?? false, created_at: n.at, updated_at: n.at }))
        : (found.files ?? []).map((f) => ({ old_path: f, new_path: f })));
    } else {
      const found = mine.find((x) => (x.sha ?? 'abc123') === decodeURIComponent(at[7]!));
      if (!found) { send(res, 404, { message: '404 Commit Not Found' }); return true; }
      send(res, 200, { id: found.sha ?? 'abc123', committed_date: found.committedAt ?? found.createdAt });
    }
    return true;
  };
  const read = (req: IncomingMessage): Promise<string> => new Promise((r) => { let b = ''; req.on('data', (c: Buffer) => { b += c.toString(); }); req.on('end', () => r(b)); });
  /** A git request (part 3): only with a token GitLab takes, as Basic auth's password, as GitLab answers a private project. */
  const git = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const m = /^\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m || !o.gitRoot) return false;
    const basic = /^basic\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const [user = '', ...rest] = basic ? Buffer.from(basic, 'base64').toString('utf8').split(':') : [];
    const token = rest.join(':');
    fake.gitRequests.push({ path: url.pathname, user, token });
    const who = fake.tokens.get(token);
    if (!who || fake.refused.has(token)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="GitLab"' }); res.end('HTTP Basic: Access denied'); return true; }
    gitBackend(o.gitRoot, req, res, url, m[1]!, m[2]!, who.username);
    return true;
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (git(req, res, url)) return;
    const token = req.headers['private-token'] as string | undefined;
    const text = req.method === 'PUT' ? await read(req) : '';
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    fake.requests.push({ path: url.pathname + url.search, token, ...(req.method !== 'GET' ? { method: req.method } : {}), ...(body ? { body } : {}) });
    const user = token ? fake.tokens.get(token) : undefined;
    if (!user || fake.refused.has(token!)) return send(res, 401, { message: '401 Unauthorized' });
    if (url.pathname === '/api/v4/user') return send(res, 200, { id: user.id, username: user.username, email: user.email });
    if (url.pathname === '/api/v4/user/emails') {
      if (user.mayReadEmails === false) return send(res, 403, { message: '403 Forbidden' });
      return send(res, 200, (user.emails ?? []).map((e, i) => ({ id: i + 1, email: e.email, confirmed_at: e.confirmed === false ? null : '2026-01-01T00:00:00Z' })));
    }
    if (url.pathname === '/api/v4/projects') return paged(res, url, user.projects.map((p, i) => ({ id: i + 1, path_with_namespace: p })));
    const one = /^\/api\/v4\/projects\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const project = decodeURIComponent(one[1]!);
      if (!user.projects.includes(project)) return send(res, 404, { message: '404 Project Not Found' });
      return send(res, 200, { path_with_namespace: project, default_branch: fake.defaultBranches.get(project) ?? 'main' });
    }
    if (doneFacts(res, url, user.projects)) return;
    const mr = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)(\/merge)?$/.exec(url.pathname);
    if (mr) {
      const project = decodeURIComponent(mr[1]!), iid = Number(mr[2]);
      const found = user.projects.includes(project) ? fake.mergeRequests.find((x) => x.project === project && x.iid === iid) : undefined;
      if (!found) return send(res, 404, { message: '404 Not found' });
      if (mr[3] && req.method === 'PUT') {
        if (found.mergeRefusal) return send(res, found.mergeRefusal, { message: 'Branch cannot be merged' });
        if (found.state !== 'opened' || body?.sha !== (found.sha ?? 'abc123')) return send(res, 409, { message: 'SHA does not match HEAD of source branch' });
        Object.assign(found, { state: 'merged', mergedAt: new Date().toISOString() });
        for (const i of fake.issues.filter((i) => i.project === project && found.closes.includes(i.iid))) i.state = 'closed';
      }
      return send(res, 200, mergeRequestJson(found, true));
    }
    const of = /^\/api\/v4\/projects\/([^/]+)\/issues\/(\d+)(\/resource_label_events|\/notes|\/closed_by)?$/.exec(url.pathname);
    if (of) {
      const project = decodeURIComponent(of[1]!), iid = Number(of[2]);
      const issue = user.projects.includes(project) ? fake.issues.find((i) => i.project === project && i.iid === iid) : undefined;
      if (!issue) return send(res, 404, { message: '404 Not found' });
      if (of[3] === '/resource_label_events') {
        const high = issue.labels.includes('hopper:high') ? [{ id: 2, action: 'add', label: { name: 'hopper:high' }, user: person(issue.highBy ?? issue.author) }] : [];
        return paged(res, url, [...(issue.labels.includes('hopper') ? [{ id: 1, action: 'add', label: { name: 'hopper' }, user: person(issue.labelledBy ?? issue.author) }] : []), ...high]);
      }
      if (of[3] === '/notes') {
        const assigned = (issue.assignees ?? []).length ? [{ id: 1, system: true, body: `assigned to ${(issue.assignees ?? []).map((a) => `@${a}`).join(' and ')}`, author: person(issue.assignedBy ?? issue.author) }] : [];
        const edits = (issue.editedBy ?? []).map((who, i) => ({ id: 10 + i, system: true, body: 'changed the description', author: person(who) }));
        return paged(res, url, [...assigned, { id: 5, system: false, body: 'a comment', author: person(issue.author) }, ...edits]);
      }
      if (of[3] === '/closed_by') {
        return paged(res, url, fake.mergeRequests.filter((x) => x.project === project && x.closes.includes(iid)).map((x) => mergeRequestJson(x, false)));
      }
      if (req.method !== 'PUT') {
        return send(res, 200, {
          iid, title: issue.title, description: issue.description ?? '', web_url: `${fakeUrl}/${project}/-/issues/${iid}`, state: issue.state ?? 'opened',
          author: person(issue.author), assignees: (issue.assignees ?? []).map((username) => ({ username })), labels: issue.labels,
        });
      }
      if (req.method === 'PUT') {
        if (fake.failingWrites.has(project)) return send(res, 500, { message: '500 Internal Server Error' });
        const list = (v: unknown) => (typeof v === 'string' ? v.split(',').filter(Boolean) : []);
        issue.labels = [...issue.labels.filter((l) => !list(body?.remove_labels).includes(l)), ...list(body?.add_labels).filter((l) => !issue.labels.includes(l))];
        return send(res, 200, { iid, labels: issue.labels });
      }
    }
    const m = /^\/api\/v4\/projects\/([^/]+)\/issues$/.exec(url.pathname);
    if (m) {
      const project = decodeURIComponent(m[1]!);
      if (!user.projects.includes(project)) return send(res, 404, { message: '404 Project Not Found' });
      if (fake.failing.has(project)) return send(res, 500, { message: '500 Internal Server Error' });
      const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      const list = fake.issues.filter((i) => i.project === project && (i.state ?? 'opened') === (url.searchParams.get('state') ?? 'opened') && labels.every((l) => i.labels.includes(l)));
      return paged(res, url, list.map((i) => ({
        iid: i.iid, title: i.title, description: i.description ?? '', web_url: `${fakeUrl}/${project}/-/issues/${i.iid}`,
        author: person(i.author), assignees: (i.assignees ?? []).map((username) => ({ username })), labels: i.labels,
      })));
    }
    send(res, 404, { message: '404 Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, { url: fakeUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
}
