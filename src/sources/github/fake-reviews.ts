// The in-memory GitHub's pull request reviews (issue #1694 part 3, fake.ts): the reviews a test set for a pull request,
// oldest first; never set: none.
import type { GitHubApi, PullRequestReview } from './api.ts';

type FakeReviewMethods = Required<Pick<GitHubApi, 'pullRequestReviews'>> & {
  /** The reviews of pull request `number` of `repo`, oldest first, as GitHub answers them. */
  setReviews(repo: string, number: number, reviews: PullRequestReview[]): void;
};

export function fakeReviews(enter: (method: 'pullRequestReviews', args: unknown[]) => void): FakeReviewMethods {
  const reviews = new Map<string, PullRequestReview[]>();
  return {
    async pullRequestReviews(repo, number) {
      enter('pullRequestReviews', [repo, number]);
      return (reviews.get(`${repo}#${number}`) ?? []).map((r) => ({ ...r }));
    },
    setReviews(repo, number, list) { reviews.set(`${repo}#${number}`, list.map((r) => ({ ...r }))); },
  };
}
