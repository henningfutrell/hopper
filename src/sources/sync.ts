// The sync loop: per source, pull (discover → ingest/re-sort), check (cancel signals), and push
// (the claim and the end of each job, event-driven with a retry scan). One writer of `sourceState.sync`; the adapter owns
// `sourceState.source`. Knows only the narrow SourceHost, never engine internals.
// A failing source is never silent (issue #358): its error is logged once when it changes (and once when
// it is ok again), and a source in error past the stall threshold records `source.stalled`, once per run
// of failures, which the notifiers send. The sources follow the
// plugins config live (issue #356, `setSources`): a new one is synced at once; a changed one (same name)
// is used from its next sync, for its jobs too; a removed one pulls nothing more, is paused as REMOVED,
// and goes once each of its jobs ended and its end is reported — a running job is never ended for it.

import { SourceError } from '../domain/ports.ts';
import type { Clock, JobSource, SourceHost, SourceRegistry, SourceReport } from '../domain/ports.ts';
import { TERMINAL_STATUSES, isRerunnable } from '../domain/types.ts';
import { REMOVED, followSources, newSlot, type NotRerun, type Slot } from './sync-slots.ts';
import type { DomainEvent, Job, SourceStatus } from '../domain/types.ts';
import { createRerun } from './rerun.ts';

export { REMOVED } from './sync-slots.ts';

export interface SourceSyncOptions {
  sources: JobSource[];
  host: SourceHost;
  clock: Clock;
  pollMs: (sourceName: string) => number;
  /** How long a source may stay in error before `source.stalled` is recorded. Default STALL_AFTER_MS. */
  stallAfterMs?: number;
}

/** A source in error this long has stopped intake: the owner is told. */
export const STALL_AFTER_MS = 30 * 60_000;

export type SourceSync = SourceRegistry & {
  start(): void;
  stop(): Promise<void>;
  syncNow(name?: string): Promise<void>;
  /** The sources as the plugins config names them now (issue #356). */
  setSources(sources: JobSource[]): void;
  /** The source synced under `name` now, a removed one still reporting its jobs included. */
  source(name: string): JobSource | undefined;
};


// Stored rows written before 2026-10-03 may also carry reportedQuestions, answeredQuestions and
// lastProgressAt; nothing reads them.
interface SyncFlags {
  claimReported?: boolean;
  finalReported?: boolean;
  cancelReason?: string;
  /** The failed job's item is closed: Run again is refused (issue #362). Set by closedItems or a refused re-run. */
  itemClosed?: boolean;
  permanentErrors?: Array<{ kind: string; message: string }>;
}

interface Hint { cancelReason?: string }

const NOT_REPORTED = 'its end is not reported to the source yet';

const TRIGGERS = new Set(['job.finished', 'job.failed', 'job.cancelled', 'job.rejected']);
const isTerminal = (j: Job) => TERMINAL_STATUSES.includes(j.status);
const flagsOf = (j: Job): SyncFlags => (j.sourceState?.sync ?? {}) as SyncFlags;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSourceSync(o: SourceSyncOptions): SourceSync {
  const { host, clock } = o;
  const stallAfterMs = o.stallAfterMs ?? STALL_AFTER_MS;
  const store = host.store;
  const slots = new Map<string, Slot>();
  const jobQueues = new Map<string, Promise<void>>();
  /** Job-level work (reports, cancels, deferred event handlers); a sync waits for it. */
  const pending = new Set<Promise<unknown>>();
  const syncs = new Set<Promise<unknown>>();
  const listeners = new Set<(s: SourceStatus) => void>();
  let unsubscribe: (() => void) | undefined;
  let running = false;

  for (const source of o.sources) slots.set(source.name, newSlot(source));

  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => undefined);
    return p;
  }

  async function drain() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  /** Reports and writes for one job never overlap: one promise chain per job. */
  function enqueue(jobId: string, fn: () => Promise<void>): Promise<void> {
    const next = (jobQueues.get(jobId) ?? Promise.resolve()).then(fn).catch(() => undefined);
    jobQueues.set(jobId, next);
    void next.then(() => { if (jobQueues.get(jobId) === next) jobQueues.delete(jobId); });
    return track(next);
  }

  // ---- reports ---------------------------------------------------------------------------

  function write(jobId: string, sync: SyncFlags, source?: Record<string, unknown>) {
    const cur = store.jobs.get(jobId)?.sourceState?.source;
    const keep = source ?? cur;
    host.setSourceState(jobId, { sync: sync as Record<string, unknown>, ...(keep ? { source: keep } : {}) });
  }

  /** Send one report. false: transient failure, stop this job's pass and retry next sync. */
  async function send(slot: Slot, jobId: string, kind: string, build: (job: Job) => SourceReport, mark: (f: SyncFlags) => SyncFlags): Promise<boolean> {
    const job = store.jobs.get(jobId);
    if (!job) return false;
    try {
      const source = await slot.source.report(build(job));
      write(jobId, mark(flagsOf(store.jobs.get(jobId) ?? job)), source);
      slot.retrying.delete(jobId);
      return true;
    } catch (e) {
      if (e instanceof SourceError && e.permanent) {
        const f = flagsOf(store.jobs.get(jobId) ?? job);
        write(jobId, mark({ ...f, permanentErrors: [...(f.permanentErrors ?? []), { kind, message: e.message }] }));
        return true;
      }
      slot.retrying.set(jobId, message(e));
      return false;
    }
  }

  /**
   * A failed job whose item its source finds closed as complete is finished instead (issue #350), before
   * its end is reported. false: asking failed; the job's pass stops and the next sync asks again.
   */
  async function finishedIfClosedAsComplete(slot: Slot, job: Job): Promise<boolean> {
    if (!slot.source.closedAsComplete) return true;
    try {
      if (await slot.source.closedAsComplete(job)) host.finishClosedAsComplete(job.id);
      return true;
    } catch (e) {
      slot.retrying.set(job.id, message(e));
      return false;
    }
  }

  async function reportJob(slot: Slot, jobId: string, hint: Hint): Promise<void> {
    let job = store.jobs.get(jobId);
    if (!job || job.source?.source !== slot.source.name) return;
    if (!flagsOf(job).claimReported) {
      if (!await send(slot, jobId, 'claimed', (j) => ({ kind: 'claimed', job: j }), (f) => ({ ...f, claimReported: true }))) return;
    }
    job = store.jobs.get(jobId)!;
    if (!isTerminal(job) || flagsOf(job).finalReported) return;
    if (job.status === 'failed' && !await finishedIfClosedAsComplete(slot, job)) return;
    job = store.jobs.get(jobId)!;
    const flags = flagsOf(job);
    if (job.status === 'cancelled' && !flags.cancelReason && hint.cancelReason) write(jobId, { ...flags, cancelReason: hint.cancelReason });
    const kind = job.status === 'finished' || job.status === 'failed' || job.status === 'rejected' ? job.status : 'cancelled';
    await send(slot, jobId, kind, (j) => ({ kind, job: j }), (f) => ({ ...f, finalReported: true }));
  }

  function queueReport(slot: Slot, jobId: string, hint: Hint = {}): Promise<void> {
    return enqueue(jobId, () => reportJob(slot, jobId, hint));
  }

  function onEvent(e: DomainEvent) {
    if (!running || !e.jobId || !TRIGGERS.has(e.type)) return;
    const jobId = e.jobId;
    const hint: Hint = e.type === 'job.cancelled' && typeof e.data.reason === 'string' ? { cancelReason: e.data.reason } : {};
    // Listeners fire inside append; never call a source from there.
    track(new Promise<void>((resolve) => setImmediate(() => {
      const slot = slots.get(store.jobs.get(jobId)?.source?.source ?? '');
      resolve(slot && running ? queueReport(slot, jobId, hint) : undefined);
    })));
  }

  // ---- one sync of one source ------------------------------------------------------------

  const jobsOf = (slot: Slot) => store.jobs.list().filter((j) => j.source?.source === slot.source.name);

  async function applySignals(slot: Slot, active: Job[]) {
    const ids = new Set(active.map((j) => j.id));
    for (const s of await slot.source.check(active)) {
      if (!ids.has(s.jobId)) continue;
      await enqueue(s.jobId, async () => {
        const job = store.jobs.get(s.jobId);
        if (!job || isTerminal(job)) return;
        write(job.id, { ...flagsOf(job), cancelReason: s.reason });
        host.cancel(job.id, s.reason);
      });
    }
  }

  /**
   * Operator-led jobs (issue #318) have no executor to end them: each sync asks the source whether
   * the work is complete — its closing pull request reached the completion — and finishes the job when it is.
   * An error asking is kept as a retry, as a failing report is; the job stays operator-led.
   */
  async function finishCompleteOperatorLed(slot: Slot, active: Job[]) {
    const notComplete = slot.source.notComplete?.bind(slot.source);
    if (!notComplete) return;
    for (const job of active.filter((j) => j.status === 'operator_led')) {
      await enqueue(job.id, async () => {
        try {
          if (await notComplete(job) === undefined) host.finishOperatorLed(job.id);
        } catch (e) {
          slot.retrying.set(job.id, message(e));
        }
      });
    }
  }

  async function pull(slot: Slot): Promise<{ seen: number; created: number }> {
    const items = await slot.source.discover();
    let created = 0;
    const notRerun: NotRerun[] = [];
    for (const item of items) {
      const existing = store.jobs.getBySourceKey(item.key);
      if (existing && isTerminal(existing) && !isRerunnable(existing)) notRerun.push({ key: item.key, job: existing.id, status: existing.status, reason: NOT_REPORTED });
      if (existing && !isRerunnable(existing)) host.reprioritize(existing.id, item.priority, item.priorityReason);
      else if (host.ingest(item, { name: slot.source.name, kind: slot.source.kind })) created++;
    }
    for (const n of notRerun) {
      if (slot.loggedNotRerun.has(n.key)) continue;
      slot.loggedNotRerun.add(n.key);
      console.warn(`hopper: ${n.key} not run again: job ${n.job} ${n.status}, ${n.reason}`);
    }
    slot.notRerun = notRerun;
    return { seen: items.length, created };
  }

  /** Log a changed error, or the end of one; record source.stalled once a run of failures passes the threshold. */
  function told(slot: Slot, previous: string | undefined) {
    const st = slot.status;
    const name = slot.source.name;
    if (st.state !== 'error') {
      if (slot.failing) console.warn(`hopper: source ${name} is ok again`);
      delete slot.failing;
      return;
    }
    if (st.lastError !== previous) console.warn(`hopper: source ${name} failed: ${st.lastError}`);
    slot.failing ??= { since: clock.now().toISOString(), stalled: false };
    if (slot.failing.stalled || clock.now().getTime() - Date.parse(slot.failing.since) < stallAfterMs) return;
    slot.failing.stalled = true;
    store.events.append({ type: 'source.stalled', data: { source: name, kind: slot.source.kind, error: st.lastError ?? '', since: slot.failing.since } });
  }

  async function syncOnce(slot: Slot) {
    const st = slot.status;
    const previous = st.state === 'error' ? st.lastError : undefined;
    // Paused: nothing new is pulled, but the source's own active jobs are still checked and reported.
    const paused = slot.removed ? REMOVED : slot.source.paused?.();
    try {
      if (paused === undefined) {
        const { seen, created } = await pull(slot);
        st.itemsSeen = seen;
        st.jobsCreated += created;
      } else {
        st.itemsSeen = 0;
        slot.notRerun = [];
      }
      await applySignals(slot, jobsOf(slot).filter((j) => !isTerminal(j)));
      await finishCompleteOperatorLed(slot, jobsOf(slot).filter((j) => !isTerminal(j)));
      await Promise.all(jobsOf(slot)
        .filter((j) => !isTerminal(j) || !flagsOf(j).finalReported || !flagsOf(j).claimReported)
        .map((j) => queueReport(slot, j.id)));
      await drain();
      if (paused === undefined) await rerunning.markClosedItems(slot.source, jobsOf(slot));
      st.state = 'ok';
      st.lastOkAt = clock.now().toISOString();
      delete st.lastError;
    } catch (e) {
      st.state = 'error';
      st.lastError = message(e);
    }
    told(slot, previous);
    const jobs = jobsOf(slot);
    st.lastSyncAt = clock.now().toISOString();
    st.activeJobs = jobs.filter((j) => !isTerminal(j)).length;
    if (paused !== undefined && st.state === 'ok' && st.activeJobs === 0) st.state = 'disabled';
    st.detail = {
      ...slot.source.describe(),
      ...(paused !== undefined ? { paused } : {}),
      permanentErrors: jobs.filter((j) => flagsOf(j).permanentErrors?.length).length,
      reportRetries: slot.retrying.size,
      ...(slot.notRerun.length ? { notRerun: slot.notRerun } : {}),
    };
    if (slot.removed && st.state !== 'error' && jobs.every((j) => isTerminal(j) && flagsOf(j).claimReported && flagsOf(j).finalReported)) {
      // Nothing of its own is left to report: the removed source goes.
      if (slots.get(slot.source.name) === slot) slots.delete(slot.source.name);
      delete st.nextSyncAt;
      emit(slot);
      return;
    }
    schedule(slot);
    emit(slot);
  }

  function schedule(slot: Slot) {
    if (!running) { delete slot.status.nextSyncAt; return; }
    const ms = o.pollMs(slot.source.name);
    slot.status.nextSyncAt = new Date(clock.now().getTime() + ms).toISOString();
    slot.timer = setTimeout(() => { void runSync(slot); }, ms);
  }

  function runSync(slot: Slot): Promise<void> {
    clearTimeout(slot.timer);
    slot.chain = slot.chain.then(() => syncOnce(slot));
    syncs.add(slot.chain);
    void slot.chain.finally(() => syncs.delete(slot.chain)).catch(() => undefined);
    return slot.chain;
  }

  const emit = (slot: Slot) => { for (const l of listeners) l({ ...slot.status }); };

  const rerunning = createRerun({
    host, flagsOf, enqueue,
    sourceOf: (job) => (running ? slots.get(job.source?.source ?? '')?.source : undefined),
    writeFlags: (jobId, flags) => write(jobId, { ...flagsOf(store.jobs.get(jobId)!), ...flags }),
    syncSoon: (source) => { const slot = slots.get(source.name); if (slot) void runSync(slot); },
  });

  return {
    statuses: () => [...slots.values()].map((s) => ({ ...s.status })),
    onStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    rerun: rerunning.rerun,
    start() {
      if (running) return;
      running = true;
      unsubscribe = store.events.subscribe(onEvent);
      for (const slot of slots.values()) void runSync(slot);
    },
    async stop() {
      running = false;
      unsubscribe?.();
      for (const slot of slots.values()) clearTimeout(slot.timer);
      await drain();
      await Promise.allSettled([...syncs]);
      await drain();
    },
    async syncNow(name) {
      const targets = [...slots.values()].filter((s) => !name || s.source.name === name);
      await Promise.all(targets.map((s) => runSync(s)));
    },
    setSources(sources) {
      for (const slot of followSources(slots, sources)) if (running) void runSync(slot);
    },
    source: (name) => slots.get(name)?.source,
  };
}
