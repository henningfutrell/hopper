// Which issues are eligible: open, labelled, by an allowlisted author, not done/failed/rejected/on the
// backburner, in an allowed repo, and not addressed to another hopper (`hopper@<name>`, issue #159). Claimed issues without a local job are skipped (never re-run blind). The scope
// is given: a repo list (gh `repos`, or the app's installed repos) is listed repo by repo; an
// empty one searches over `owners` (none: anywhere, by the allowlisted authors) — never in app mode,
// which never passes an empty list.

import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { ADDRESS_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED } from './labels.ts';

export interface DiscoverResult {
  issues: GitHubIssue[];
  owners: string[];
  repoErrors: Record<string, string>;
  skippedClaimedWithoutJob: string[];
}

type DiscoverConfig = Pick<GitHubSourceConfig, 'label' | 'authors' | 'hopperName'>;

export interface DiscoverScope {
  repos: string[];
  owners: string[];
}

async function fetchIssues(api: GitHubApi, config: DiscoverConfig, { repos, owners }: DiscoverScope):
Promise<{ issues: GitHubIssue[]; repoErrors: Record<string, string> }> {
  if (repos.length === 0) {
    const found = await api.searchOpenIssues({ owners, label: config.label, authors: config.authors });
    // No owners (a connected account's source, issue #214): wherever the allowlisted authors' issues are.
    return { issues: owners.length === 0 ? found : found.filter((i) => owners.includes(i.repo.split('/')[0]!)), repoErrors: {} };
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
