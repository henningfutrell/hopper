// Issue, comment-read and label calls of the connected account's adapter, each with the account's token. REST shapes mapped
// onto the GitHubApi port's types.

import { CHANGE_READ_PAGE, type GitHubComment, type GitHubIssue, type IssueChange, type IssueEvent, type PullRequestReview, type SubIssue, type WorkflowRun } from '../api.ts';
import { paginate, splitRepo, statusOf } from './http.ts';
import type { Request } from './http.ts';
import type { PostedComment } from '../api.ts';

interface RestIssue {
  number: number; title: string; body?: string | null; state: string; html_url: string; updated_at: string;
  user?: { login?: string; id?: number } | null; assignees?: ({ login?: string } | null)[] | null; labels?: ({ name?: string } | string)[]; closed_by?: { login?: string } | null;
  closed_at?: string | null; state_reason?: string | null;
  pull_request?: unknown; sub_issues_summary?: { total?: number; completed?: number; percent_completed?: number } | null;
  repository_url?: string;
}
interface RestIssueWithRepo extends RestIssue { repository?: { full_name?: string } | null }
interface RestComment {
  id: number; body?: string | null; user?: { login?: string } | null; created_at: string; updated_at?: string; html_url: string; author_association?: string;
  performed_via_github_app?: { slug?: string } | null;
}

export function issueFrom(i: RestIssue, repo: string): GitHubIssue {
  return {
    repo, number: i.number, url: i.html_url, title: i.title, body: i.body ?? '', author: i.user?.login ?? '',
    ...(typeof i.user?.id === 'number' ? { authorId: i.user.id } : {}),
    assignees: (i.assignees ?? []).map((a) => a?.login ?? '').filter((l) => l !== ''),
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    state: i.state === 'closed' ? 'closed' : 'open', updatedAt: i.updated_at,
    ...(i.closed_by?.login ? { closedBy: i.closed_by.login } : {}),
    ...(i.closed_at ? { closedAt: i.closed_at } : {}),
    ...(i.state_reason ? { stateReason: i.state_reason } : {}),
    ...(i.sub_issues_summary?.total ? { subIssues: { total: i.sub_issues_summary.total, closed: i.sub_issues_summary.completed ?? 0 } } : {}),
  };
}

/** A sub-issue as GitHub lists it (issue #729): its repository from its `repository_url`, else `repo` (its parent's). */
export function subIssueFrom(i: RestIssue, repo: string): SubIssue {
  return { repo: /\/repos\/([^/]+\/[^/]+)$/.exec(i.repository_url ?? '')?.[1] ?? repo, number: i.number, state: i.state === 'closed' ? 'closed' : 'open' };
}

function commentFrom(c: RestComment): GitHubComment {
  return { id: c.id, author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at, url: c.html_url, ...(c.author_association ? { association: c.author_association } : {}),
    ...(c.updated_at ? { updatedAt: c.updated_at } : {}), ...(c.performed_via_github_app?.slug ? { viaApp: c.performed_via_github_app.slug } : {}) };
}

const auth = (token: string) => ({ authorization: `token ${token}` });

/**
 * The log of GitHub Actions job `jobId` (issue #993): GitHub answers a redirect to its storage, which the request follows;
 * the text, as it comes.
 */
export async function jobLog(req: Request, token: string, repo: string, jobId: number): Promise<string> {
  const r = await req('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { ...splitRepo(repo), job_id: jobId, headers: auth(token) });
  const data: unknown = r.data;
  return typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data ?? '');
}

/** GitHub Actions workflow run `runId` (issue #1508): its link, status and conclusion. */
export async function workflowRun(req: Request, token: string, repo: string, runId: number): Promise<WorkflowRun> {
  const r = await req('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { ...splitRepo(repo), run_id: runId, headers: auth(token) });
  const d = r.data as { html_url?: string; status?: string | null; conclusion?: string | null };
  return { url: d.html_url ?? `https://github.com/${repo}/actions/runs/${runId}`, status: d.status ?? 'unknown', ...(d.conclusion ? { conclusion: d.conclusion } : {}) };
}

/** The reviews of pull request `number` (issue #1694 part 3), oldest first; a review not yet sent (pending) is none. */
export async function pullRequestReviews(req: Request, token: string, repo: string, number: number): Promise<PullRequestReview[]> {
  const read = await paginate(req, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...splitRepo(repo), pull_number: number, per_page: 100 },
    `token ${token}`, (d) => d as { state: string; submitted_at?: string | null }[]);
  return read.filter((r) => r.state !== 'PENDING').map((r) => ({ state: r.state.toLowerCase(), ...(r.submitted_at ? { submittedAt: r.submitted_at } : {}) }));
}

/** Run GitHub Actions job `jobId` again (issue #1230): GitHub answers 201 and queues it with the run's other jobs it needs. */
export async function rerunJob(req: Request, token: string, repo: string, jobId: number): Promise<void> {
  await req('POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun', { ...splitRepo(repo), job_id: jobId, headers: auth(token) });
}

export async function getIssue(req: Request, token: string, repo: string, number: number): Promise<GitHubIssue> {
  const r = await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, headers: auth(token) });
  return issueFrom(r.data as RestIssue, repo);
}

export async function subIssues(req: Request, token: string, repo: string, number: number): Promise<SubIssue[]> {
  const subs = await paginate(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...splitRepo(repo), issue_number: number, per_page: 100 },
    `token ${token}`, (d) => d as RestIssue[]);
  return subs.map((i) => subIssueFrom(i, repo));
}

export async function listComments(req: Request, token: string, repo: string, number: number): Promise<GitHubComment[]> {
  const comments = await paginate(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { ...splitRepo(repo), issue_number: number, per_page: 100 }, `token ${token}`, (d) => d as RestComment[]);
  return comments.map(commentFrom).sort((a, b) => a.id - b.id);
}

interface RestIssueEvent {
  event: string; created_at: string; assignee?: { login?: string } | null;
  actor?: { login?: string; id?: number; type?: string } | null; label?: { name?: string } | null; performed_via_github_app?: { slug?: string } | null;
}

const listEvents = (req: Request, token: string, repo: string, number: number): Promise<RestIssueEvent[]> =>
  paginate(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/events', { ...splitRepo(repo), issue_number: number, per_page: 100 }, `token ${token}`, (d) => d as RestIssueEvent[]);

/** The issue's `labeled`, `assigned` (issue #652) and `reopened` (issue #1268) events, oldest first. */
export async function issueEvents(req: Request, token: string, repo: string, number: number): Promise<IssueEvent[]> {
  return (await listEvents(req, token, repo, number)).flatMap((e): IssueEvent[] => {
    if (e.event !== 'labeled' && e.event !== 'assigned' && e.event !== 'reopened') return [];
    return [{
      event: e.event, at: e.created_at, actor: e.actor?.login ?? '', ...(typeof e.actor?.id === 'number' ? { actorId: e.actor.id } : {}),
      ...(e.actor?.type ? { actorType: e.actor.type } : {}),
      ...(e.performed_via_github_app?.slug ? { viaApp: e.performed_via_github_app.slug } : {}),
      ...(e.event === 'labeled' && e.label?.name ? { label: e.label.name } : {}),
      ...(e.event === 'assigned' && e.assignee?.login ? { assignee: e.assignee.login } : {}),
    }];
  }).sort((a, b) => a.at.localeCompare(b.at));
}

/** The newest `assigned` event naming `login` (GitHub logins compare without case), or undefined. */
export async function assignedAt(req: Request, token: string, repo: string, number: number, login: string): Promise<string | undefined> {
  const events = await listEvents(req, token, repo, number);
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

export async function postComment(req: Request, token: string, repo: string, number: number, body: string): Promise<PostedComment> {
  const c = (await req('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...splitRepo(repo), issue_number: number, body, headers: auth(token) })).data as RestComment | undefined;
  return { id: c?.id ?? 0, url: c?.html_url ?? '' };
}

/** File an issue (issue #1143 reopened: a done item's companion rebase issue): its number and URL. */
export async function fileIssue(req: Request, token: string, repo: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<{ number: number; url: string }> {
  const i = (await req('POST /repos/{owner}/{repo}/issues', { ...splitRepo(repo), ...issue, headers: auth(token) })).data as RestIssue;
  return { number: i.number, url: i.html_url };
}

export async function reopenIssue(req: Request, token: string, repo: string, number: number): Promise<void> {
  await req('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, state: 'open', headers: auth(token) });
}

/** Close issue `number` as completed (issue #677: after the hopper's own merge of a pull request that did not close it). */
export async function closeIssue(req: Request, token: string, repo: string, number: number, reason: 'completed' | 'not_planned' = 'completed'): Promise<void> {
  await req('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, state: 'closed', state_reason: reason, headers: auth(token) });
}

/** Merge pull request `number` with a merge commit (issue #637, yolo mode): GitHub's refusal (405, 409) throws. */
export async function mergePullRequest(req: Request, token: string, repo: string, number: number): Promise<void> {
  await req('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...splitRepo(repo), pull_number: number, merge_method: 'merge', headers: auth(token) });
}

/** Close pull request `number` without a merge (issue #677, Close PR). */
export async function closePullRequest(req: Request, token: string, repo: string, number: number): Promise<void> {
  await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, state: 'closed', headers: auth(token) });
}

/** Change the base branch of open pull request `number` to `base` (issue #1143). */
export async function retargetPullRequest(req: Request, token: string, repo: string, number: number, base: string): Promise<void> {
  await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, base, headers: auth(token) });
}

/**
 * Make open pull request `number` a draft (issue #724: rework): GitHub's GraphQL `convertPullRequestToDraft`, by its node
 * id. A draft stays a draft. GitHub's refusal throws.
 */
export async function convertToDraft(req: Request, token: string, repo: string, number: number): Promise<void> {
  const pull = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, headers: auth(token) })).data as { node_id: string; draft?: boolean };
  if (pull.draft === true) return;
  const query = 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
  const d = (await req('POST /graphql', { query, variables: { id: pull.node_id }, headers: auth(token) })).data as { errors?: { message?: string }[] };
  if (d.errors?.length) throw new Error(`convert ${repo}#${number} to a draft: ${d.errors.map((e) => e.message ?? '').join('; ')}`);
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

export async function addAssignees(req: Request, token: string, repo: string, number: number, assignees: string[]): Promise<void> {
  await req('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', { ...splitRepo(repo), issue_number: number, assignees, headers: auth(token) });
}

/**
 * A change read (issue #1125): `repo`'s issues and pull requests changed since `since`, newest change first, one page. The
 * same `since` gives the same URL, so the rate limiter's ETag makes it a conditional request.
 */
export async function issuesChangedSince(req: Request, token: string, repo: string, since: string | undefined): Promise<IssueChange[]> {
  const r = await req('GET /repos/{owner}/{repo}/issues', {
    ...splitRepo(repo), state: 'all', sort: 'updated', direction: 'desc', per_page: CHANGE_READ_PAGE, ...(since ? { since } : {}), headers: auth(token),
  });
  return (r.data as RestIssue[]).map((i) => ({
    number: i.number, kind: i.pull_request === undefined ? 'issue' : 'pull', state: i.state === 'closed' ? 'closed' : 'open', title: i.title,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    assignees: (i.assignees ?? []).map((a) => a?.login ?? '').filter((l) => l !== ''), updatedAt: i.updated_at,
  }));
}

/** `GET /issues?filter=assigned`: the user's open issues with `label`, across the repos the token reaches (issue #440). */
export async function listAssignedIssues(req: Request, token: string, label: string): Promise<GitHubIssue[]> {
  const issues = await paginate(req, 'GET /issues', { filter: 'assigned', labels: label, state: 'open', per_page: 100 },
    `token ${token}`, (d) => d as RestIssueWithRepo[]);
  return issues.filter((i) => i.pull_request === undefined && i.repository?.full_name).map((i) => issueFrom(i, i.repository!.full_name!));
}

