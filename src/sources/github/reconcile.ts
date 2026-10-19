// Reconciling done jobs with GitHub (issue #763, design.md "PR waiting"): a done job that follows no pull request — it
// ended before the hopper followed pull requests, or its follow ended — whose issue is open and has an open pull request
// in its repository is answered that pull request, so the sync loop follows it from now on: the Pull requests list shows it,
// yolo mode merges it, and tending tends it. The open pull requests of every such repository in one batched read (issue
// #985, `openPullRequestsIn`), never one listing for each; the issue is read only for a match. A repository GitHub does not
// answer for is logged and asked again at the next reconcile; when none answers, it throws. The pull request: the newest that closes the issue by a closing keyword, else the newest that ships part of it
// ("Part of #N"), else the newest on a branch named for it.
// A pull request is followed to its end, whatever its issue (issue #786): an issue closed as completed — closed from under
// its open part, or by another pull request — still has its open pull request followed, if that one closes it by keyword
// or ships a part of it. One named for it only on its branch is not: the issue is done, and that branch may be stale. An
// issue closed as not planned has none followed. A pull request from a release branch or a batch run's branch is no issue's
// work (`fromReleaseBranch`, issue #2132): a batch run's text closes the issues it carries, and it is never followed.
import type { FoundPullRequest, Job } from '../../domain/types.ts';
import type { BranchPullRequest, GitHubApi } from './api.ts';
import { closesByKeyword, fromReleaseBranch, namesIssue } from './completion.ts';

const partOf = (body: string, n: number): boolean => new RegExp(`\\bpart of #${n}\\b`, 'i').test(body);

/**
 * The issue's open pull request in `prs` (newest first), and whether it ships a part; undefined: none. `byText`: only one
 * whose text names the issue, not one named for it only on its branch.
 */
function pullRequestFor(prs: BranchPullRequest[], repo: string, n: number, byText = false): { url: string; part: boolean } | undefined {
  const closing = prs.find((pr) => !partOf(pr.body, n) && closesByKeyword(pr.body, repo, n));
  if (closing) return { url: closing.url, part: false };
  const part = prs.find((pr) => partOf(pr.body, n));
  if (part) return { url: part.url, part: true };
  if (byText) return undefined;
  const branch = prs.find((pr) => namesIssue(pr.headRef, n));
  return branch && { url: branch.url, part: false };
}

/** Of `jobs`, the ones whose issue is open, or closed as completed, and has an open pull request, with it. A GitHub error throws. */
export async function unfollowedPullRequests(api: GitHubApi, jobs: Job[]): Promise<FoundPullRequest[]> {
  const byRepo = new Map<string, Job[]>();
  for (const j of jobs) {
    const repo = j.source?.repo;
    if (repo && j.source?.number) byRepo.set(repo, [...(byRepo.get(repo) ?? []), j]);
  }
  const found: FoundPullRequest[] = [];
  if (byRepo.size === 0) return found;
  const open = await api.openPullRequestsIn([...byRepo.keys()]);
  if (open.repos.size === 0 && open.repoErrors.size > 0) throw new Error([...open.repoErrors].map(([r, e]) => `${r}: ${e}`).join('; '));
  for (const [repo, error] of open.repoErrors) console.warn(`hopper: reconciling the pull requests of ${repo} failed, asked again at the next reconcile: ${error}`);
  for (const [repo, js] of byRepo) {
    const answered = open.repos.get(repo);
    if (!answered) continue;
    const prs = answered.filter((pr) => !fromReleaseBranch(pr)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const j of js) {
      if (!pullRequestFor(prs, repo, j.source!.number!)) continue;
      const issue = await api.getIssue(repo, j.source!.number!);
      const pr = issue.state === 'open' ? pullRequestFor(prs, repo, j.source!.number!)
        : issue.stateReason === 'completed' ? pullRequestFor(prs, repo, j.source!.number!, true) : undefined;
      if (pr) found.push({ jobId: j.id, pullRequest: pr.url, part: pr.part });
    }
  }
  return found;
}
