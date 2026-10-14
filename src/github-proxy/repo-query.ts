// The repo-query cache (issue #1074, design.md "Repo queries"): a job's reads of GitHub through the hopper — an issue, its
// comments, a pull request, its diff, its commits, its checks, a repository, a check's log — answered from what the hopper
// read last, so jobs that ask the same thing again, or ask what another job asked, spend no GitHub call. An answer is
// kept `REPO_QUERY_FRESH_MS`; a pull request the work-item ledger, or its own read, says is merged never changes, so its
// reads made after the merge are kept until they are pushed out. A job's own write drops what it changed. Past that, the read goes to GitHub,
// where the shared rate limiter's ETag makes an unchanged answer a 304, which GitHub does not charge. Kept in memory: a
// restart reads each once again. Pure but for the clock the caller passes.
import type { ProxyResult } from './api.ts';
import type { ProxyOp } from './policy.ts';

/** How long a kept answer is given again with no read of GitHub. */
export const REPO_QUERY_FRESH_MS = 30_000;
/** How much the cache keeps at most: answers, and their size in characters of JSON (a diff is the large one). */
export const REPO_QUERY_ENTRIES = 500;
export const REPO_QUERY_CHARS = 20_000_000;

/** Where a repo query's answer came from: GitHub now, or the repo-query cache. */
export type AnswerSource = 'github' | 'cache';

/** What the work-item ledger says of the item an answer is about: its state and since when, its pull request's and its issue's. */
export interface LedgerView { key: string; state: string; since: string; pullRequestState?: string; issueState?: string; issueReason?: string }

/** A kept answer: what GitHub said, and when it was read (ms). */
export interface KeptAnswer { result: ProxyResult; at: number }

export interface RepoQueryCache {
  /** The kept answer to `key`, or undefined. */
  get(key: string): KeptAnswer | undefined;
  put(key: string, result: ProxyResult, at: number): void;
  /** Drop every answer about `repo`'s issue or pull request `number`: a job's write changed it. */
  forget(repo: string, number: number): void;
}

/** One query's key: its operation, its repository (GitHub ignores case there) and its number. */
export function queryKey(r: { op: ProxyOp; repo: string; number?: number }): string {
  return `${r.op} ${r.repo.toLowerCase()}${r.number !== undefined ? `#${r.number}` : ''}`;
}

/**
 * Whether a kept answer can change no more: a read of a pull request that is merged, as it said, or as the ledger says
 * and read after the ledger's item came to its state: a read before the merge says what was there before it.
 */
export function isFinal(op: ProxyOp, kept: KeptAnswer, ledger: LedgerView | undefined): boolean {
  if (!op.startsWith('pr.')) return false;
  if (kept.result.merged === true) return true;
  return ledger?.pullRequestState === 'merged' && kept.at >= Date.parse(ledger.since);
}

/** Whether `kept` is the answer now: fresh, or final. */
export function answersNow(op: ProxyOp, kept: KeptAnswer, now: number, ledger: LedgerView | undefined): boolean {
  return now - kept.at < REPO_QUERY_FRESH_MS || isFinal(op, kept, ledger);
}

export function createRepoQueryCache(o: { entries?: number; chars?: number } = {}): RepoQueryCache {
  const entries = o.entries ?? REPO_QUERY_ENTRIES;
  const chars = o.chars ?? REPO_QUERY_CHARS;
  // Oldest first: a Map keeps insertion order, and a put moves the key to the end.
  const kept = new Map<string, KeptAnswer & { size: number }>();
  let total = 0;
  const drop = (key: string): void => {
    const k = kept.get(key);
    if (!k) return;
    total -= k.size;
    kept.delete(key);
  };
  return {
    get: (key) => kept.get(key),
    put(key, result, at) {
      drop(key);
      const size = JSON.stringify(result).length;
      if (size > chars) return;
      kept.set(key, { result, at, size });
      total += size;
      while (kept.size > entries || total > chars) drop(kept.keys().next().value!);
    },
    forget(repo, number) {
      const end = ` ${repo.toLowerCase()}#${number}`;
      for (const key of [...kept.keys()]) if (key.endsWith(end)) drop(key);
    },
  };
}
