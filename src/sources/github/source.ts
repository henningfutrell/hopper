// The GitHub JobSource: open issues labelled `hopper` by allowlisted authors become jobs;
// what happens to them goes back as comments and labels; replies and closes come back as
// signals. `knownKeys` (wired by the sync loop) tells discover which claimed issues already have
// a local job; without it every claimed issue is skipped, so nothing is ever re-run blind.

import type { Clock, JobSource, SourceItem } from '../../domain/ports.ts';
import { TERMINAL_STATUSES } from '../../domain/types.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { checkJobs } from './check.ts';
import { contextBlock, contextComments, issueEnv, issuePrompt } from './context.ts';
import { discoverIssues } from './discover.ts';
import { priorityOf, readProjects } from './priority.ts';
import { reportToGitHub } from './report.ts';

export interface GitHubSourceOptions {
  name: string;
  config: GitHubSourceConfig;
  api: GitHubApi;
  clock: Clock;
  /** The gh user, when already known (skips `whoami`). */
  whoami?: string;
  /** Which of these source keys already have a local job. */
  knownKeys?: (keys: string[]) => Set<string>;
}

export function createGitHubSource(o: GitHubSourceOptions): JobSource {
  const { config, api } = o;
  let login = o.whoami;
  let owners = config.owners;
  let repoErrors: Record<string, string> = {};
  let projectErrors: Record<string, string> = {};
  let checkErrors: Record<string, string> = {};
  let skippedClaimedWithoutJob: string[] = [];
  let lastDiscoverAt: string | undefined;
  const labelledRepos = new Set<string>();

  const resolveOwners = async (): Promise<string[]> => {
    if (config.owners.length > 0 || config.repos.length > 0) return config.owners;
    login ??= await api.whoami();
    return [login];
  };

  const toItem = async (issue: GitHubIssue, known: Set<string>, p: ReturnType<typeof priorityOf>): Promise<SourceItem> => {
    const comments = known.has(issue.url) || config.recentComments === 0 ? [] : await api.listComments(issue.repo, issue.number);
    const context = contextBlock(issue, p, contextComments(comments, config.authors, config.recentComments), config.recentComments);
    return {
      key: issue.url, url: issue.url, title: issue.title, body: issue.body,
      prompt: issuePrompt(issue, context), env: issueEnv(issue),
      author: issue.author, priority: p.priority, priorityReason: p.reason,
      cwd: config.repoPaths[issue.repo] ?? config.defaultCwd,
      labels: issue.labels, repo: issue.repo, number: issue.number,
      executor: config.executor,
      ...(config.model ? { model: config.model } : {}),
      ...(issue.body.trim() === '' ? { invalid: 'empty issue body' } : {}),
    };
  };

  return {
    name: o.name,
    kind: 'github',
    describe() {
      return {
        owners, repos: config.repos, authors: config.authors, label: config.label, projectErrors,
        ...(skippedClaimedWithoutJob.length ? { skippedClaimedWithoutJob } : {}),
        ...(Object.keys(repoErrors).length ? { repoErrors } : {}),
        ...(Object.keys(checkErrors).length ? { checkErrors } : {}),
        ...(lastDiscoverAt ? { lastDiscoverAt } : {}),
      };
    },
    async discover() {
      owners = await resolveOwners();
      const found = await discoverIssues(api, config, owners, o.knownKeys);
      repoErrors = found.repoErrors;
      skippedClaimedWithoutJob = found.skippedClaimedWithoutJob;
      const projects = await readProjects(api, config, found.issues);
      projectErrors = projects.errors;
      const known = o.knownKeys && found.issues.length > 0 ? o.knownKeys(found.issues.map((i) => i.url)) : new Set<string>();
      const items: SourceItem[] = [];
      for (const issue of found.issues) items.push(await toItem(issue, known, priorityOf(issue, config, projects.views.get(issue.repo))));
      lastDiscoverAt = o.clock.now().toISOString();
      return items;
    },
    async check(active) {
      const mine = active.filter((j) => j.source?.source === o.name && !TERMINAL_STATUSES.includes(j.status));
      const r = await checkJobs(api, config, mine);
      checkErrors = r.errors;
      return r.signals;
    },
    report(r) {
      return reportToGitHub({ api, labelledRepos }, r);
    },
  };
}
