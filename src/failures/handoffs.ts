// Needs a person (issue #516, design.md "Needs a person"): a failed job automatic handling has ended for is handed off
// to a person, and the hand-off stays open until a person acts — never dropped by age, a restart, or the recent
// failures' window. It opens when the assessor's record waits on a person (`handoffReason`), when a run again the
// assessor decided is refused, or when a failed job's locked entry is dismissed with nothing else to end it. It
// closes when its item runs again — from here, the Queue, the failure's Retry or the source; its record then turns
// `superseded` unless a run again is recorded on it (issue #517) —, when a person resolves it (issue #551), or when
// its job ends finished. Each is an event. A person's resolution says what they did, with a note: Continue (its job's
// own agent session resumes in its work tree, told the failure and the note; a new job of its item, told the same,
// when it cannot), I fixed it (its item runs again, told the note), Done by hand (its job ends finished, with a link)
// or Won't do (its locked entry dismissed: no more work). It is kept on the hand-off with who and when, and its job's
// source is told (the sync loop, `handoff.closed` with `resolution`). Stale data clears itself (issue
// #529): the sweep, and the start, close an open hand-off nothing waits on any more — a newer job of its item that no
// `job.queued` closed it for (a store from the build before), its job finished or gone, its item closed at its source.
import type { Clock, RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import {
  jobPriorityTag, type ActingPerson, type DomainEvent, type FailureOutcome, type FailureRecord, type FailureSettings, type Handoff, type HandoffEnd, type HandoffReason,
  type ContinuedBy, type HandoffResolution, type HandoffResolutionAction, type HandoffView, type Job,
} from '../domain/types.ts';
import { handoffBrief } from './brief.ts';
import { handoffReason, RAN_AGAIN, SETTLED } from './handoff.ts';
import { handoffView, newerOf, newestOfItem, RESOLUTION_TEXT } from './view.ts';

export type HandoffAction<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict'; message: string };

/** What a person sends to resolve a hand-off (issue #551). */
export interface HandoffResolve { action: HandoffResolutionAction; note?: string; link?: string }

export interface HandoffsOptions {
  store: UserStore;
  clock: Clock;
  settings(): FailureSettings;
  /** Run an ended job's item again: the sync loop's Run again; `brief` what the new job is told after its prompt. */
  rerun(jobId: string, by: RerunBy, brief?: string, acting?: ActingPerson): Promise<RerunResult>;
  /** Continue a failed job in its own agent session (issue #551): the sync loop's. */
  continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult>;
  /** Whether the job's own agent session can resume: its executor parks, and it recorded one. */
  resumable(job: Job): boolean;
  /** Dismiss a failed job's locked entry (issue #355): Won't do leaves the queue too. Throws when it is not one. */
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
  /** A person resolves an open hand-off (issue #551), `by` the person the UI session signed in, and the way (issue #623). */
  resolve(id: string, input: HandoffResolve, by: ActingPerson): Promise<HandoffAction<{ handoff: HandoffView; job?: Job }>>;
  /** The hand-off as the Failures view shows it. */
  view(h: Handoff): HandoffView;
  prune(before: string): void;
}

const CATCH_UP = 1000;

/** Who resolved it, as the events name them (issue #623); none for a resolution made before. */
const actingOf = (r: HandoffResolution | undefined): ActingPerson | undefined => (r?.via ? { person: r.by, via: r.via } : undefined);
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

  function close(h: Handoff, end: HandoffEnd, nextJobId?: string, resolution?: HandoffResolution): Handoff {
    const closed = store.handoffs.update(h.id, { status: 'closed', closedAt: nowIso(), end, ...(nextJobId ? { nextJobId } : {}), ...(resolution ? { resolution } : {}) });
    const acting = actingOf(resolution);
    store.events.append({
      type: 'handoff.closed', jobId: h.jobId,
      data: { handoffId: h.id, end, ...(nextJobId ? { nextJobId } : {}), ...(resolution ? { resolution: resolution.action } : {}), ...acting },
    });
    return closed;
  }

  /** Hand-offs a person is resolving now: the new job's `job.queued` leaves them to the resolution to close. */
  const resolving = new Set<string>();
  const view = (h: Handoff): HandoffView => handoffView(store, h, o.resumable);

  const openOf = (jobId: string): Handoff | undefined => {
    const h = store.handoffs.forJob(jobId);
    return h?.status === 'open' ? h : undefined;
  };

  /** A new job of the item: the hand-off of the job it runs again closes. */
  function onQueued(jobId: string): void {
    store.tx(() => {
      const prev = store.jobs.get(jobId)?.rerunOf;
      const h = prev ? openOf(prev) : undefined;
      if (h && !resolving.has(h.id)) close(h, 'run_again', jobId);
    });
  }

  /** The record a person's resolution settles: run again (`retried`), or resolved without (`resolved`). */
  function settleByPerson(h: Handoff, outcome: 'retried' | 'resolved', note: string, nextJobId?: string): void {
    const r = h.recordId ? store.failures.get(h.recordId) : undefined;
    if (!r || (r.outcome && RAN_AGAIN.includes(r.outcome))) return;
    store.failures.update(r.id, { outcome, outcomeAt: nowIso(), note, pending: undefined, pendingAt: undefined, ...(nextJobId ? { nextJobId } : {}) });
  }

  /** Close it with the resolution, in a tx, unless something closed it meanwhile. */
  function resolveWith(id: string, end: HandoffEnd, resolution: HandoffResolution, nextJobId: string | undefined, then: (h: Handoff) => void): HandoffAction<Handoff> {
    return store.tx((): HandoffAction<Handoff> => {
      const cur = store.handoffs.get(id);
      if (!cur) return { ok: false, reason: 'not_found', message: `hand-off ${id} not found` };
      if (cur.status !== 'open') return { ok: false, reason: 'conflict', message: `hand-off ${id} is already closed` };
      const closed = close(cur, end, nextJobId, resolution);
      then(closed);
      return { ok: true, value: closed };
    });
  }

  /** Dismiss its job's locked entry: no more work. A failure to is logged; the hand-off is closed all the same. */
  function dismissLocked(jobId: string): void {
    const job = store.jobs.get(jobId);
    if (job?.status !== 'failed' || job.dismissedAt !== undefined) return;
    try {
      o.dismiss(job.id);
    } catch (e) {
      o.logger.warn(`hopper: a resolved hand-off left job ${job.id} in the queue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Run its item again, told `brief`: the new job follows the hand-off. */
  async function runAgainWith(h: Handoff, brief: string, resolution: HandoffResolution, note: string): Promise<HandoffAction<{ handoff: Handoff; job?: Job }>> {
    resolving.add(h.id);
    try {
      const result = await o.rerun(h.jobId, 'user', brief, actingOf(resolution));
      if (!result.ok) return { ok: false, reason: result.reason === 'not_found' ? 'not_found' : 'conflict', message: result.message };
      const closed = resolveWith(h.id, 'run_again', resolution, result.job.id, (c) => settleByPerson(c, 'retried', note, result.job.id));
      // Closed meanwhile (its item ran again by another way): the new job stands, the resolution is not kept.
      return closed.ok ? { ok: true, value: { handoff: closed.value, job: result.job } } : closed;
    } finally {
      resolving.delete(h.id);
    }
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
    async resolve(id, input, by) {
      const h = store.handoffs.get(id);
      if (!h) return { ok: false, reason: 'not_found', message: `hand-off ${id} not found` };
      const shown = view(h);
      const key = { continue: 'continue', fixed: 'fixed', done_by_hand: 'doneByHand', wont_do: 'wontDo' } as const;
      const allowed = shown.actions[key[input.action]];
      if (!allowed.ok) return { ok: false, reason: 'conflict', message: `hand-off ${id} cannot be ${RESOLUTION_TEXT[input.action]}: ${allowed.why}` };
      const job = store.jobs.get(h.jobId);
      const resolution: HandoffResolution = {
        action: input.action, by: by.person, via: by.via, at: nowIso(), ...(input.note ? { note: input.note } : {}), ...(input.link ? { link: input.link } : {}),
        writeBack: job?.source ? 'pending' : 'none',
      };
      const done = (r: HandoffAction<{ handoff: Handoff; job?: Job }>): HandoffAction<{ handoff: HandoffView; job?: Job }> =>
        (r.ok ? { ok: true, value: { handoff: view(r.value.handoff), ...(r.value.job ? { job: r.value.job } : {}) } } : r);
      if (input.action === 'continue' && shown.continueResumes) {
        const brief = handoffBrief(h, 'continue', input.note, true);
        resolving.add(h.id);
        try {
          const result = await o.continueJob(h.jobId, brief, { handoffId: h.id });
          if (!result.ok) return { ok: false, reason: result.reason === 'not_found' ? 'not_found' : 'conflict', message: result.message };
          const closed = resolveWith(h.id, 'continued', { ...resolution, resumed: true }, h.jobId, (c) => settleByPerson(c, 'retried', 'continued by a person', h.jobId));
          return done(closed.ok ? { ok: true, value: { handoff: closed.value, job: result.job } } : closed);
        } finally {
          resolving.delete(h.id);
        }
      }
      if (input.action === 'continue') {
        return done(await runAgainWith(h, handoffBrief(h, 'continue', input.note, false), { ...resolution, resumed: false }, 'continued by a person in a new job'));
      }
      if (input.action === 'fixed') return done(await runAgainWith(h, handoffBrief(h, 'fixed', input.note, false), resolution, 'fixed and run again by a person'));
      const alone = (r: HandoffAction<Handoff>): HandoffAction<{ handoff: Handoff }> => (r.ok ? { ok: true, value: { handoff: r.value } } : r);
      if (input.action === 'done_by_hand') {
        return done(alone(resolveWith(id, 'done_by_hand', resolution, undefined, (c) => {
          settleByPerson(c, 'resolved', 'done by hand');
          // Its job ends finished: the work is done, by a person.
          if (store.jobs.get(c.jobId)?.status !== 'failed') return;
          const result = { summary: 'done by hand', ...(resolution.link ? { link: resolution.link } : {}) };
          store.jobs.update(c.jobId, { status: 'finished', error: undefined, result, finishedAt: nowIso() });
          store.events.append({ type: 'job.finished', jobId: c.jobId, data: { result } });
        })));
      }
      const closed = resolveWith(id, 'wont_do', resolution, undefined, (c) => settleByPerson(c, 'resolved', `won't do${resolution.note ? `: ${resolution.note}` : ''}`));
      if (closed.ok) dismissLocked(closed.value.jobId);
      return done(alone(closed));
    },
    view,
    prune(before) {
      store.handoffs.prune(before);
    },
  };
}
