// The batch runner's GitHub writes that make something new, each once (issue #1589): a pass records what it is about to
// make before it asks GitHub, so a pass that stops after the call and before its record makes it again on the next pass.
// These find what the stopped pass made — a pull request by its head branch, an issue by its title — before they make one.
// The crash harness (issue #1954, design.md "The crash harness" part 8) ends the process after each write, before its event.
import { killPoint } from '../sagas/kill-points.ts';
import type { LandingBatchGitHub } from './runner.ts';

/** The batch runner's GitHub writes. */
export const LANDING_WRITES = [
  'createBranch', 'deleteBranch', 'openPullRequest', 'merge', 'close', 'mergeInto', 'retarget', 'comment', 'revert', 'fileIssue', 'fastForward',
] as const satisfies readonly (keyof LandingBatchGitHub)[];

/** The kill point once GitHub answered `write`, before the pass records its event. */
export const landingKillPoint = (write: (typeof LANDING_WRITES)[number]): string => `landing:${write}:after-call`;

/** `gh`, with a kill point after each of its writes. */
export function withKillPoints(gh: LandingBatchGitHub): LandingBatchGitHub {
  const out: Record<string, unknown> = { ...gh };
  for (const write of LANDING_WRITES) {
    const call = gh[write] as (...a: unknown[]) => Promise<unknown>;
    out[write] = async (...a: unknown[]) => {
      const answer = await call.apply(gh, a);
      killPoint(landingKillPoint(write));
      return answer;
    };
  }
  return out as unknown as LandingBatchGitHub;
}

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
