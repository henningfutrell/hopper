// Which issues are eligible: open, labelled, assigned to the source's account (issue #387: who filed it
// does not matter), not done/failed/rejected/on the backburner, in an allowed repo, and not addressed to
// another hopper (`hopper@<name>`, issue #159). Claimed issues without a local job are skipped (never re-run
// blind). An issue whose newest job the user rejected is skipped until it is assigned to the account again
// after the rejection — one events read, only for rejected issues. The scope is given: a repo list (the
// app's installed repos, a connected account's chosen repos), listed repo by repo. Never a search: the app
// never passes an empty list, and a connected account's source with none chosen is paused (issue #321).

import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { ADDRESS_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_REJECTED } from './labels.ts';

/**
 * The newest job of an item was rejected (issue #387): when, and the assignee it was taken for. A job
 * taken before assignment intake has none: its issue is left to its labels, as then.
 */
export interface Rejection { at: string; assignee?: string }

export interface DiscoverResult {
  issues: GitHubIssue[];
  repoErrors: Record<string, string>;
  skippedClaimedWithoutJob: string[];
  /** Assigned to the account, and rejected since it was last assigned. */
  skippedRejected: string[];
}

type DiscoverConfig = Pick<GitHubSourceConfig, 'label' | 'hopperName'>;

export interface DiscoverScope {
  repos: string[];
  /** The login an issue must be assigned to. */
  assignee: string;
  knownKeys?: (keys: string[]) => Set<string>;
  rejections?: (keys: string[]) => Map<string, Rejection>;
}

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

/** GitHub logins compare without case. */
export const isAssignedTo = (i: Pick<GitHubIssue, 'assignees'>, login: string): boolean =>
  i.assignees.some((a) => a.toLowerCase() === login.toLowerCase());

function eligible(i: GitHubIssue, config: DiscoverConfig, assignee: string): boolean {
  return i.state === 'open'
    && i.labels.includes(config.label)
    && isAssignedTo(i, assignee)
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

/** The rejected issues not assigned to the account again since their rejection. */
async function stillRejected(api: GitHubApi, issues: GitHubIssue[], scope: DiscoverScope): Promise<Set<string>> {
  const rejected = scope.rejections && issues.length > 0 ? scope.rejections(issues.map((i) => i.url)) : new Map<string, Rejection>();
  const skipped = new Set<string>();
  for (const i of issues) {
    const r = rejected.get(i.url);
    if (!r?.assignee) continue;
    const assigned = await api.assignedAt(i.repo, i.number, scope.assignee);
    if (assigned === undefined || Date.parse(assigned) <= Date.parse(r.at)) skipped.add(i.url);
  }
  return skipped;
}

export async function discoverIssues(api: GitHubApi, config: DiscoverConfig, scope: DiscoverScope): Promise<DiscoverResult> {
  const { issues, repoErrors } = await fetchIssues(api, config, scope.repos);
  const candidates = issues.filter((i) => eligible(i, config, scope.assignee));
  const claimed = candidates.filter((i) => i.labels.includes(LABEL_CLAIMED)).map((i) => i.url);
  const known = scope.knownKeys && claimed.length > 0 ? scope.knownKeys(claimed) : new Set<string>();
  const skipped = claimed.filter((url) => !known.has(url));
  const rejected = await stillRejected(api, candidates, scope);
  return {
    issues: candidates.filter((i) => !skipped.includes(i.url) && !rejected.has(i.url)),
    repoErrors,
    skippedClaimedWithoutJob: skipped,
    skippedRejected: [...rejected],
  };
}
