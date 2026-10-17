// The census of open pull requests (issue #1176, design.md "Untracked pull requests"): in a round of every follow, after
// reconciling and the strays, the source reads the open pull requests of every job repository it scanned in one batch
// (`openPullRequestsIn`) and keeps the untracked ones (`untrackedPullRequests`), each with its reason, for Sources and the
// Pull requests list. One on a base from before the landing branch, of an item the ledger holds, on a branch named for
// its issue (a job's), is moved to the landing branch, said on it with the follow's note. A repository GitHub does not
// answer for keeps what was last read of it; a move GitHub refuses is logged and tried at the next round. A second pull request
// of an item (its job follows another one) on a job's branch with merge conflicts is closed, said on it (issue #1208): the
// hopper tends only the followed one, and a tend of the second would take the follow off it.
import { takenIntoIntake, untrackedPullRequests, type CensusFacts, type UntrackedPullRequest } from '../../domain/untracked-pull-requests.ts';
import type { IntakeWriteBehind } from '../../domain/intake.ts';
import type { GitHubApi } from './api.ts';
import { namesIssue } from './completion.ts';
import { retargetNote, secondPullRequestNote } from './pr-notes.ts';

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

export function pullRequestCensus(api: Pick<GitHubApi, 'openPullRequestsIn' | 'retarget' | 'postComment' | 'closeWithoutMerge'>, landing: (repo: string) => string | undefined) {
  let byRepo = new Map<string, UntrackedPullRequest[]>();
  let errors: Record<string, string> = {};

  /** Move a job's untracked pull request on a base from before to the landing branch; undefined: it stays. */
  async function retargeted(u: UntrackedPullRequest, headRef: string): Promise<UntrackedPullRequest> {
    const to = landing(u.repo);
    if (u.reason !== 'wrong_base' || !to || !u.base || !u.issue || !namesIssue(headRef, u.issue.number)) return u;
    try {
      await api.retarget(u.repo, numberOf(u.url), to);
    } catch (e) {
      console.warn(`hopper: moving the untracked pull request ${u.url} to ${to} failed, tried again at the next round: ${(e as Error).message}`);
      return u;
    }
    await api.postComment(u.repo, numberOf(u.url), retargetNote(u.base, to)).catch(() => undefined);
    return { ...u, base: to, reason: u.followed ? 'second_pull_request' : 'not_by_a_job', retargeted: { from: u.base, to } };
  }

  /**
   * Close a second pull request on a job's branch with merge conflicts (issue #1208); true: closed. Not one just moved: its
   * merge conflicts were read against the base from before.
   */
  async function closedAsSecond(u: UntrackedPullRequest, pr: { headRef: string; conflicting: boolean }): Promise<boolean> {
    if (u.reason !== 'second_pull_request' || !u.followed || u.retargeted || !pr.conflicting || !u.issue || !namesIssue(pr.headRef, u.issue.number)) return false;
    try {
      await api.closeWithoutMerge(u.repo, numberOf(u.url));
    } catch (e) {
      console.warn(`hopper: closing the second pull request ${u.url} failed, tried again at the next round: ${(e as Error).message}`);
      return false;
    }
    await api.postComment(u.repo, numberOf(u.url), secondPullRequestNote(numberOf(u.followed))).catch(() => undefined);
    return true;
  }

  return {
    /** Read the open pull requests of `repos` and keep the untracked ones. A throw keeps what was read before. */
    async read(repos: string[], facts: Omit<CensusFacts, 'landing'>): Promise<void> {
      if (repos.length === 0) { byRepo = new Map(); errors = {}; return; }
      const open = await api.openPullRequestsIn(repos);
      const next = new Map<string, UntrackedPullRequest[]>();
      const nextErrors: Record<string, string> = {};
      for (const repo of repos) {
        const prs = open.repos.get(repo);
        if (prs === undefined) {
          nextErrors[repo] = open.repoErrors.get(repo) ?? 'not answered';
          const before = byRepo.get(repo);
          if (before) next.set(repo, before);
          continue;
        }
        const byUrl = new Map(prs.map((p) => [p.url, p]));
        const found = untrackedPullRequests(repo, prs, { ...facts, landing });
        const kept = await Promise.all(found.map(async (u) => {
          const pr = byUrl.get(u.url);
          const moved = await retargeted(u, pr?.headRef ?? '');
          return pr && await closedAsSecond(moved, pr) ? [] : [moved];
        }));
        next.set(repo, kept.flat());
      }
      byRepo = next;
      errors = nextErrors;
    },
    /** Take into Intake went through on GitHub for this issue (issue #1238): its pull request is offered no more. */
    takenIn(issueUrl: string): void {
      for (const [repo, us] of byRepo) byRepo.set(repo, us.map((u) => (u.issue?.url === issueUrl && u.offer === 'take_in' ? takenIntoIntake(u, landing(repo)) : u)));
    },
    /** The issues the last census offers to Intake (`take_in`), each with the untracked pull request that closes it, by URL. */
    takeIn: (): Map<string, UntrackedPullRequest> =>
      new Map([...byRepo.values()].flat().flatMap((u) => (u.offer === 'take_in' && u.issue ? [[u.issue.url, u] as const] : []))),
    /**
     * What `describe` shows: the untracked pull requests, by repository and number, each with its issue's write-behind
     * (`writeBehindOf`, issue #1194), and the repositories not read.
     */
    detail: (writeBehindOf: (issueUrl: string) => IntakeWriteBehind | undefined = () => undefined) => {
      const all = [...byRepo.values()].flat().map((u) => {
        const w = u.issue ? writeBehindOf(u.issue.url) : undefined;
        return w ? { ...u, writeBehind: w } : u;
      });
      return { ...(all.length ? { untrackedPullRequests: all } : {}), ...(Object.keys(errors).length ? { untrackedErrors: errors } : {}) };
    },
  };
}
