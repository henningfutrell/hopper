// Which issues are eligible: open, labelled, by an allowlisted author, not done/failed/rejected/on the
// backburner, in an allowed repo, and not addressed to another hopper (`hopper@<name>`, issue #159). Claimed issues without a local job are skipped (never re-run blind). The scope
// is given: a repo list (the app's installed repos, a connected account's chosen repos), listed repo by
// repo. Never a search: the app never passes an empty list, and a connected account's source with none
// chosen is paused (issue #321).

import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { ADDRESS_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED } from './labels.ts';

export interface DiscoverResult {
  issues: GitHubIssue[];
  /** Every open labelled issue listed, eligible or not: one listed is open (issue #362). */
  listed: string[];
  repoErrors: Record<string, string>;
  skippedClaimedWithoutJob: string[];
}

type DiscoverConfig = Pick<GitHubSourceConfig, 'label' | 'authors' | 'hopperName'>;

async function fetchIssues(api: GitHubApi, config: DiscoverConfig, repos: string[]):
Promise<{ issues: GitHubIssue[]; repoErrors: Record<string, string> }> {
  if (repos.length === 0) return { issues: [], repoErrors: {} };
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
    && !i.labels.includes(LABEL_FAILED)
    && !i.labels.includes(LABEL_BACKBURNER)
    && !i.labels.includes(LABEL_REJECTED)
    && forThisHopper(i, config.hopperName);
}

/** An issue addressed to hoppers by name goes to those only; an unaddressed one to any. */
function forThisHopper(i: GitHubIssue, name: string | null): boolean {
  const addressed = i.labels.filter((l) => l.startsWith(ADDRESS_PREFIX)).map((l) => l.slice(ADDRESS_PREFIX.length));
  return addressed.length === 0 || (name !== null && addressed.includes(name));
}

export async function discoverIssues(
  api: GitHubApi,
  config: DiscoverConfig,
  repos: string[],
  knownKeys: ((keys: string[]) => Set<string>) | undefined,
): Promise<DiscoverResult> {
  const { issues, repoErrors } = await fetchIssues(api, config, repos);
  const candidates = issues.filter((i) => eligible(i, config));
  const claimed = candidates.filter((i) => i.labels.includes(LABEL_CLAIMED)).map((i) => i.url);
  const known = knownKeys && claimed.length > 0 ? knownKeys(claimed) : new Set<string>();
  const skipped = claimed.filter((url) => !known.has(url));
  return {
    issues: candidates.filter((i) => !skipped.includes(i.url)),
    listed: issues.map((i) => i.url),
    repoErrors,
    skippedClaimedWithoutJob: skipped,
  };
}
