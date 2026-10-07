// Issue, comment-read and label calls of the App adapter, each with an installation token for the
// issue's repo. REST shapes mapped onto the GitHubApi port's types.

import type { GitHubComment, GitHubIssue } from '../api.ts';
import { paginate, splitRepo, statusOf } from './http.ts';
import type { Request } from './http.ts';

interface RestIssue {
  number: number; title: string; body?: string | null; state: string; html_url: string; updated_at: string;
  user?: { login?: string } | null; assignees?: ({ login?: string } | null)[] | null; labels?: ({ name?: string } | string)[]; closed_by?: { login?: string } | null;
  closed_at?: string | null; state_reason?: string | null;
  pull_request?: unknown;
}
interface RestComment { id: number; body?: string | null; user?: { login?: string } | null; created_at: string; html_url: string }

export function issueFrom(i: RestIssue, repo: string): GitHubIssue {
  return {
    repo, number: i.number, url: i.html_url, title: i.title, body: i.body ?? '', author: i.user?.login ?? '',
    assignees: (i.assignees ?? []).map((a) => a?.login ?? '').filter((l) => l !== ''),
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    state: i.state === 'closed' ? 'closed' : 'open', updatedAt: i.updated_at,
    ...(i.closed_by?.login ? { closedBy: i.closed_by.login } : {}),
    ...(i.closed_at ? { closedAt: i.closed_at } : {}),
    ...(i.state_reason ? { stateReason: i.state_reason } : {}),
  };
}

function commentFrom(c: RestComment): GitHubComment {
  return { id: c.id, author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at, url: c.html_url };
}

const auth = (token: string) => ({ authorization: `token ${token}` });

export async function listOpenIssues(req: Request, token: string, repo: string, label: string): Promise<GitHubIssue[]> {
  const issues = await paginate(req, 'GET /repos/{owner}/{repo}/issues', { ...splitRepo(repo), labels: label, state: 'open', per_page: 100 },
    `token ${token}`, (d) => d as RestIssue[]);
  return issues.filter((i) => i.pull_request === undefined).map((i) => issueFrom(i, repo));
}

export async function getIssue(req: Request, token: string, repo: string, number: number): Promise<GitHubIssue> {
  const r = await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, headers: auth(token) });
  return issueFrom(r.data as RestIssue, repo);
}

export async function listComments(req: Request, token: string, repo: string, number: number): Promise<GitHubComment[]> {
  const comments = await paginate(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { ...splitRepo(repo), issue_number: number, per_page: 100 }, `token ${token}`, (d) => d as RestComment[]);
  return comments.map(commentFrom).sort((a, b) => a.id - b.id);
}

interface RestIssueEvent { event: string; created_at: string; assignee?: { login?: string } | null }

/** The newest `assigned` event naming `login` (GitHub logins compare without case), or undefined. */
export async function assignedAt(req: Request, token: string, repo: string, number: number, login: string): Promise<string | undefined> {
  const events = await paginate(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/events',
    { ...splitRepo(repo), issue_number: number, per_page: 100 }, `token ${token}`, (d) => d as RestIssueEvent[]);
  const wanted = login.toLowerCase();
  return events.filter((e) => e.event === 'assigned' && e.assignee?.login?.toLowerCase() === wanted)
    .map((e) => e.created_at).sort().at(-1);
}

/** Creates the label; one that already exists (422 already_exists) is fine. */
export async function ensureLabel(req: Request, token: string, repo: string, name: string, color: string, description: string): Promise<void> {
  try {
    await req('POST /repos/{owner}/{repo}/labels', { ...splitRepo(repo), name, color, description, headers: auth(token) });
  } catch (err) {
    const errors = (err as { response?: { data?: { errors?: { code?: string }[] } } }).response?.data?.errors ?? [];
    if (statusOf(err) === 422 && errors.some((e) => e.code === 'already_exists')) return;
    throw err;
  }
}

export async function addLabels(req: Request, token: string, repo: string, number: number, labels: string[]): Promise<void> {
  await req('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...splitRepo(repo), issue_number: number, labels, headers: auth(token) });
}

export async function reopenIssue(req: Request, token: string, repo: string, number: number): Promise<void> {
  await req('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, state: 'open', headers: auth(token) });
}

/** Removes each label; one the issue does not carry (404) is fine. */
export async function removeLabels(req: Request, token: string, repo: string, number: number, labels: string[]): Promise<void> {
  for (const name of labels) {
    try {
      await req('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...splitRepo(repo), issue_number: number, name, headers: auth(token) });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }
}
