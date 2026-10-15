// What a GitHub watch reads (issue #427, design.md "GitHub watches"), with the person's own GitHub connection: the item
// (`GET /repos/{repo}/issues/{n}`, which answers a pull request too: its state, labels and merge) and its timeline (every
// page: comments, reviews, the pull requests that reference it). Both through `makeRequest`, so the shared rate limiter
// paces them and its conditional requests make an unchanged page a 304 that costs no call (issue #436).
import type { Pointer } from '../domain/pointed-jobs.ts';
import type { WatchComment, WatchReview, WatchSnapshot } from '../domain/github-watch.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, paginate, splitRepo, statusOf } from '../sources/github/http/http.ts';

export interface WatchGitHub {
  snapshot(repo: string, pointer: Pointer): Promise<WatchSnapshot>;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? v as Raw : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const loginOf = (v: unknown): string => str(obj(v).login);

/** The snapshot from GitHub's answers: the item as `GET …/issues/{n}` gives it, and its timeline's events. */
export function snapshotOf(item: Raw, timeline: readonly Raw[]): WatchSnapshot {
  const mergedAt = str(obj(item.pull_request).merged_at);
  const state = mergedAt ? 'merged' : item.state === 'closed' ? 'closed' : 'open';
  const comments: WatchComment[] = [];
  const reviews: WatchReview[] = [];
  const linked = new Set<string>();
  for (const e of timeline) {
    if (e.event === 'commented' && typeof e.id === 'number') comments.push({ id: e.id, author: loginOf(e.user ?? e.actor), at: str(e.created_at) });
    if (e.event === 'reviewed' && typeof e.id === 'number') reviews.push({ id: e.id, author: loginOf(e.user), state: str(e.state).toLowerCase(), at: str(e.submitted_at) });
    const source = obj(obj(e.source).issue);
    if (e.event === 'cross-referenced' && source.pull_request && str(source.html_url)) linked.add(str(source.html_url));
  }
  return {
    state, ...(state === 'closed' && str(item.state_reason) ? { stateReason: str(item.state_reason) } : {}), ...(mergedAt ? { mergedAt } : {}),
    labels: (Array.isArray(item.labels) ? item.labels : []).map((l) => (typeof l === 'string' ? l : str(obj(l).name))).filter(Boolean).sort(),
    comments, reviews, linkedPullRequests: [...linked].sort(),
  };
}

/** GitHub's refusal or failure, with its status when it gave one. */
export class WatchGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WatchGitHubError';
    if (status !== undefined) this.status = status;
  }
}

export function createWatchGitHub(o: { apiUrl: string } & TokenSource): WatchGitHub {
  // A GitHub watch's calls count as its own kind (issue #985).
  const req = makeRequest(o.apiUrl, undefined, { kind: 'watch' });
  const withToken = tokenCaller(o);
  return {
    snapshot(repo, pointer) {
      const { owner, repo: name } = splitRepo(repo);
      const at = { owner, repo: name, issue_number: pointer.number };
      return withToken(async (token) => {
        const authorization = `token ${token}`;
        const item = await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...at, headers: { authorization } });
        const timeline = await paginate(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { ...at, per_page: 100 }, authorization, (d) => (Array.isArray(d) ? d as Raw[] : []));
        return snapshotOf(obj(item.data), timeline);
      }, (err) => new WatchGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${repo}#${pointer.number}: ${str(obj(err).message) || String(err)}`, statusOf(err)));
    },
  };
}
