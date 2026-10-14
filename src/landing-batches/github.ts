// The batch runner's GitHub calls (issue #1073), with the user's own GitHub connection: the default branch (the landing
// branch), a compare of the tested branch with it, a batch run's branch made and removed, its pull request opened, read,
// merged at its tip or closed, its check runs, and a job's open pull request moved to another base. The same
// `@octokit/request` binding and token renewal as Promote to GitHub (src/promotions/github.ts).
import type { BatchCheckRun } from '../domain/landing-batches.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, paginate, splitRepo, statusOf } from '../sources/github/app/http.ts';
import type { LandingBatchGitHub } from './runner.ts';

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
    defaultBranch: (repo) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}', { ...splitRepo(repo), headers: headers(token) })).data as { default_branch: string };
      return d.default_branch;
    }, failed(`the repository ${repo}`)),
    compare: (repo, base, head) => withToken(async (token) => {
      // The tip first, so the compare is of that commit even when the branch moves meanwhile.
      const tip = ((await req('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...splitRepo(repo), ref: `heads/${head}`, headers: headers(token) })).data as { object: { sha: string } }).object.sha;
      const d = (await req('GET /repos/{owner}/{repo}/compare/{basehead}', { ...splitRepo(repo), basehead: `${base}...${tip}`, per_page: 250, headers: headers(token) })).data as
        { ahead_by: number; commits: { commit: { message: string } }[] };
      return { aheadBy: d.ahead_by, tip, messages: d.commits.map((c) => c.commit.message) };
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
        { state: string; merged: boolean; mergeable: boolean | null; head: { sha: string }; base: { ref: string }; html_url: string };
      return { state: d.state === 'closed' ? 'closed' : 'open', merged: d.merged, mergeable: d.mergeable, headSha: d.head.sha, base: d.base.ref, url: d.html_url };
    }, failed(`${repo}#${number}`)),
    checkRuns: (repo, sha) => withToken(async (token) => {
      const runs = await paginate<{ name: string; status: string; conclusion: string | null }>(req, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
        { ...splitRepo(repo), ref: sha, per_page: 100 }, `token ${token}`, (data) => (data as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs);
      return runs.map((r): BatchCheckRun => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
    }, failed(`the checks of ${sha.slice(0, 12)} on ${repo}`)),
    merge: (repo, number, sha, title) => withToken(async (token) => {
      const d = (await req('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...splitRepo(repo), pull_number: number, sha, merge_method: 'merge', commit_title: title, headers: headers(token) })).data as { sha: string };
      return { sha: d.sha };
    }, failed(`the merge of ${repo}#${number}`)),
    close: (repo, number) => withToken(async (token) => {
      await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, state: 'closed', headers: headers(token) });
    }, failed(`the close of ${repo}#${number}`)),
    openPullRequests: (repo, base) => withToken(async (token) => {
      const pulls = await paginate<{ number: number; html_url: string }>(req, 'GET /repos/{owner}/{repo}/pulls', { ...splitRepo(repo), state: 'open', base, per_page: 100 }, `token ${token}`,
        (data) => data as { number: number; html_url: string }[]);
      return pulls.map((p) => ({ number: p.number, url: p.html_url }));
    }, failed(`the open pull requests on ${base} of ${repo}`)),
    retarget: (repo, number, base) => withToken(async (token) => {
      await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, base, headers: headers(token) });
    }, failed(`the base of ${repo}#${number}`)),
  };
}
