// Cross-reference detection (issue #430, design.md "Cross-references"): the closing references a text makes — one of
// GitHub's closing keywords, then `#N`, `owner/repo#N` or an issue's URL — and the cross-references of an issue: each pull request or
// commit GitHub confirms closes it, with the keyword its text used. A reference GitHub does not treat as closing — a
// mention, a part, a keyword GitHub did not act on — is never kept: the text proposes, GitHub confirms. Pure.

/** GitHub's closing keywords, each one only before the reference it closes. */
export const CLOSING_KEYWORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'] as const;
export type ClosingKeyword = (typeof CLOSING_KEYWORDS)[number];

/** An issue, by its repository (`owner/name`) and number. */
export interface IssueRef { repo: string; number: number }

/** A closing reference in a text: the issue it names, and the keyword before it. */
export interface ClosingReference extends IssueRef { keyword: ClosingKeyword }

const NAME = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+';
const CLOSING = new RegExp(
  `(?<![\\w-])(${CLOSING_KEYWORDS.join('|')})\\s*:?\\s+(?:(${NAME})?#(\\d+)|https://github\\.com/(${NAME})/issues/(\\d+))(?![\\w/])`, 'gi');

/** The text GitHub reads references in: code blocks, inline code and HTML comments taken out. */
const prose = (text: string): string =>
  text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/~~~[\s\S]*?(~~~|$)/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/<!--[\s\S]*?(-->|$)/g, ' ');

const same = (a: IssueRef, b: IssueRef): boolean => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

/** The closing references of `text`, written in `repo` (where `#N` points), each issue once with its first keyword. */
export function closingReferences(text: string, repo: string): ClosingReference[] {
  const found: ClosingReference[] = [];
  for (const m of prose(text).matchAll(CLOSING)) {
    const ref = { repo: m[2] ?? m[4] ?? repo, number: Number(m[3] ?? m[5]), keyword: m[1]!.toLowerCase() as ClosingKeyword };
    if (!found.some((f) => same(f, ref))) found.push(ref);
  }
  return found;
}

export const CROSS_REFERENCE_KINDS = ['pull_request', 'commit'] as const;
export type CrossReferenceKind = (typeof CROSS_REFERENCE_KINDS)[number];

/** A pull request or a commit that mentions an issue, with its text: a pull request's body, a commit's message. */
export interface Mention { kind: CrossReferenceKind; repo: string; url: string; text: string }

/**
 * What GitHub shows of an issue's cross-references: the pull requests and commits that mention it, and the ones it links
 * as closing it — a pull request it will close on merge or closed it, a commit that closed it.
 */
export interface IssueCrossReferences { mentions: Mention[]; closing: { kind: CrossReferenceKind; repo: string; url: string }[] }

/**
 * A cross-reference of a job's issue, kept on the job (`sourceState.source.crossReferences`): a pull request or a commit GitHub confirms closes
 * it. `keyword`: the closing keyword its text used; absent, GitHub links it without one in its text (by hand).
 */
export interface CrossReference { kind: CrossReferenceKind; repo: string; url: string; keyword?: ClosingKeyword }

/** The cross-references of `issue`: what GitHub confirms closes it, each once, in GitHub's order, with the keyword of its text. */
export function confirmedCrossReferences(issue: IssueRef, refs: IssueCrossReferences): CrossReference[] {
  const kept: CrossReference[] = [];
  for (const c of refs.closing) {
    if (kept.some((k) => k.url === c.url)) continue;
    const keyword = refs.mentions.filter((m) => m.url === c.url)
      .flatMap((m) => closingReferences(m.text, m.repo)).find((r) => same(r, issue))?.keyword;
    kept.push({ kind: c.kind, repo: c.repo, url: c.url, ...(keyword ? { keyword } : {}) });
  }
  return kept;
}
