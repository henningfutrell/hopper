// A job's write after a crash (issue #1959 part 2, design.md "The GitHub proxy under crashes"). The resend key (issue
// #1607) answers a request sent again from its `github_proxy.done`; a hopper killed after GitHub made the issue or the
// comment, and before it recorded that, left no such event. So the broker records `github_proxy.sending` before the call,
// and the text it posts ends with a **post key** (src/domain/post-key.ts) made from the resend key. A request sent again
// whose key was sending before, with no answer recorded, is looked for on GitHub by that post key first: what GitHub made is
// answered, never made twice. A job's pull request create (part 4) is found so too, by the post key in its body. The kill
// points of the crash harness sit before and after each write's call.
import { createHash } from 'node:crypto';
import { hasPostKey } from '../domain/post-key.ts';
import { killPoint } from '../sagas/kill-points.ts';
import { paginate, splitRepo, type Request } from '../sources/github/http/http.ts';
import type { ProxyRequest } from './policy.ts';
import type { LineageEvents } from './sub-issue-links.ts';

/** How many of the newest `github_proxy.sending` events a look-up reads. */
const SENDING_READ = 1000;

/** The kill points of a job's write (design.md "The crash harness"): before its call, once GitHub answered, and between a required child and its link. */
export const proxyKillPoint = (op: string, at: 'before-send' | 'after-send' | 'before-link'): string => `proxy:${op}:${at}`;

/** Passes the kill point of a job's write: nothing, but in a crash test that armed it. */
export const passProxyKillPoint = (op: string, at: 'before-send' | 'after-send' | 'before-link'): void => killPoint(proxyKillPoint(op, at));

/**
 * The post key of a job's write with resend key `key`: from the key and its scope, the job's issue (a **fan-out key** is the
 * issue's, issue #1909), else the job. It names no person or machine.
 */
export const proxyPostKey = (scope: string, key: string): string =>
  `proxy-${createHash('sha256').update(`${scope}\n${key}`).digest('hex').slice(0, 24)}`;

/**
 * When the first send of resend key `key` began, of `jobId` or of an earlier job of the same issue (`sameIssue`), as
 * `github_proxy.sending` records it; undefined: it was never sent.
 */
export function sendingSince(events: LineageEvents, jobId: string, key: string, sameIssue: (otherJobId: string) => boolean): string | undefined {
  return events.recent(SENDING_READ, ['github_proxy.sending'])
    .filter((e) => e.data.key === key && e.jobId !== undefined && (e.jobId === jobId || sameIssue(e.jobId))).at(-1)?.at;
}

/** What a look-up found on GitHub: the issue (its REST id, for a sub-issue link), the comment, or the pull request (its branches). */
export interface Posted { id?: number; number: number; url: string; head?: string; base?: string }

/**
 * The pull request from the request's head whose body carries `postKey` (issue #1959 part 4): GitHub refuses a second one
 * from the same head, so one a crash left is answered, not asked for again. Its `head` is a branch of the repository, or
 * `owner:branch` of a fork's.
 */
async function findPull(req: Request, headers: Record<string, string>, r: Extract<ProxyRequest, { op: 'pr.create' }>, postKey: string): Promise<Posted | undefined> {
  const { owner, repo } = splitRepo(r.repo);
  const head = r.head.includes(':') ? r.head : `${owner}:${r.head}`;
  const d = (await req('GET /repos/{owner}/{repo}/pulls', { owner, repo, head, state: 'all', per_page: 100, headers })).data as { number: number; body?: string | null; html_url: string; head: { ref: string }; base: { ref: string } }[];
  const p = d.find((x) => hasPostKey(x.body, postKey));
  return p ? { number: p.number, url: p.html_url, head: p.head.ref, base: p.base.ref } : undefined;
}

/**
 * The issue `login` made on the request's repository, the comment on its issue, or the pull request from its head, whose
 * text carries `postKey`, made or changed since `since`; undefined: none, or the request posts nothing. One page (100), as
 * the post key's look-ups read.
 */
export async function findPosted(req: Request, headers: Record<string, string>, r: ProxyRequest, postKey: string, since: string, login: string): Promise<Posted | undefined> {
  if (r.op === 'pr.create') return findPull(req, headers, r, postKey);
  const at = { ...splitRepo(r.repo), since, per_page: 100, headers };
  if (r.op === 'issue.comment') {
    const d = (await req('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...at, issue_number: r.number })).data as { body?: string | null; html_url: string }[];
    const c = d.find((x) => hasPostKey(x.body, postKey));
    return c ? { number: r.number, url: c.html_url } : undefined;
  }
  if (r.op !== 'issue.create') return undefined;
  const d = (await req('GET /repos/{owner}/{repo}/issues', { ...at, creator: login, state: 'all' })).data as { id?: number; number: number; body?: string | null; html_url: string; pull_request?: unknown }[];
  const i = d.find((x) => x.pull_request === undefined && hasPostKey(x.body, postKey));
  return i ? { ...(i.id !== undefined ? { id: i.id } : {}), number: i.number, url: i.html_url } : undefined;
}

type Parent = { repo: string; number: number };

/** Whether the issue with REST id `childId` is a sub-issue of `parent` on GitHub already. */
async function isSubIssue(req: Request, token: string, parent: Parent, childId: number): Promise<boolean> {
  const held = await paginate<{ id?: number }>(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...splitRepo(parent.repo), issue_number: parent.number, per_page: 100 }, `token ${token}`, (d) => d as { id?: number }[]);
  return held.some((i) => i.id === childId);
}

/**
 * The write found by its post key (`findPosted`), as the proxy answers it; a found issue with `subIssueOf` is linked with
 * `link` (which never throws) unless it is a sub-issue of it already. Undefined: not found.
 */
export async function findFiled(
  req: Request, token: string, r: ProxyRequest, o: { postKey: string; since: string; login: string; subIssueOf?: Parent },
  link: (req: Request, headers: Record<string, string>, parent: Parent, childId: number | undefined) => Promise<Record<string, unknown>>,
): Promise<{ number: number; url: string } & Record<string, unknown> | undefined> {
  const headers = { authorization: `token ${token}` };
  const found = await findPosted(req, headers, r, o.postKey, o.since, o.login);
  if (!found || !o.subIssueOf) return found && { number: found.number, url: found.url, ...(found.head !== undefined ? { head: found.head, base: found.base } : {}) };
  const linked = found.id !== undefined && await isSubIssue(req, token, o.subIssueOf, found.id);
  return { number: found.number, url: found.url, ...(linked ? { subIssue: true } : await link(req, headers, o.subIssueOf, found.id)) };
}
