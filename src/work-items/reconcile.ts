// The item reconciler (issue #1891, design.md "The item lifecycle"): every `RECONCILE_INTERVAL_MS`, under its sweep lease
// (one host of those on one database), the work items whose next check is due are checked against what their state
// promises (`correctionOf`, src/domain/item-lifecycle.ts). An item the ledger has queued or working though its job ended
// is folded again from that job's end event, and so is an item blocked for want of a pull request whose job's report
// named one since; an item in PR open past its deadline with no open pull request a job follows is blocked. Each correction is an event (`work_item.reconciled`), so the item moves in the event's transaction
// as every ledger change does, and a rebuild replays it. An item that keeps its promise is checked again later. It reads
// only the database: no call to GitHub.
import type { SweepLease } from '../domain/leases.ts';
import { following } from '../domain/pull-requests.ts';
import { TERMINAL_STATUSES, type DomainEvent, type EventType, type Job, type NewEvent } from '../domain/types.ts';
import { checkOf, correctionOf, type ItemCorrection } from '../domain/item-lifecycle.ts';
import type { WorkItem, WorkItemLedger } from '../domain/work-items.ts';

/** How often it checks: every 5 minutes. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** The most items one pass checks. */
export const RECONCILE_LIMIT = 200;

/** The end event of each ended job status: what an item is folded again from. */
const END_EVENT: Readonly<Record<string, EventType>> = { finished: 'job.finished', failed: 'job.failed', cancelled: 'job.cancelled', rejected: 'job.rejected' };

export interface ItemReconciler {
  /** One pass now: how many items it corrected. Nothing while another host holds its lease. */
  reconcileOnce(): number;
  start(): void;
  stop(): void;
}

export function createItemReconciler(o: {
  ledger: Pick<WorkItemLedger, 'due' | 'checked'>;
  jobs: { get(id: string): Job | undefined };
  events: { append(event: NewEvent): unknown; recent(limit?: number, types?: EventType[], jobId?: string): DomainEvent[] };
  lease: SweepLease;
  now(): string;
  log(line: string): void;
  intervalMs?: number;
  limit?: number;
}): ItemReconciler {
  let timer: ReturnType<typeof setInterval> | undefined;

  /** The event that makes the correction; undefined when the job's end event is not there to fold from. */
  function eventOf(c: ItemCorrection, job: Job | undefined): NewEvent | undefined {
    if (c.kind === 'block') return { type: 'work_item.reconciled', data: { key: c.key, from: c.from, cause: c.cause } };
    const type = job ? END_EVENT[job.status] : undefined;
    const end = type ? o.events.recent(1, [type], c.jobId)[0] : undefined;
    if (!type || !end) return undefined;
    return { type: 'work_item.reconciled', jobId: c.jobId, data: { key: c.key, from: c.from, jobId: c.jobId, replay: { type, data: end.data } } };
  }

  function check(item: WorkItem, now: string): boolean {
    const job = item.jobId !== undefined ? o.jobs.get(item.jobId) : undefined;
    const pullRequest = job?.sourceState?.source?.pullRequest;
    const correction = correctionOf(item, job && {
      id: job.id, status: job.status, ended: TERMINAL_STATUSES.includes(job.status), updatedAt: job.updatedAt, ...(typeof pullRequest === 'string' ? { pullRequest } : {}),
    }, job !== undefined && following(job), now);
    const event = correction && eventOf(correction, job);
    if (event) {
      o.events.append(event);
      o.log(`hopper: the item reconciler moved ${item.key} out of ${item.state}: ${correction.kind === 'block' ? `blocked, ${correction.cause}` : `folded again from its job's end (${job?.status ?? 'ended'})`}`);
      return true;
    }
    const next = checkOf(item.state, item.stateSince, now);
    if (next) o.ledger.checked(item.key, item.version, next.nextCheckAt);
    return false;
  }

  function reconcileOnce(): number {
    if (!o.lease.hold().held) return 0;
    const now = o.now();
    let corrected = 0;
    for (const item of o.ledger.due(now, o.limit ?? RECONCILE_LIMIT)) {
      try {
        if (check(item, now)) corrected += 1;
      } catch (e) {
        o.log(`hopper: the item reconciler could not check ${item.key}, checks it again next pass: ${(e as Error).message}`);
      }
    }
    return corrected;
  }

  return {
    reconcileOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => { reconcileOnce(); }, o.intervalMs ?? RECONCILE_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
