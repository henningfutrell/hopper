// Declared parts (issue #729): an issue declares its parts as a checklist under a heading "Parts" (any level), up to the
// next heading of that level or higher; a checklist in a code block is not one. A part is done when its box is ticked,
// and each merged pull request that ships a part of the issue ("Part of #N", issue #579) ticks one more: the parts done
// are the larger of the two, never more than the parts. A part that starts with an issue (`#N`, `owner/repo#N`, its URL)
// is a required child: it is done only when that issue is closed, whatever its box says, and no merge counts for it. An
// issue's GitHub sub-issues are its parts too — with no such checklist, its only ones —: a closed sub-issue is a done part.
// A job's required child is one (issue #729, issue lineage: the hopper links it), so a parent is not done while it is open.
// A sub-issue a checklist item names counts once, as that item. The hopper never edits the issue: it counts.

import type { Parts } from '../../domain/types.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import { isPartOf } from './completion.ts';

/** An issue a part names: the child it needs closed. */
export interface IssueRef { repo: string; number: number }

/** One checklist item under the heading "Parts": ticked or not, and the issue it names, if it starts with one. */
export interface DeclaredPart { ticked: boolean; issue?: IssueRef }

const NAMED = /^(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)?#)(\d+)\b/;

/** The checklist items under the heading "Parts" of an issue of `repo`; undefined: the issue declares none. */
export function declaredParts(body: string, repo: string): DeclaredPart[] | undefined {
  let level = 0;
  let fence: string | undefined;
  const parts: DeclaredPart[] = [];
  for (const line of body.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (fence === undefined || f.startsWith(fence))) { fence = fence === undefined ? f : undefined; continue; }
    if (fence !== undefined) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const n = heading[1]!.length;
      if (level > 0 && n <= level) level = 0;
      if (level === 0 && /^parts$/i.test(heading[2]!)) level = n;
      continue;
    }
    const item = level > 0 ? /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(\S.*)$/.exec(line) : null;
    if (!item) continue;
    const named = NAMED.exec(item[2]!);
    parts.push({ ticked: item[1] !== ' ', ...(named ? { issue: { repo: named[1] ?? named[2] ?? repo, number: Number(named[3]) } } : {}) });
  }
  return parts.length > 0 ? parts : undefined;
}

/** The issue's sub-issues as its parts, as GitHub sums them up: a closed one is done; undefined: it has none. */
const subIssueParts = (issue: GitHubIssue): Parts | undefined =>
  issue.subIssues && { done: Math.min(issue.subIssues.closed, issue.subIssues.total), total: issue.subIssues.total };

/** A required child is done when its issue is closed; one that cannot be read counts by its box, read again next time. */
async function childDone(api: Pick<GitHubApi, 'getIssue'>, part: DeclaredPart & { issue: IssueRef }): Promise<boolean> {
  try {
    return (await api.getIssue(part.issue.repo, part.issue.number)).state === 'closed';
  } catch {
    return part.ticked;
  }
}

const sameIssue = (a: IssueRef, b: IssueRef): boolean => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

/** Beside a checklist, the sub-issues no item names; when they cannot be listed, all of them as GitHub sums them up. */
async function unnamedSubIssues(api: Pick<GitHubApi, 'subIssues'>, issue: GitHubIssue, named: IssueRef[]): Promise<Parts> {
  if (!issue.subIssues) return { done: 0, total: 0 };
  try {
    const subs = (await api.subIssues(issue.repo, issue.number)).filter((s) => !named.some((n) => sameIssue(n, s)));
    return { done: subs.filter((s) => s.state === 'closed').length, total: subs.length };
  } catch {
    return subIssueParts(issue)!;
  }
}

/**
 * The parts done of `issue`: undefined when it declares none. `merged`: a part's pull request seen merged now, counted
 * even when GitHub does not list it yet.
 */
export async function partsOf(api: Pick<GitHubApi, 'referencingPullRequests' | 'getIssue' | 'subIssues'>, issue: GitHubIssue, merged?: string): Promise<Parts | undefined> {
  const declared = declaredParts(issue.body, issue.repo);
  if (!declared) return subIssueParts(issue);
  const plain = declared.filter((p) => !p.issue);
  const children = declared.filter((p): p is DeclaredPart & { issue: IssueRef } => p.issue !== undefined);
  const urls = new Set(plain.length === 0 ? [] : (await api.referencingPullRequests(issue.repo, issue.number))
    .filter((pr) => pr.state === 'merged' && isPartOf(pr, issue.repo, issue.number)).map((pr) => pr.url));
  if (merged) urls.add(merged);
  const plainDone = Math.min(plain.length, Math.max(plain.filter((p) => p.ticked).length, urls.size));
  const childrenDone = (await Promise.all(children.map((c) => childDone(api, c)))).filter(Boolean).length;
  const subs = await unnamedSubIssues(api, issue, children.map((c) => c.issue));
  return { done: plainDone + childrenDone + subs.done, total: declared.length + subs.total };
}

/** The parts done when nothing can be read: the ticked boxes and the sub-issues as the issue sums them up. */
export function tickedParts(issue: GitHubIssue): Parts | undefined {
  const declared = declaredParts(issue.body, issue.repo);
  const subs = subIssueParts(issue);
  if (!declared) return subs;
  return { done: declared.filter((p) => p.ticked).length + (subs?.done ?? 0), total: declared.length + (subs?.total ?? 0) };
}

/** Every declared part is done. */
export const allPartsDone = (p: Parts | undefined): boolean => p !== undefined && p.done >= p.total;
