// The items jobs' waits name (issue #1508, `JobSource.endedWatched`, domain/watched-items.ts): each read by its number. A
// number is a pull request or an issue: the pull request read first, then the issue. A run is read through Actions. One
// GitHub does not know, or whose read throws, is logged and left out: asked again at the next sync.
import type { WatchedEnd, WatchedRef } from '../../domain/watched-items.ts';
import type { GitHubApi } from './api.ts';

async function endOf(api: Pick<GitHubApi, 'pullRequest' | 'getIssue' | 'workflowRun'>, ref: WatchedRef): Promise<WatchedEnd | undefined> {
  if (ref.kind === 'run') {
    if (!api.workflowRun) return undefined;
    const run = await api.workflowRun(ref.repo, ref.runId);
    return run.status === 'completed' ? { ref, url: run.url, state: run.conclusion ?? 'completed' } : undefined;
  }
  const pr = await api.pullRequest(ref.repo, ref.number);
  if (pr) return pr.state === 'open' ? undefined : { ref, url: pr.url, state: pr.state };
  const issue = await api.getIssue(ref.repo, ref.number);
  return issue.state === 'closed' ? { ref, url: issue.url, state: 'closed' } : undefined;
}

export async function endedWatched(api: Pick<GitHubApi, 'pullRequest' | 'getIssue' | 'workflowRun'>, refs: WatchedRef[]): Promise<WatchedEnd[]> {
  const ended: WatchedEnd[] = [];
  for (const ref of refs) {
    try {
      const e = await endOf(api, ref);
      if (e) ended.push(e);
    } catch (e) {
      const what = ref.kind === 'run' ? `run ${ref.runId} of ${ref.repo}` : `${ref.repo}#${ref.number}`;
      console.warn(`hopper: the waited ${what} was not read, asked again at the next sync: ${(e as Error).message}`);
    }
  }
  return ended;
}
