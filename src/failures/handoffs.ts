// Needs a person (issue #516, design.md "Needs a person"): a failed job automatic handling has ended for is handed off
// to a person, and the hand-off stays open until a person acts — never dropped by age, a restart, or the recent
// failures' window. It opens when the assessor's record waits on a person (`handoffReason`), when a run again the
// assessor decided is refused, or when a failed job's locked entry is dismissed with nothing else to end it. It
// closes when its item runs again — from here, the Queue, the failure's Retry or the source; its record then turns
// `superseded` unless a run again is recorded on it (issue #517) —, when a person clears it (its locked entry
// dismissed too: no more work), or when its job ends finished. Each is an event. Stale data clears itself (issue
// #529): the sweep, and the start, close an open hand-off nothing waits on any more — a newer job of its item that no
// `job.queued` closed it for (a store from the build before), its job finished or gone, its item closed at its source.
import type { Clock, RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import { jobPriorityTag, type DomainEvent, type FailureOutcome, type FailureRecord, type FailureSettings, type Handoff, type HandoffEnd, type HandoffReason, type Job } from '../domain/types.ts';
import { handoffReason, RAN_AGAIN, SETTLED } from './handoff.ts';
import { handoffView, newerOf, newestOfItem } from './view.ts';

export type HandoffAction<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict'; message: string };

export interface HandoffsOptions {
  store: UserStore;
  clock: Clock;
  settings(): FailureSettings;
  rerun(jobId: string, by: RerunBy): Promise<RerunResult>;
  /** Dismiss a failed job's locked entry (issue #355). Throws when it is not one. */
  dismiss(jobId: string): void;
  logger: { warn(line: string): void };
  /** False once the assessor stopped: a deferred follow-up does nothing. */
  live(): boolean;
}

export interface Handoffs {
  /** In a transaction: hand the record's job off if automatic handling has ended for it. */
  afterRecord(record: FailureRecord): void;
  /** The records a restart (or the build before) left waiting on a person with no hand-off: handed off now. */
  catchUp(): void;
  /**
   * A failure nothing ran again, whose item ran again since by any way (issue #517): its record `superseded`. Its
   * hand-off closed already, on the new job's `job.queued`.
   */
  supersede(): void;
  /**
   * The open hand-offs nothing waits on any more (issue #529), closed: a newer job of its item (`superseded`), its
   * job finished (`finished`) or gone (`job_gone`). A store from the build before included.
   */
  settle(): void;
  /** Its item is closed at its source (issue #529): the open hand-off closes, its record `item_closed`. */
  itemClosed(id: string): void;
  /** Follow the job events that open or close a hand-off. */
  onEvent(e: DomainEvent): void;
  runAgain(id: string): Promise<HandoffAction<Job>>;
  clear(id: string): HandoffAction<Handoff>;
  prune(before: string): void;
}

const CATCH_UP = 1000;
/** The outcomes a newer job of the item supersedes (issue #517): nothing ran it again yet. */
const SUPERSEDABLE: FailureOutcome[] = ['surfaced', 'not_retried', 'held'];

export function createHandoffs(o: HandoffsOptions): Handoffs {
  const { store } = o;
  const nowIso = () => o.clock.now().toISOString();

  function open(jobId: string, reason: HandoffReason, record: FailureRecord | undefined): void {
    const current = store.handoffs.forJob(jobId);
    if (current?.status === 'open') {
      if (record && !record.handoffId) store.failures.update(record.id, { handoffId: current.id });
      return;
    }
    const job = store.jobs.get(jobId);
    const error = record?.evidence.error ?? job?.error ?? 'failed without a reason';
    const h = store.handoffs.create({
      jobId, status: 'open', reason, openedAt: nowIso(), error,
      summary: record?.summary ?? `Needs a person. Failed: ${error.split('\n', 1)[0]}.`, reasons: record?.reasons ?? [],
      ...(record ? { recordId: record.id, decision: record.decision, class: record.cls } : {}),
      ...(record?.problemId ? { problemId: record.problemId } : {}),
    });
    if (record) store.failures.update(record.id, { handoffId: h.id });
    store.events.append({
      type: 'handoff.opened', jobId,
      data: {
        handoffId: h.id, reason, summary: h.summary, notify: o.settings().handoffNotify,
        ...(record ? { recordId: record.id, decision: record.decision, class: record.cls } : {}),
        ...jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), jobId),
      },
    });
  }

  function close(h: Handoff, end: HandoffEnd, nextJobId?: string): Handoff {
    const closed = store.handoffs.update(h.id, { status: 'closed', closedAt: nowIso(), end, ...(nextJobId ? { nextJobId } : {}) });
    store.events.append({ type: 'handoff.closed', jobId: h.jobId, data: { handoffId: h.id, end, ...(nextJobId ? { nextJobId } : {}) } });
    return closed;
  }

  const openOf = (jobId: string): Handoff | undefined => {
    const h = store.handoffs.forJob(jobId);
    return h?.status === 'open' ? h : undefined;
  };

  /** A new job of the item: the hand-off of the job it runs again closes. */
  function onQueued(jobId: string): void {
    store.tx(() => {
      const prev = store.jobs.get(jobId)?.rerunOf;
      const h = prev ? openOf(prev) : undefined;
      if (h) close(h, 'run_again', jobId);
    });
  }

  /** A locked entry dismissed: forgotten only if a hand-off keeps it, so one opens unless something else ends it. */
  function onDismissed(jobId: string): void {
    store.tx(() => {
      const job = store.jobs.get(jobId);
      if (job?.status !== 'failed' || store.handoffs.forJob(jobId)) return;
      const r = store.failures.forJob(jobId);
      if (r && (r.pending || r.handoffId || (r.outcome && (RAN_AGAIN.includes(r.outcome) || SETTLED.includes(r.outcome))) || (r.outcome === 'held' && r.auto))) return;
      open(jobId, 'dismissed', r);
    });
  }

  function onFinished(jobId: string): void {
    store.tx(() => { const h = openOf(jobId); if (h) close(h, 'finished'); });
  }

  /** Why an open hand-off waits on nobody now, if it does not: its job gone or finished, or a newer job of its item. */
  function staleOf(h: Handoff): { end: HandoffEnd; nextJobId?: string } | undefined {
    const job = store.jobs.get(h.jobId);
    if (!job) return { end: 'job_gone' };
    if (job.status === 'finished') return { end: 'finished' };
    const newer = newerOf(store, job);
    return newer ? { end: 'superseded', nextJobId: newer } : undefined;
  }

  /** Its record, still waiting, says what ended it: nothing waits on it any more. */
  function settleRecord(h: Handoff, outcome: FailureOutcome, note: string, nextJobId?: string): void {
    const r = h.recordId ? store.failures.get(h.recordId) : store.failures.forJob(h.jobId);
    if (!r || r.pending || !(r.outcome && SUPERSEDABLE.includes(r.outcome))) return;
    store.failures.update(r.id, { outcome, outcomeAt: nowIso(), note, ...(nextJobId ? { nextJobId } : {}) });
  }

  return {
    afterRecord(record) {
      const why = handoffReason(record);
      if (why) open(record.jobId, why, record);
    },
    catchUp() {
      for (const r of store.failures.list({ limit: CATCH_UP })) {
        if (r.handoffId || !handoffReason(r)) continue;
        store.tx(() => {
          const job = store.jobs.get(r.jobId);
          const cur = store.failures.get(r.id);
          if (!cur || cur.handoffId || job?.status !== 'failed' || job.dismissedAt || !newestOfItem(store, job.id).ok) return;
          open(job.id, handoffReason(cur)!, cur);
        });
      }
    },
    supersede() {
      for (const r of store.failures.list({ outcome: SUPERSEDABLE, limit: 1_000_000 })) {
        const job = r.pending ? undefined : store.jobs.get(r.jobId);
        const newer = job ? newerOf(store, job) : undefined;
        if (newer) store.failures.update(r.id, { outcome: 'superseded', outcomeAt: nowIso(), nextJobId: newer, note: 'a newer job of its item exists' });
      }
    },
    settle() {
      for (const h of store.handoffs.list({ status: 'open', limit: 1_000_000 })) {
        store.tx(() => {
          const cur = store.handoffs.get(h.id);
          const stale = cur?.status === 'open' ? staleOf(cur) : undefined;
          if (!cur || !stale) return;
          close(cur, stale.end, stale.nextJobId);
          if (stale.end === 'superseded') settleRecord(cur, 'superseded', 'a newer job of its item exists', stale.nextJobId);
        });
      }
    },
    itemClosed(id) {
      store.tx(() => {
        const h = store.handoffs.get(id);
        if (h?.status !== 'open') return;
        close(h, 'item_closed');
        settleRecord(h, 'item_closed', 'its item is closed at its source');
      });
    },
    onEvent(e) {
      const id = e.jobId;
      if (!id) return;
      const later = (fn: (jobId: string) => void) => setImmediate(() => { if (o.live()) fn(id); });
      if (e.type === 'job.queued') later(onQueued);
      else if (e.type === 'job.dismissed') later(onDismissed);
      else if (e.type === 'job.finished') later(onFinished);
    },
    async runAgain(id) {
      const h = store.handoffs.get(id);
      if (!h) return { ok: false, reason: 'not_found', message: `hand-off ${id} not found` };
      const allowed = handoffView(store, h).actions.runAgain;
      if (!allowed.ok) return { ok: false, reason: 'conflict', message: `hand-off ${id} cannot run again: ${allowed.why}` };
      const result = await o.rerun(h.jobId, 'user');
      if (!result.ok) return { ok: false, reason: result.reason === 'not_found' ? 'not_found' : 'conflict', message: result.message };
      store.tx(() => {
        const cur = store.handoffs.get(id);
        if (cur?.status === 'open') close(cur, 'run_again', result.job.id);
        const r = h.recordId ? store.failures.get(h.recordId) : undefined;
        if (r && !(r.outcome && RAN_AGAIN.includes(r.outcome))) {
          store.failures.update(r.id, { outcome: 'retried', outcomeAt: nowIso(), nextJobId: result.job.id, note: 'run again by a person' });
        }
      });
      return { ok: true, value: result.job };
    },
    clear(id) {
      const done = store.tx((): HandoffAction<Handoff> => {
        const h = store.handoffs.get(id);
        if (!h) return { ok: false, reason: 'not_found', message: `hand-off ${id} not found` };
        if (h.status !== 'open') return { ok: false, reason: 'conflict', message: `hand-off ${id} is already closed` };
        return { ok: true, value: close(h, 'cleared') };
      });
      if (!done.ok) return done;
      const job = store.jobs.get(done.value.jobId);
      if (job?.status === 'failed' && job.dismissedAt === undefined) {
        try {
          o.dismiss(job.id);
        } catch (e) {
          o.logger.warn(`hopper: a cleared hand-off left job ${job.id} in the queue: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return done;
    },
    prune(before) {
      store.handoffs.prune(before);
    },
  };
}
