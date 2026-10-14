// The in-memory GitHub's cross-references (fake.ts, issue #430): the pull requests and commits that mention an issue, and
// the ones GitHub links as closing it. A test says which close it (`closes`), as GitHub would decide: never from the text.
import type { IssueCrossReferences } from '../../domain/cross-references.ts';
import type { GitHubIssue } from './api.ts';

/** A pull request of the fake, as far as its cross-references need it: the issue it mentions, by key. */
interface FakePull { issue: string; repo: string; url: string; body: string; closes: boolean }

export interface FakeMentionInput { from?: string; kind?: 'pull_request' | 'commit'; text: string; closes: boolean; createdAt: string }

/** The fake's issues by key, its login, and how it opens a pull request of `repo` that mentions issue `issue`. */
type AddPull = (repo: string, issue: string, o: { createdAt: string }, closes: boolean, body: string) => { url: string };

export function createFakeCrossReferences(issues: Map<string, GitHubIssue>, login: string, addPull: AddPull) {
  const commits: { issue: string; repo: string; url: string; message: string; closes: boolean }[] = [];
  return {
    of(issue: string, pulls: FakePull[]): IssueCrossReferences {
      const prs = pulls.filter((p) => p.issue === issue);
      const cs = commits.filter((c) => c.issue === issue);
      return {
        mentions: [...prs.map((p) => ({ kind: 'pull_request' as const, repo: p.repo, url: p.url, text: p.body })), ...cs.map((c) => ({ kind: 'commit' as const, repo: c.repo, url: c.url, text: c.message }))],
        closing: [...prs.filter((p) => p.closes).map((p) => ({ kind: 'pull_request' as const, repo: p.repo, url: p.url })), ...cs.filter((c) => c.closes).map((c) => ({ kind: 'commit' as const, repo: c.repo, url: c.url }))],
      };
    },
    /** A pull request or a commit of `from` (default `repo`, the issue's) that mentions issue `issue`; its URL. */
    mention(issue: string, repo: string, m: FakeMentionInput): string {
      const from = m.from ?? repo;
      if (m.kind !== 'commit') return addPull(from, issue, { createdAt: m.createdAt }, m.closes, m.text).url;
      const url = `https://github.com/${from}/commit/${(0xc0ffee + commits.length).toString(16)}`;
      commits.push({ issue, repo: from, url, message: m.text, closes: m.closes });
      // A commit that closes it, pushed to the default branch: GitHub closes the issue as completed.
      if (m.closes) Object.assign(issues.get(issue)!, { state: 'closed', closedBy: login, closedAt: m.createdAt, stateReason: 'completed' });
      return url;
    },
  };
}
