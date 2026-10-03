// Which issues are eligible: open, labelled, by an allowlisted author, not done/failed, in an
// allowed repo. Claimed issues without a local job are skipped (never re-run blind). The scope
// is given: a repo list (gh `repos`, or the app's installed repos) is listed repo by repo; an
// empty one searches over `owners` — gh mode only, the app source never passes an empty list.

import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED } from './labels.ts';

export interface DiscoverResult {
  issues: GitHubIssue[];
  owners: string[];
  repoErrors: Record<string, string>;
  skippedClaimedWithoutJob: string[];
}

type DiscoverConfig = Pick<GitHubSourceConfig, 'label' | 'authors'>;

export interface DiscoverScope {
  repos: string[];
  owners: string[];
}

async function fetchIssues(api: GitHubApi, config: DiscoverConfig, { repos, owners }: DiscoverScope):
Promise<{ issues: GitHubIssue[]; repoErrors: Record<string, string> }> {
  if (repos.length === 0) {
    const found = await api.searchOpenIssues({ owners, label: config.label });
    return { issues: found.filter((i) => owners.includes(i.repo.split('/')[0]!)), repoErrors: {} };
  }
  const issues: GitHubIssue[] = [];
  const repoErrors: Record<string, string> = {};
  let firstError: unknown;
  for (const repo of repos) {
    try {
      issues.push(...(await api.listOpenIssues(repo, config.label)).map((i) => ({ ...i, repo })));
    } catch (err) {
      repoErrors[repo] = (err as Error).message;
      firstError ??= err;
    }
  }
  if (Object.keys(repoErrors).length === repos.length) throw firstError;
  return { issues, repoErrors };
}

function eligible(i: GitHubIssue, config: DiscoverConfig): boolean {
  return i.state === 'open'
    && i.labels.includes(config.label)
    && config.authors.includes(i.author)
    && !i.labels.includes(LABEL_DONE)
    && !i.labels.includes(LABEL_FAILED);
}

export async function discoverIssues(
  api: GitHubApi,
  config: DiscoverConfig,
  scope: DiscoverScope,
  knownKeys: ((keys: string[]) => Set<string>) | undefined,
): Promise<DiscoverResult> {
  const { issues, repoErrors } = await fetchIssues(api, config, scope);
  const candidates = issues.filter((i) => eligible(i, config));
  const claimed = candidates.filter((i) => i.labels.includes(LABEL_CLAIMED)).map((i) => i.url);
  const known = knownKeys && claimed.length > 0 ? knownKeys(claimed) : new Set<string>();
  const skipped = claimed.filter((url) => !known.has(url));
  return {
    issues: candidates.filter((i) => !skipped.includes(i.url)),
    owners: scope.owners,
    repoErrors,
    skippedClaimedWithoutJob: skipped,
  };
}
