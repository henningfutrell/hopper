// The item reconciler (issue #1891, design.md "The item lifecycle"): every `RECONCILE_INTERVAL_MS`, under its sweep lease
// (one host of those on one database), the work items whose next check is due are checked against what their state
// promises (`correctionOf`, src/domain/item-lifecycle.ts). An item the ledger has queued or working though its job ended
// is folded again from that job's end event, and so is an item blocked for want of a pull request whose job's report
// named one since; an item in PR open past its deadline with no open pull request a job follows is blocked. Each correction is an event (`work_item.reconciled`), so the item moves in the event's transaction
// as every ledger change does, and a rebuild replays it. An item that keeps its promise is checked again later. It reads
// only the database: no call to GitHub. One correction is no event: an item blocked because its pull request was closed
// without a merge, the first time in a row, runs again (`runAgain`: its ended job's Run again, by `reconciler`, with a brief
// that names the closed pull request), off the pass; its new job's `job.queued` moves it. One run again per item at a time.
// A blocked item that is stuck work for a person gets one notice: `work_item.person_asked`, which a notifier sends on.
// A block of an item whose job is a GitHub job writes its issue's label change as GitHub outbox rows (act `mirror`, part 8)
// in the event's transaction: the move and its rows are kept together or not at all, and the source's outbox sends them.
// Kill points (issue #1954, design.md "The crash harness"): inside a block's transaction, between its event and its rows;
// once a correction's event is kept; and before and after a run again's call.
import type { GitHubOutboxRepository, OutboxInput } from '../domain/github-outbox.ts';
import type { SweepLease } from '../domain/leases.ts';
import type { RerunResult } from '../domain/ports.ts';
import { following } from '../domain/pull-requests.ts';
import { TERMINAL_STATUSES, type DomainEvent, type EventType, type Job, type NewEvent } from '../domain/types.ts';
import { checkOf, correctionOf, type ItemCorrection } from '../domain/item-lifecycle.ts';
import type { WorkItem, WorkItemLedger } from '../domain/work-items.ts';
import { killPoint } from '../sagas/kill-points.ts';
import { blockLabels } from '../sources/github/item-labels.ts';

/** How often it checks: every 5 minutes. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** The most items one pass checks. */
export const RECONCILE_LIMIT = 200;

/** The kill points of a correction (issue #1954): inside its transaction, once its event is kept, around a run again's call. */
export const itemKillPoint = (kind: ItemCorrection['kind'], at: 'inside-tx' | 'after-record' | 'before-call' | 'after-call'): string => `item:${kind}:${at}`;

/** The brief of the job that runs an item again after its pull request was closed without a merge. */
export const closedBrief = (pullRequest: string | undefined): string =>
  `The earlier pull request of this issue${pullRequest ? ` (${pullRequest})` : ''} was closed without a merge. Read its comments `
  + 'and reviews, and the comments of the issue, to learn why. Then do the work again so that it answers why. Open a new pull '
  + 'request: do not reopen the closed one.';

/** The kinds of a GitHub job source: a connected account's (`github-account`, every account's), the app's, and `github`. */
const GITHUB_KINDS: ReadonlySet<string> = new Set(['github', 'github-account', 'github-app']);

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
  /** The GitHub outbox's rows: a block's label change is kept there with its event. Absent: the label mirror corrects it at a discover. */
  outbox?: Pick<GitHubOutboxRepository, 'tx' | 'add'>;
  lease: SweepLease;
  /** Run the ended job's item again (Run again, by the reconciler, with `brief`); absent: no item runs again by itself. */
  runAgain?(jobId: string, brief: string): Promise<RerunResult>;
  now(): string;
  log(line: string): void;
  intervalMs?: number;
  limit?: number;
}): ItemReconciler {
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The items whose run again is under way: a pass while one runs starts no second. */
  const running = new Set<string>();

  /** Run the item again, off the pass; a refusal or a failure is logged, and the next due check tries again. */
  function runAgain(c: Extract<ItemCorrection, { kind: 'run_again' }>): boolean {
    if (!o.runAgain || running.has(c.key)) return false;
    running.add(c.key);
    killPoint(itemKillPoint('run_again', 'before-call'));
    void o.runAgain(c.jobId, closedBrief(c.pullRequest))
      .then((r) => { killPoint(itemKillPoint('run_again', 'after-call')); if (!r.ok) o.log(`hopper: the item reconciler could not run ${c.key} again, tries again later: ${r.message}`); })
      .catch((e: unknown) => o.log(`hopper: the item reconciler could not run ${c.key} again, tries again later: ${(e as Error).message}`))
      .finally(() => running.delete(c.key));
    o.log(`hopper: the item reconciler runs ${c.key} again: its pull request was closed without a merge`);
    return true;
  }

  /** The event that makes the correction; undefined when the job's end event is not there to fold from. */
  function eventOf(c: Exclude<ItemCorrection, { kind: 'run_again' }>, job: Job | undefined): NewEvent | undefined {
    if (c.kind === 'block') return { type: 'work_item.reconciled', data: { key: c.key, from: c.from, cause: c.cause } };
    if (c.kind === 'ask') {
      const { kind: _kind, ...data } = c;
      return { type: 'work_item.person_asked', ...(c.jobId !== undefined ? { jobId: c.jobId } : {}), data };
    }
    const type = job ? END_EVENT[job.status] : undefined;
    const end = type ? o.events.recent(1, [type], c.jobId)[0] : undefined;
    if (!type || !end) return undefined;
    return { type: 'work_item.reconciled', jobId: c.jobId, data: { key: c.key, from: c.from, jobId: c.jobId, replay: { type, data: end.data } } };
  }

  /** The outbox rows of a block: its issue's label change, sent by the job's GitHub source; none for an item with no GitHub job. */
  function rowsOf(c: ItemCorrection, job: Job | undefined): OutboxInput[] {
    const src = job?.source;
    if (c.kind !== 'block' || !o.outbox || !src || !GITHUB_KINDS.has(src.kind) || !src.repo) return [];
    const { remove, add } = blockLabels(c.from, c.cause);
    const base = { source: src.source, repo: src.repo, key: c.key, act: 'mirror' as const, tag: `blocked:${c.cause}` };
    return [
      ...(remove.length ? [{ ...base, change: { op: 'remove_labels' as const, labels: remove } }] : []),
      { ...base, change: { op: 'add_labels' as const, labels: add } },
    ];
  }

  function check(item: WorkItem, now: string): boolean {
    const job = item.jobId !== undefined ? o.jobs.get(item.jobId) : undefined;
    const pullRequest = job?.sourceState?.source?.pullRequest;
    const correction = correctionOf(item, job && {
      id: job.id, status: job.status, ended: TERMINAL_STATUSES.includes(job.status), updatedAt: job.updatedAt, ...(typeof pullRequest === 'string' ? { pullRequest } : {}),
    }, job !== undefined && following(job), now);
    const next = checkOf(item.state, item.eventAt, now);
    if (correction?.kind === 'run_again') {
      if (next) o.ledger.checked(item.key, item.version, next.nextCheckAt);
      return runAgain(correction);
    }
    const event = correction && eventOf(correction, job);
    if (event) {
      const rows = rowsOf(correction, job);
      if (rows.length && o.outbox) {
        const outbox = o.outbox;
        outbox.tx(() => { o.events.append(event); killPoint(itemKillPoint(correction.kind, 'inside-tx')); outbox.add(rows, now); });
      } else o.events.append(event);
      killPoint(itemKillPoint(correction.kind, 'after-record'));
      o.log(correction.kind === 'ask'
        ? `hopper: the item reconciler asked a person about ${item.key}: blocked, ${correction.cause}`
        : `hopper: the item reconciler moved ${item.key} out of ${item.state}: ${correction.kind === 'block' ? `blocked, ${correction.cause}` : `folded again from its job's end (${job?.status ?? 'ended'})`}`);
      return true;
    }
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
