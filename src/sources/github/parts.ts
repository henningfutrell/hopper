// Declared parts (issue #729): an issue declares its parts as a checklist under a heading "Parts" (any level), up to the
// next heading of that level or higher; a checklist in a code block is not one. A part is done when its box is ticked,
// and each merged pull request that ships a part of the issue ("Part of #N", issue #579) ticks one more: the parts done
// are the larger of the two, never more than the parts. The hopper never edits the issue: it counts.

import type { Parts } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';
import { isPartOf } from './completion.ts';

/** The checklist items under the heading "Parts", and how many are ticked; undefined: the issue declares no parts. */
export function declaredParts(body: string): { total: number; ticked: number } | undefined {
  let level = 0;
  let fence: string | undefined;
  let total = 0;
  let ticked = 0;
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
    const item = level > 0 ? /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+\S/.exec(line) : null;
    if (!item) continue;
    total += 1;
    if (item[1] !== ' ') ticked += 1;
  }
  return total > 0 ? { total, ticked } : undefined;
}

/**
 * The parts done of issue `number` whose text is `body`: undefined when it declares none. `merged`: a part's pull request
 * seen merged now, counted even when GitHub does not list it yet.
 */
export async function partsOf(api: Pick<GitHubApi, 'referencingPullRequests'>, repo: string, number: number, body: string, merged?: string): Promise<Parts | undefined> {
  const declared = declaredParts(body);
  if (!declared) return undefined;
  const urls = new Set((await api.referencingPullRequests(repo, number)).filter((pr) => pr.state === 'merged' && isPartOf(pr, repo, number)).map((pr) => pr.url));
  if (merged) urls.add(merged);
  return { done: Math.min(declared.total, Math.max(declared.ticked, urls.size)), total: declared.total };
}

/** Every declared part is done. */
export const allPartsDone = (p: Parts | undefined): boolean => p !== undefined && p.done >= p.total;
