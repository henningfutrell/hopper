// The in-memory GitHub's answer to an issue's place (issue #437, fake.ts): its owner (of no known type), the Projects
// whose items name it, the pull requests that close it or mention it, its parent and its sub-issues, and why each closed.
import type { IssuePlace, ItemRef } from '../../domain/issue-graph.ts';
import type { GitHubIssue, GitHubProjectItem } from './api.ts';
import { pieceArtifactOf } from '../../domain/planned-work.ts';

/** What of the fake's state a place is read from: issues and sub-issues by `owner/repo#N`, pulls by the issue they name. */
export interface FakePlaceState {
  issues: Map<string, GitHubIssue>;
  subIssues: Map<string, string[]>;
  pulls: { url: string; repo: string; state: string; issue: string; closes: boolean }[];
  /** By `owner/number`. */
  projects: Map<string, GitHubProjectItem[] | Error>;
}

const issueRef = (i: GitHubIssue): ItemRef => ({ kind: 'issue', repo: i.repo, number: i.number, url: i.url, state: i.state, ...(i.stateReason ? { stateReason: i.stateReason } : {}) });

export function fakeIssuePlace(s: FakePlaceState, i: GitHubIssue): IssuePlace {
  const key = `${i.repo}#${i.number}`;
  const pull = (p: FakePlaceState['pulls'][number]): ItemRef =>
    ({ kind: 'pull_request', repo: p.repo, number: Number(p.url.slice(p.url.lastIndexOf('/') + 1)), url: p.url, state: p.state });
  const parentKey = [...s.subIssues].find(([, children]) => children.includes(key))?.[0];
  const parent = parentKey === undefined ? undefined : s.issues.get(parentKey);
  return {
    issue: { repo: i.repo, number: i.number, url: i.url, title: i.title, state: i.state, ...(i.stateReason ? { stateReason: i.stateReason } : {}), updatedAt: i.updatedAt,
      ...(pieceArtifactOf(i.body) ? { artifact: pieceArtifactOf(i.body) } : {}) },
    owner: { login: i.repo.slice(0, i.repo.indexOf('/')) },
    projects: [...s.projects].flatMap(([id, items]) => {
      if (items instanceof Error || !items.some((x) => x.url === i.url)) return [];
      const [owner, number] = id.split('/') as [string, string];
      return [{ owner, number: Number(number), url: `https://github.com/orgs/${owner}/projects/${number}` }];
    }),
    closedBy: s.pulls.filter((p) => p.issue === key && p.closes).map(pull),
    references: s.pulls.filter((p) => p.issue === key).map(pull),
    ...(parent ? { parent: issueRef(parent) } : {}),
    subIssues: (s.subIssues.get(key) ?? []).flatMap((k) => s.issues.get(k) ?? []).map(issueRef),
  };
}
