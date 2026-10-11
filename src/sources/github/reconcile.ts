// Reconciling done jobs with GitHub (issue #763, design.md "PR waiting"): a done job that follows no pull request — it
// ended before the hopper followed pull requests, or its follow ended — whose issue is open and has an open pull request
// in its repository is answered that pull request, so the sync loop follows it from now on: the Pull requests list shows it,
// yolo mode merges it, and tending tends it. One listing of open pull requests per repository; the issue is read only for
// a match. The pull request: the newest that closes the issue by a closing keyword, else the newest that ships part of it
// ("Part of #N"), else the newest on a branch named for it.
import type { FoundPullRequest, Job } from '../../domain/types.ts';
import type { BranchPullRequest, GitHubApi } from './api.ts';
import { closesByKeyword, namesIssue } from './completion.ts';

const partOf = (body: string, n: number): boolean => new RegExp(`\\bpart of #${n}\\b`, 'i').test(body);

/** The issue's open pull request in `prs` (newest first), and whether it ships a part; undefined: none. */
function pullRequestFor(prs: BranchPullRequest[], repo: string, n: number): { url: string; part: boolean } | undefined {
  const closing = prs.find((pr) => !partOf(pr.body, n) && closesByKeyword(pr.body, repo, n));
  if (closing) return { url: closing.url, part: false };
  const part = prs.find((pr) => partOf(pr.body, n));
  if (part) return { url: part.url, part: true };
  const branch = prs.find((pr) => namesIssue(pr.headRef, n));
  return branch && { url: branch.url, part: false };
}

/** Of `jobs`, the ones whose issue is open and has an open pull request, with it. A GitHub error throws. */
export async function unfollowedPullRequests(api: GitHubApi, jobs: Job[]): Promise<FoundPullRequest[]> {
  const byRepo = new Map<string, Job[]>();
  for (const j of jobs) {
    const repo = j.source?.repo;
    if (repo && j.source?.number) byRepo.set(repo, [...(byRepo.get(repo) ?? []), j]);
  }
  const found: FoundPullRequest[] = [];
  for (const [repo, js] of byRepo) {
    const prs = [...await api.openPullRequests(repo)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const j of js) {
      const pr = pullRequestFor(prs, repo, j.source!.number!);
      if (pr && (await api.getIssue(repo, j.source!.number!)).state === 'open') found.push({ jobId: j.id, pullRequest: pr.url, part: pr.part });
    }
  }
  return found;
}
