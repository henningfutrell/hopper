// Repos the account reaches outside the scope with open labelled issues for the user that would be taken there (issue
// #440): only suggested in Sources, never added. A connected account only (the app has no user), read with each listing
// of the scope (issue #985); with no scope at all, nothing is read.
import type { OutsideRepo } from '../../domain/intake.ts';
import type { GitHubSourceConfig } from '../config.ts';
import type { GitHubApi } from './api.ts';
import { isAssignedTo, labelReason } from './discover.ts';

export function outsideReader(api: Pick<GitHubApi, 'listAssignedIssues'>, config: Pick<GitHubSourceConfig, 'label' | 'hopperName'>) {
  let repos: OutsideRepo[] = [];
  let error: string | undefined;
  return {
    async read(scope: string[], assignee: string): Promise<void> {
      if (!api.listAssignedIssues || scope.length === 0) return;
      try {
        const inScope = new Set(scope.map((r) => r.toLowerCase()));
        const byRepo = new Map<string, string[]>();
        for (const i of await api.listAssignedIssues(config.label)) {
          if (inScope.has(i.repo.toLowerCase()) || !isAssignedTo(i, assignee) || labelReason(i, config.hopperName)) continue;
          byRepo.set(i.repo, [...(byRepo.get(i.repo) ?? []), i.url]);
        }
        repos = [...byRepo].map(([repo, items]) => ({ repo, items })).sort((a, b) => a.repo.localeCompare(b.repo));
        error = undefined;
      } catch (err) {
        error = (err as Error).message;
      }
    },
    /** What `describe` shows of them. */
    detail: () => ({ ...(repos.length ? { outsideRepos: repos } : {}), ...(error ? { outsideError: error } : {}) }),
  };
}
