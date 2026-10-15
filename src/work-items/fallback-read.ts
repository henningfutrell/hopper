// The work-item ledger's fallback read (issue #1067 part 3, design.md "The work-item ledger"). GitHub deliveries move an
// item when its issue closes or reopens; a hopper with no delivery set up, or one that missed a delivery, would never
// hear of it. So every `FALLBACK_READ_INTERVAL_MS` one user's ledger is sampled for items no job or person acts on and not
// done (`pr_open`, `partly_done`, `failed`, `dropped`, issue #1105), or whose job waits on something outside
// (`waiting_outside`, issue #1356: a batch run's merge closes its issue, and the close wakes the job), with no news for `FALLBACK_READ_QUIET_MS` — no event
// moved them and this read did not read them —, their issues are read on
// GitHub in one batched call (the component watchers' `states`, through the shared rate limiter), and a close or a reopen
// is recorded as the event a delivery records (`work_item.issue_closed`, `work_item.issue_reopened`, `via: read`). The
// item then moves in the event's transaction, as every ledger change does. A pull request's merge stays the follow's.
// The first read, `FALLBACK_READ_FIRST_MS` after the start, reads every such item, quiet or not and past the limit: the
// rows the ledger holds are reconciled with GitHub (issue #1105), which no migration can read.
// With no GitHub connection it reads nothing and logs why. When each item was read last lives in memory: a restart may
// read an item once more.
import type { GitHubStates } from '../component-watchers/github.ts';
import type { NewEvent } from '../domain/types.ts';
import { FALLBACK_READ_STATES, fallbackReadPick, issueChangeEvent, type WorkItemLedger } from '../domain/work-items.ts';

export { fallbackReadPick } from '../domain/work-items.ts';

/** How often it reads: every 5 minutes. */
export const FALLBACK_READ_INTERVAL_MS = 5 * 60_000;
/** How long an item has had no news before it is read: 30 minutes. */
export const FALLBACK_READ_QUIET_MS = 30 * 60_000;
/** How many items one read reads: one GraphQL call. */
export const FALLBACK_READ_LIMIT = 50;
/** When the first read, of every item, runs after the start: once the daemon settled. */
export const FALLBACK_READ_FIRST_MS = 60_000;

export interface LedgerFallbackRead {
  /** One read now (`all`: every item not done, quiet or not, past the limit); how many events it recorded. One at a time. */
  readOnce(all?: boolean): Promise<number>;
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
  firstMs?: number;
  quietMs?: number;
  limit?: number;
}): LedgerFallbackRead {
  const lastRead = new Map<string, string>();
  let running: Promise<number> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  async function read(all: boolean): Promise<number> {
    const items = o.ledger.list({ state: [...FALLBACK_READ_STATES] });
    const now = o.now();
    const urls = fallbackReadPick(items, lastRead, now, all
      ? { quietMs: 0, limit: Infinity }
      : { quietMs: o.quietMs ?? FALLBACK_READ_QUIET_MS, limit: o.limit ?? FALLBACK_READ_LIMIT });
    if (urls.length === 0) return 0;
    const github = o.github();
    if ('problem' in github) {
      o.log(`hopper: the work-item ledger's fallback read read nothing: ${github.problem}`);
      return 0;
    }
    const reads = await github.states(urls);
    for (const url of urls) lastRead.set(url, now);
    // An item no longer in the sample is forgotten: it is read again only once it is quiet in one of those states.
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

  const readOnce = (all = false): Promise<number> => {
    running ??= read(all).finally(() => { running = undefined; });
    return running;
  };

  const next = (all = false) => {
    if (stopped) return;
    timer = setTimeout(() => {
      readOnce(all).catch((e: unknown) => { o.log(`hopper: the work-item ledger's fallback read failed, read again later: ${(e as Error).message}`); }).finally(() => next());
    }, all ? o.firstMs ?? FALLBACK_READ_FIRST_MS : o.intervalMs ?? FALLBACK_READ_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    readOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      next(true);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
    },
  };
}
