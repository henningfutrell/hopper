// A pull request's end in the node:http fake GitHub (issue #985 part 4): merged — by the hopper's PUT …/pulls/{n}/merge or
// by a person on GitHub (a test) — or closed without a merge. Every place the fake tells of it changes together: the pull
// request's own entry (the listings and the batched reads), the issues it closes or mentions (the follow's reads), and an
// issue its body closes ("Closes #N"), closed as completed by it. Test support only: the daemon never imports it.
import type { FakeRepo } from './fake-state.ts';

export function endPull(repo: FakeRepo, number: number, end: 'MERGED' | 'CLOSED', at: string): boolean {
  const pr = repo.issues.get(number);
  if (!pr?.pullRequest || pr.state !== 'open') return false;
  const url = `https://github.com/${repo.owner}/${repo.name}/pull/${number}`;
  pr.state = 'closed';
  pr.updatedAt = at;
  pr.pull = { ...pr.pull, state: end };
  for (const issue of repo.issues.values()) {
    const opened = issue.openPullRequests.find((p) => p.url === url);
    issue.openPullRequests = issue.openPullRequests.filter((p) => p.url !== url);
    for (const m of issue.mentionedBy) if (m.url === url) Object.assign(m, { state: end }, end === 'MERGED' ? { mergedAt: at } : {});
    const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${issue.number}\\b`, 'i').test(pr.body);
    if (end === 'MERGED' && closes && issue.state === 'open') {
      Object.assign(issue, { state: 'closed', stateReason: 'completed', closedAt: at, updatedAt: at, closedByPullRequest: { url, createdAt: opened?.createdAt ?? pr.pull.createdAt ?? at, mergedAt: at } });
    }
  }
  return true;
}
