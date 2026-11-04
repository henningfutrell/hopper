// Head branch deletion of one source (issue #2914, design.md "Head branch deletion"): each deletion is a row of the GitHub
// outbox, keyed by its pull request's URL, kept once per pull request — at the record of a merge (`merged`), and by the sweep
// (`sweep`), which lists the branches of the job repositories — so a stop anywhere leaves a row, or a stale branch the next
// sweep finds. The send reads the pull request and the branch again, and deletes only what is still safe; a kept branch is left. Deleting a branch already gone changes nothing, so a second send does no harm.
import { HEAD_BRANCH_SWEEP_ROWS, headBranchKept, pullBranchKept, staleHeadBranches } from '../../domain/head-branches.ts';
import type { OutboxChange } from '../../domain/github-outbox.ts'; import { pullRequestRepo } from '../../domain/pull-requests.ts';
import { killPoint } from '../../sagas/kill-points.ts';
import type { GitHubApi } from './api.ts';
import type { GitHubOutbox } from './outbox.ts';

type Deletion = Extract<OutboxChange, { op: 'delete_head_branch' }>;

export type HeadBranches = ReturnType<typeof createHeadBranches>;

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

export function createHeadBranches(o: {
  api: Pick<GitHubApi, 'headBranchPull' | 'branchFacts' | 'deleteBranch' | 'branchRefs'>;
  outbox: Pick<GitHubOutbox, 'keepOnce'>;
  clock: { now(): Date };
  /** A repository's setting, read at each call, and its landing and tested branches. Absent: the hopper deletes nothing. */
  settings?: (repo: string) => { on: boolean; keep: string[] };
  record?: (type: 'head_branch.deleted', data: Record<string, unknown>) => void;
  source?: string;
}) {
  const { api } = o;
  const keep = (repo: string, url: string, via: Deletion['via']): boolean =>
    o.outbox.keepOnce('head_branch', url, repo, { op: 'delete_head_branch', pullRequest: url, via });

  return {
    /** Pull request `url` merged: its head branch's row, before the merge is recorded, so a stop between them loses neither. */
    merged(url: string): void {
      const repo = pullRequestRepo(url, '');
      if (repo && o.settings?.(repo).on) keep(repo, url, 'merge');
    },
    /**
     * Keeps a row for each stale branch of `repos`, at most `limit`. A repository GitHub does not answer for is tried at the next
     * sweep. False: no repository to read yet (before the first discover).
     */
    async sweep(repos: readonly string[], facts: { live(url: string): boolean }, limit = HEAD_BRANCH_SWEEP_ROWS): Promise<boolean> {
      let left = limit;
      for (const repo of repos) {
        const cfg = o.settings?.(repo);
        if (!cfg?.on || !api.branchRefs) continue;
        try {
          let after: string | undefined;
          do {
            const page = await api.branchRefs(repo, after);
            const stale = staleHeadBranches(page.refs, { now: o.clock.now().getTime(), defaultBranch: page.defaultBranch, keep: cfg.keep });
            for (const s of stale) {
              if (left > 0 && !facts.live(s.pullRequest) && keep(repo, s.pullRequest, 'sweep')) left--;
            }
            after = page.after;
          } while (after !== undefined && left > 0);
        } catch (e) {
          console.warn(`hopper: the head branches of ${repo} were not read, read again at the next sweep: ${(e as Error).message}`);
        }
        if (left === 0) break;
      }
      return repos.length > 0;
    },
    /** The row's send: reads the pull request and its branch, and deletes the branch unless something keeps it. */
    async send(repo: string, change: Deletion): Promise<void> {
      const cfg = o.settings?.(repo);
      if (!cfg?.on || !api.headBranchPull || !api.branchFacts || !api.deleteBranch) return;
      const pr = await api.headBranchPull(repo, numberOf(change.pullRequest));
      if (!pr) return;
      const pullKept = pullBranchKept(pr, cfg.keep);
      const branch = pullKept ? undefined : await api.branchFacts(repo, pr.headRef);
      if (!pullKept && !branch) return;
      const kept = pullKept ?? headBranchKept(pr, branch!);
      if (kept) return;
      await api.deleteBranch(repo, pr.headRef);
      killPoint('head_branch:after-delete');
      o.record?.('head_branch.deleted', { repo, branch: pr.headRef, pullRequest: change.pullRequest, head: pr.headOid, via: change.via, source: o.source ?? '' });
    },
  };
}
