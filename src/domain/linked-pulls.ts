// Linked pull requests and the repository's visibility (issue #655 part 19, design.md "Trust stamps"): the rest of where an
// issue's work came from that a job keeps with its origin acts (part 14). The pull requests its text names — who wrote each,
// whether its head is a fork, whether a trusted actor wrote it — and whether its repository is public. A record for people
// and for Jev's trust check: no rule reads it, but a job may edit a linked pull request's title or body (issue #2151,
// src/users/github-proxy.ts). Pure.

/** A repository's visibility, as GitHub says. */
export const REPO_VISIBILITIES = ['public', 'private', 'internal'] as const;
export type RepoVisibility = typeof REPO_VISIBILITIES[number];

/**
 * A pull request an issue's text names, as read at intake. `author`: its author's login (absent: GitHub names none, a
 * deleted account). `fork`: its head is in another repository. `trusted`: a trusted actor wrote it, not as an app or a bot.
 * `unread`: it could not be read; `url` is then the issue URL its name gives, and nothing else is known.
 */
export interface LinkedPullRequest { url: string; author?: string; fork?: boolean; trusted: boolean; unread?: true }

/**
 * What one read of a name gives (`GitHubApi.linkedItem`): its repository's visibility, and the pull request it names when
 * it is one. Both absent: it names nothing GitHub shows the connection.
 */
export interface LinkedItem { visibility?: RepoVisibility; pullRequest?: { url: string; author?: string; fork: boolean } }

/** A name of an item in a text: its repository and number. */
export interface LinkedRef { repo: string; number: number }

/** At most this many names of a text are read, the first ones. */
export const LINKED_MAX = 10;

const NAME = /(?<![\w./-])(?:([\w.-]+\/[\w.-]+))?#(\d+)(?![\w-])/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The items the text of `issue` names, each once, in their order, at most LINKED_MAX: `#N`, `owner/name#N`, and the pull
 * request and issue URLs of the issue's own GitHub. The issue itself is not one. Which are pull requests only a read says.
 */
export function linkedRefs(issue: { repo: string; number: number; url: string }, text: string): LinkedRef[] {
  const origin = new URL(issue.url).origin;
  const url = new RegExp(`${escape(origin)}/([\\w.-]+/[\\w.-]+)/(?:pull|issues)/(\\d+)`, 'g');
  const found: { at: number; ref: LinkedRef }[] = [];
  for (const m of text.matchAll(url)) found.push({ at: m.index, ref: { repo: m[1]!, number: Number(m[2]) } });
  const bare = text.replace(url, (m) => ' '.repeat(m.length));
  for (const m of bare.matchAll(NAME)) found.push({ at: m.index, ref: { repo: m[1] ?? issue.repo, number: Number(m[2]) } });
  const seen = new Set([`${issue.repo.toLowerCase()}#${issue.number}`]);
  const refs: LinkedRef[] = [];
  for (const { ref } of found.sort((a, b) => a.at - b.at)) {
    const key = `${ref.repo.toLowerCase()}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length === LINKED_MAX) break;
  }
  return refs;
}
