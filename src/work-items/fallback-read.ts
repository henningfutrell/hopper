// The work-item ledger's fallback read (issue #1067 part 3, design.md "The work-item ledger"). GitHub deliveries move an
// item when its issue closes or reopens; a hopper with no delivery set up, or one that missed a delivery, would never
// hear of it. So every `FALLBACK_READ_INTERVAL_MS` one user's ledger is sampled for items in `pr_open` or `failed` with
// no news for `FALLBACK_READ_QUIET_MS` — no event moved them and this read did not read them —, their issues are read on
// GitHub in one batched call (the component watchers' `states`, through the shared rate limiter), and a close or a reopen
// is recorded as the event a delivery records (`work_item.issue_closed`, `work_item.issue_reopened`, `via: read`). The
// item then moves in the event's transaction, as every ledger change does. A pull request's merge stays the follow's.
// With no GitHub connection it reads nothing and logs why. When each item was read last lives in memory: a restart may
// read an item once more.
import type { GitHubStates } from '../component-watchers/github.ts';
import type { NewEvent } from '../domain/types.ts';
import { fallbackReadPick, issueChangeEvent, type WorkItemLedger } from '../domain/work-items.ts';

export { fallbackReadPick } from '../domain/work-items.ts';

/** How often it reads: every 5 minutes. */
export const FALLBACK_READ_INTERVAL_MS = 5 * 60_000;
/** How long an item has had no news before it is read: 30 minutes. */
export const FALLBACK_READ_QUIET_MS = 30 * 60_000;
/** How many items one read reads: one GraphQL call. */
export const FALLBACK_READ_LIMIT = 50;

export interface LedgerFallbackRead {
  /** One read now; how many events it recorded. One at a time. */
  readOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createLedgerFallbackRead(o: {
  ledger: Pick<WorkItemLedger, 'list'>;
  events: { append(event: NewEvent): unknown };
  /** The user's own GitHub connection, or why there is none. */
  github(): GitHubStates | { problem: string };
  now(): string;
  log(line: string): void;
  intervalMs?: number;
  quietMs?: number;
  limit?: number;
}): LedgerFallbackRead {
  const lastRead = new Map<string, string>();
  let running: Promise<number> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  async function read(): Promise<number> {
    const items = o.ledger.list({ state: ['pr_open', 'failed'] });
    const now = o.now();
    const urls = fallbackReadPick(items, lastRead, now, { quietMs: o.quietMs ?? FALLBACK_READ_QUIET_MS, limit: o.limit ?? FALLBACK_READ_LIMIT });
    if (urls.length === 0) return 0;
    const github = o.github();
    if ('problem' in github) {
      o.log(`hopper: the work-item ledger's fallback read read nothing: ${github.problem}`);
      return 0;
    }
    const reads = await github.states(urls);
    for (const url of urls) lastRead.set(url, now);
    // An item no longer in the sample is forgotten: it is read again only once it is quiet in `pr_open` or `failed`.
    const sampled = new Set(items.map((i) => i.key));
    for (const key of lastRead.keys()) if (!sampled.has(key)) lastRead.delete(key);
    let recorded = 0;
    for (const item of items) {
      const r = reads.get(item.key);
      const event = r && urls.includes(item.key) ? issueChangeEvent(item, { state: r.state, ...(r.stateReason ? { reason: r.stateReason } : {}) }, 'read') : undefined;
      if (!event) continue;
      o.events.append(event);
      recorded += 1;
    }
    return recorded;
  }

  const readOnce = (): Promise<number> => {
    running ??= read().finally(() => { running = undefined; });
    return running;
  };

  const next = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      readOnce().catch((e: unknown) => { o.log(`hopper: the work-item ledger's fallback read failed, read again later: ${(e as Error).message}`); }).finally(next);
    }, o.intervalMs ?? FALLBACK_READ_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    readOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      next();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
    },
  };
}
