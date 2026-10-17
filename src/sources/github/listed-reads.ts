// Listed reads (issue #985 part 2, design.md "Repository listings"): a job's reads of its issue — the issue and its
// comments — are kept with the `updatedAt` its listing and the read showed. An issue with sub-issues is never kept, nor are
// its sub-issues: a sub-issue that closes need not change its parent's `updatedAt`. Inside `cached` (a discover, a check) a
// read is answered from what was kept while the listing cache still shows that `updatedAt`; an issue the listing cache
// does not hold (closed, unlabelled, its repository not listed) is always read from GitHub. A write to a repository drops
// what was kept of it, so a read after the hopper's own write goes to GitHub. Outside `cached` — a report, a follow, a
// rerun: a write may come next — every read goes to GitHub. Kept in memory: a restart reads each issue once again.
//
// The listing cache follows what the hopper itself knows of an issue between listings: a read of it from GitHub sets its
// row (gone when it is closed), and the hopper's own label, assignee and close writes change its row, so a timed sync
// never acts on the labels from before the hopper's own write. Neither moves where the listing's next change read starts
// (issue #1276): a read of one issue proves nothing of the others.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GitHubListingRepository, ListedItem } from '../../domain/github-listing.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import { WRITES } from './pass-reads.ts';

const KEPT = new Set<string>(['getIssue', 'listComments']);
const WRITE = new Set<string>(WRITES);

export interface Kept { repo: string; number: number; at: Set<string>; answer: unknown }
type Method = (...args: unknown[]) => Promise<unknown>;

export interface ListedReads {
  api: GitHubApi;
  /** Run `run` with its reads of listed issues answered from what was kept while the listing shows no change. */
  cached<T>(run: () => Promise<T>): Promise<T>;
}

/** Change one row of `repo`'s listing; `change` answers the new item, or undefined to drop it. */
function patch(listings: GitHubListingRepository, repo: string, number: number, change: (i: ListedItem) => ListedItem | undefined): void {
  const l = listings.listing(repo);
  const at = l?.items.findIndex((i) => i.number === number) ?? -1;
  if (!l || at < 0) return;
  const next = change(l.items[at]!);
  listings.record(repo, { ...l, items: next ? l.items.map((i, k) => (k === at ? next : i)) : l.items.filter((_, k) => k !== at) });
}

/** What the hopper's own write does to the row of its issue. */
function afterWrite(name: string, args: unknown[]): ((i: ListedItem) => ListedItem | undefined) | undefined {
  const names = (args[2] ?? []) as string[];
  if (name === 'addLabels') return (i) => ({ ...i, labels: [...i.labels, ...names.filter((l) => !i.labels.includes(l))] });
  if (name === 'removeLabels') return (i) => ({ ...i, labels: i.labels.filter((l) => !names.includes(l)) });
  if (name === 'addAssignees') return (i) => ({ ...i, assignees: [...i.assignees, ...names.filter((l) => !i.assignees.includes(l))] });
  if (name === 'closeAsCompleted' || name === 'closeAsNotPlanned') return () => undefined;
  return undefined;
}

export function listedReads(api: GitHubApi, listings: GitHubListingRepository, kept = new Map<string, Kept>()): ListedReads {
  const scope = new AsyncLocalStorage<true>();

  const read = (name: string, fn: Method): Method => async (...args) => {
    const [repo, number] = [String(args[0]), Number(args[1])];
    const key = `${name} ${repo}#${number}`;
    const item = listings.item(repo, number);
    if (!item) { kept.delete(key); return fn(...args); }
    const was = kept.get(key);
    if (scope.getStore() && was?.at.has(item.updatedAt)) return structuredClone(was.answer);
    const answer = await fn(...args);
    if (name === 'getIssue') {
      const issue = answer as GitHubIssue;
      patch(listings, repo, number, (i) => (issue.state === 'closed' ? undefined : { ...i, title: issue.title, labels: [...issue.labels], assignees: [...issue.assignees], updatedAt: issue.updatedAt }));
      if (issue.subIssues || issue.state === 'closed') { kept.delete(key); return answer; }
    }
    const at = new Set([item.updatedAt, ...(name === 'getIssue' ? [(answer as GitHubIssue).updatedAt] : [])]);
    kept.set(key, { repo, number, at, answer: structuredClone(answer) });
    return answer;
  };

  const write = (name: string, fn: Method): Method => async (...args) => {
    const repo = String(args[0]);
    const drop = () => { for (const [key, k] of kept) if (k.repo === repo) kept.delete(key); };
    drop();
    try {
      const done = await fn(...args);
      const change = afterWrite(name, args);
      if (change && typeof args[1] === 'number') patch(listings, repo, args[1], change);
      return done;
    } finally {
      drop();
    }
  };

  const out = new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const fn = (value as Method).bind(target);
      return KEPT.has(prop) ? read(prop, fn) : WRITE.has(prop) ? write(prop, fn) : fn;
    },
  });
  // What the listing no longer holds is read from GitHub anyway: after each discover or check it goes (issue #1402).
  const prune = () => { for (const [key, k] of kept) if (!listings.item(k.repo, k.number)) kept.delete(key); };
  return { api: out, cached: (run) => scope.run(true, run).finally(prune) };
}
