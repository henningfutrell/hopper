// The batch the follows read first (issue #985, the in-motion cycle, `JobSource.readFollowed`): the open pull requests that
// a round's jobs follow, and their issues, in one batched read (`pullRequestStates`). Each answer is taken once, by the
// follow of its pull request (`follow.ts`); a new round replaces what is left. Kept in memory, for one round only.
import { following, type Job } from '../../domain/types.ts';
import { pullKey, type GitHubApi, type PullRequestRef, type PullRequestState } from './api.ts';

const pullOf = (url: string): { repo: string; number: number } | undefined => {
  const m = /([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

export function followedBatch(api: GitHubApi) {
  let kept = new Map<string, PullRequestState>();
  return {
    /** Read the pull requests `jobs` follow, of their own repositories, in one batch: none followed is no read. */
    async read(jobs: Job[]): Promise<void> {
      kept = new Map();
      const refs = jobs.flatMap((j): PullRequestRef[] => {
        const url = (j.sourceState?.source as { pullRequest?: string } | undefined)?.pullRequest;
        const pr = url ? pullOf(url) : undefined;
        const { repo, number } = j.source ?? {};
        return following(j) && pr && repo && number && pr.repo.toLowerCase() === repo.toLowerCase() ? [{ repo, pullRequest: pr.number, issue: number }] : [];
      });
      if (refs.length > 0) kept = (await api.pullRequestStates(refs)).pulls;
    },
    /** The batch's answer for pull request `number` of `repo`, taken: a second ask is undefined. */
    take(repo: string, number: number): PullRequestState | undefined {
      const k = pullKey(repo, number);
      const answer = kept.get(k);
      kept.delete(k);
      return answer;
    },
  };
}
