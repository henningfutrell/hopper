// The batch runner's GitHub calls (issue #1073), with the user's own GitHub connection: a compare of the tested branch
// with the landing branch's tip (both reads conditional through the limiter's ETag, so an unchanged tip costs no call), a batch run's branch made and removed, its pull request opened, read,
// merged at its tip or closed, its check runs, and a job's open pull request moved to another base, with one fixed comment
// on it that says so (issue #1143); for a red batch, the
// pull request a commit merged, GitHub's revert of it (GraphQL `revertPullRequest`), a check's log and the fix issue; for
// merge conflicts, the tested branch merged into a back-merge branch (`POST …/merges`); for the canary, the bug reports
// that name a candidate (`GET /search/issues`) and `stable` moved to it, only as a fast-forward.
// The same `@octokit/request` binding and token renewal as Promote to GitHub (src/promotions/github.ts).
import { REPORT_LABEL } from '../bug-reports/context.ts';
import type { BatchCheckRun } from '../domain/landing-batches.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, paginate, splitRepo, statusOf } from '../sources/github/http/http.ts';
import { jobLog } from '../sources/github/http/rest.ts';
import type { LandingBatchGitHub } from './runner.ts';

const REVERT = `mutation($id: ID!, $title: String, $body: String) {
  revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) { revertPullRequest { number url } }
}`;

export function createLandingBatchGitHub(o: { apiUrl: string } & TokenSource): LandingBatchGitHub {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new Error(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`);
  };
  const headers = (token: string) => ({ authorization: `token ${token}` });
  return {
    compare: (repo, base, head) => withToken(async (token) => {
      // The tip first, so the compare is of that commit even when the branch moves meanwhile. A full sha is the tip.
      const tip = /^[0-9a-f]{40}$/.test(head) ? head
        : ((await req('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...splitRepo(repo), ref: `heads/${head}`, headers: headers(token) })).data as { object: { sha: string } }).object.sha;
      const d = (await req('GET /repos/{owner}/{repo}/compare/{basehead}', { ...splitRepo(repo), basehead: `${base}...${tip}`, per_page: 250, headers: headers(token) })).data as
        { ahead_by: number; commits: { sha: string; parents: { sha: string }[]; commit: { message: string } }[] };
      return { aheadBy: d.ahead_by, tip, commits: d.commits.map((c) => ({ sha: c.sha, parents: c.parents.map((x) => x.sha), message: c.commit.message })) };
    }, failed(`the compare of ${base} with ${head} on ${repo}`)),
    createBranch: (repo, name, sha) => withToken(async (token) => {
      await req('POST /repos/{owner}/{repo}/git/refs', { ...splitRepo(repo), ref: `refs/heads/${name}`, sha, headers: headers(token) })
        .catch((e: unknown) => { if (statusOf(e) !== 422) throw e; return req('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { ...splitRepo(repo), ref: `heads/${name}`, sha, force: true, headers: headers(token) }); });
    }, failed(`the branch ${name} of ${repo}`)),
    deleteBranch: (repo, name) => withToken(async (token) => {
      await req('DELETE /repos/{owner}/{repo}/git/refs/{ref}', { ...splitRepo(repo), ref: `heads/${name}`, headers: headers(token) })
        .catch((e: unknown) => { if (statusOf(e) !== 404 && statusOf(e) !== 422) throw e; });
    }, failed(`the removal of the branch ${name} of ${repo}`)),
    openPullRequest: (repo, p) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/pulls', { ...splitRepo(repo), ...p, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`a batch run's pull request on ${repo}`)),
    pullRequest: (repo, number) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, headers: headers(token) })).data as
        { state: string; merged: boolean; mergeable: boolean | null; head: { sha: string }; base: { ref: string }; html_url: string; body: string | null; merge_commit_sha: string | null };
      return {
        state: d.state === 'closed' ? 'closed' : 'open', merged: d.merged, mergeable: d.mergeable, headSha: d.head.sha, base: d.base.ref, url: d.html_url, body: d.body ?? '',
        ...(d.merged && d.merge_commit_sha ? { mergeSha: d.merge_commit_sha } : {}),
      };
    }, failed(`${repo}#${number}`)),
    checkRuns: (repo, sha) => withToken(async (token) => {
      type Run = { id: number; name: string; status: string; conclusion: string | null };
      const runs = await paginate<Run>(req, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
        { ...splitRepo(repo), ref: sha, per_page: 100 }, `token ${token}`, (data) => (data as { check_runs: Run[] }).check_runs);
      return runs.map((r): BatchCheckRun => ({ name: r.name, status: r.status, conclusion: r.conclusion, id: r.id }));
    }, failed(`the checks of ${sha.slice(0, 12)} on ${repo}`)),
    merge: (repo, number, sha, title) => withToken(async (token) => {
      const d = (await req('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...splitRepo(repo), pull_number: number, sha, merge_method: 'merge', commit_title: title, headers: headers(token) })).data as { sha: string };
      return { sha: d.sha };
    }, failed(`the merge of ${repo}#${number}`)),
    close: (repo, number) => withToken(async (token) => {
      await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, state: 'closed', headers: headers(token) });
    }, failed(`the close of ${repo}#${number}`)),
    mergeInto: (repo, base, head, message) => withToken(async (token) => {
      try {
        const r = await req('POST /repos/{owner}/{repo}/merges', { ...splitRepo(repo), base, head, commit_message: message, headers: headers(token) });
        // 204: the base has everything of the head.
        return (r.status as number) === 204 ? { kind: 'nothing' as const } : { kind: 'merged' as const, sha: (r.data as { sha: string }).sha };
      } catch (e) {
        if (statusOf(e) === 409) return { kind: 'conflict' as const };
        throw e;
      }
    }, failed(`the merge of ${head} into ${base} on ${repo}`)),
    openPullRequests: (repo, base) => withToken(async (token) => {
      const pulls = await paginate<{ number: number; html_url: string; head: { ref: string } }>(req, 'GET /repos/{owner}/{repo}/pulls', { ...splitRepo(repo), state: 'open', base, per_page: 100 }, `token ${token}`,
        (data) => data as { number: number; html_url: string; head: { ref: string } }[]);
      return pulls.map((p) => ({ number: p.number, url: p.html_url, head: p.head.ref }));
    }, failed(`the open pull requests on ${base} of ${repo}`)),
    retarget: (repo, number, base) => withToken(async (token) => {
      await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, base, headers: headers(token) });
    }, failed(`the base of ${repo}#${number}`)),
    comment: (repo, number, body) => withToken(async (token) => {
      await req('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...splitRepo(repo), issue_number: number, body, headers: headers(token) });
    }, failed(`a comment on ${repo}#${number}`)),
    pullRequestOf: (repo, sha) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', { ...splitRepo(repo), commit_sha: sha, headers: headers(token) })).data as
        { number: number; merge_commit_sha: string | null; merged_at: string | null }[];
      return d.find((p) => p.merged_at !== null && p.merge_commit_sha === sha)?.number;
    }, failed(`the pull request of ${sha.slice(0, 12)} on ${repo}`)),
    revert: (repo, number, text) => withToken(async (token) => {
      const id = ((await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, headers: headers(token) })).data as { node_id: string }).node_id;
      const d = (await req('POST /graphql', { query: REVERT, variables: { id, ...text }, headers: headers(token) })).data as
        { data?: { revertPullRequest?: { revertPullRequest?: { number: number; url: string } | null } | null }; errors?: { message: string }[] };
      const r = d.data?.revertPullRequest?.revertPullRequest;
      if (d.errors?.length || !r) throw new Error(`GitHub did not revert ${repo}#${number}: ${d.errors?.map((e) => e.message).join('; ') ?? 'no pull request in its answer'}`);
      return { number: r.number, url: r.url };
    }, failed(`the revert of ${repo}#${number}`)),
    checkLog: (repo, id) => withToken((token) => jobLog(req, token, repo, id), failed(`the log of the check ${id} on ${repo}`)),
    fileIssue: (repo, issue) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...splitRepo(repo), ...issue, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`a new issue on ${repo}`)),
    bugReports: (repo, sha, since) => withToken(async (token) => {
      // A bug report's context names the hopper's version as `<branch> at <12 characters of the commit>` (src/bug-reports/context.ts).
      const q = `repo:${repo} is:issue label:${REPORT_LABEL} "${sha}" created:>=${since.slice(0, 19)}Z`;
      const d = (await req('GET /search/issues', { q, per_page: 100, headers: headers(token) })).data as { items: { number: number }[] };
      return d.items.map((i) => i.number).sort((a, b) => a - b);
    }, failed(`the bug reports of ${sha} on ${repo}`)),
    fastForward: (repo, branch, sha) => withToken(async (token) => {
      await req('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { ...splitRepo(repo), ref: `heads/${branch}`, sha, force: false, headers: headers(token) });
    }, failed(`the move of ${branch} to ${sha.slice(0, 12)} on ${repo}`)),
  };
}
