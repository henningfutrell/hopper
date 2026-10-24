// Companion pull requests (issue #1143 reopened, design.md "Companion pull requests"), GitHub's half: each is read by its
// number — its state, its merge conflicts with its base (the hopper's mirror's answer where it has one, else GitHub's), and
// its base and head branch. One GitHub does not know, or whose read throws, is logged and left out: asked again at the next round.
import type { CompanionRead } from '../../domain/companion-pull-requests.ts';
import type { GitHubApi } from './api.ts';

export async function readCompanions(api: GitHubApi, pulls: { repo: string; number: number }[]): Promise<CompanionRead[]> {
  const read: CompanionRead[] = [];
  for (const { repo, number } of pulls) {
    try {
      const pr = await api.pullRequest(repo, number);
      if (pr) read.push({ url: pr.url, state: pr.state, conflicting: pr.state === 'open' && pr.conflicting, ...(pr.base ? { base: pr.base } : {}), ...(pr.headRef ? { headRef: pr.headRef } : {}) });
    } catch (e) {
      console.warn(`hopper: the companion pull request ${repo}#${number} was not read, asked again at the next round: ${(e as Error).message}`);
    }
  }
  return read;
}
