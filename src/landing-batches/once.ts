// The batch runner's GitHub writes that make something new, each once (issue #1589): a pass records what it is about to
// make before it asks GitHub, so a pass that stops after the call and before its record makes it again on the next pass.
// These find what the stopped pass made — a pull request by its head branch, an issue by its title — before they make one.
import type { LandingBatchGitHub } from './runner.ts';

/** Opens the pull request, or answers the open one from `head` into `base` when GitHub refuses a second one. */
export async function openOnce(gh: LandingBatchGitHub, repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }> {
  try {
    return await gh.openPullRequest(repo, p);
  } catch (e) {
    const open = await gh.openPullRequests(repo, p.base).catch(() => []);
    const found = open.find((x) => x.head === p.head);
    if (found) return { number: found.number, url: found.url };
    throw e;
  }
}

/** Files the issue, or answers the open one of its title and its first label, changed since `since`. */
export async function fileOnce(gh: LandingBatchGitHub, repo: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }, since: string): Promise<{ number: number; url: string }> {
  return await gh.findIssue(repo, { title: issue.title, label: issue.labels[0] ?? '', since }) ?? await gh.fileIssue(repo, issue);
}
