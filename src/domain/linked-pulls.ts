// Linked pull requests and the repository's visibility (issue #655 part 19, design.md "Trust stamps"): the rest of where an
// issue's work came from that a job keeps with its origin acts (part 14). The pull requests its text names — who wrote each,
// whether its head is a fork, whether a trusted actor wrote it — and whether its repository is public. A record for people
// and for Jev's trust check: no rule reads it; a job's pr edit reads the same names (`namesItem`), from its item's approved
// text (issues #2151, #2227, src/users/github-proxy.ts). Pure.

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
/** Code in Markdown: a fenced block (to its closing fence, or the text's end), or an inline code span. */
const CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))|(`+)[^`\n][^\n]*?\2/gm;

/** A name in a text: where it is, the item it names, and whether it is a bare `#N` in code. */
interface Found { at: number; ref: LinkedRef; inCode: boolean }

function namesIn(issue: { repo: string; url: string }, text: string): Found[] {
  const origin = new URL(issue.url).origin;
  const url = new RegExp(`${escape(origin)}/([\\w.-]+/[\\w.-]+)/(?:pull|issues)/(\\d+)`, 'g');
  const found: Found[] = [];
  for (const m of text.matchAll(url)) found.push({ at: m.index, ref: { repo: m[1]!, number: Number(m[2]) }, inCode: false });
  const bare = text.replace(url, (m) => ' '.repeat(m.length));
  const code = [...bare.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length] as const);
  for (const m of bare.matchAll(NAME)) {
    const inCode = m[1] === undefined && code.some(([from, to]) => m.index >= from && m.index < to);
    found.push({ at: m.index, ref: { repo: m[1] ?? issue.repo, number: Number(m[2]) }, inCode });
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * The items the text of `issue` names, each once, in their order, at most `max`: `#N` (so also `PR #N` and `pull request
 * #N`), `owner/name#N`, and the pull request and issue URLs of the issue's own GitHub. A bare `#N` in code names nothing
 * (issue #2227): a log line or a snippet asks nothing of it. The issue itself is not one. Which are pull requests only a
 * read says.
 */
export function linkedRefs(issue: { repo: string; number: number; url: string }, text: string, max = LINKED_MAX): LinkedRef[] {
  const seen = new Set([`${issue.repo.toLowerCase()}#${issue.number}`]);
  const refs: LinkedRef[] = [];
  for (const { ref, inCode } of namesIn(issue, text)) {
    const key = `${ref.repo.toLowerCase()}#${ref.number}`;
    if (inCode || seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length === max) break;
  }
  return refs;
}

/** An issue's title and body: the one text its names are read from (issue #2227). */
export const issueText = (t: { title: string; body: string }): string => `${t.title}\n${t.body}`;

/**
 * Whether the text of `issue` names item `number` of `repo`, every name read, not only the first LINKED_MAX (issue #2227:
 * a job edits a pull request its issue names); else why not, in words the job can act on.
 */
export function namesItem(issue: { repo: string; number: number; url: string }, text: string, repo: string, number: number): true | string {
  const same = (r: LinkedRef) => r.number === number && r.repo.toLowerCase() === repo.toLowerCase();
  if (linkedRefs(issue, text, Infinity).some(same)) return true;
  const own = `${issue.repo}#${issue.number}`;
  if (namesIn(issue, text).some((f) => f.inCode && same(f.ref))) return `its issue ${own} names #${number} only in code`;
  if (repo.toLowerCase() !== issue.repo.toLowerCase()) return `its issue ${own} does not name it (a pull request of another repository only as ${repo}#${number} or by its URL)`;
  return `its issue ${own} does not name it`;
}

