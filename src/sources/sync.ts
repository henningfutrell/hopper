// The sync loop: per source, pull (discover → ingest/re-sort), check (signals), and push
// (event-driven reports with a retry scan). One writer of `sourceState.sync`; the adapter owns
// `sourceState.source`. Knows only the narrow SourceHost, never engine internals.

import { SourceError } from '../domain/ports.ts';
import type { Clock, JobSource, SourceHost, SourceRegistry, SourceReport } from '../domain/ports.ts';
import { TERMINAL_STATUSES } from '../domain/types.ts';
import type { DomainEvent, Job, Question, SourceStatus } from '../domain/types.ts';

export interface SourceSyncOptions {
  sources: JobSource[];
  host: SourceHost;
  clock: Clock;
  pollMs: (sourceName: string) => number;
  progressThrottleMs: (sourceName: string) => number;
}

export type SourceSync = SourceRegistry & {
  start(): void;
  stop(): Promise<void>;
  syncNow(name?: string): Promise<void>;
};

interface SyncFlags {
  claimReported?: boolean;
  reportedQuestions?: string[];
  answeredQuestions?: string[];
  finalReported?: boolean;
  lastProgressAt?: string;
  cancelReason?: string;
  permanentErrors?: Array<{ kind: string; message: string }>;
}

interface Hint { progress?: boolean; cancelReason?: string }

interface Slot {
  source: JobSource;
  status: SourceStatus;
  chain: Promise<void>;
  timer?: NodeJS.Timeout;
  /** Last transient report error per job, shown as detail.reportRetries. */
  retrying: Map<string, string>;
}

const TRIGGERS = new Set(['job.progressed', 'question.escalated', 'question.answered', 'job.finished', 'job.failed', 'job.cancelled']);
const isTerminal = (j: Job) => TERMINAL_STATUSES.includes(j.status);
const flagsOf = (j: Job): SyncFlags => (j.sourceState?.sync ?? {}) as SyncFlags;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSourceSync(o: SourceSyncOptions): SourceSync {
  const { host, clock } = o;
  const store = host.store;
  const slots = new Map<string, Slot>();
  const jobQueues = new Map<string, Promise<void>>();
  /** Job-level work (reports, cancels, deferred event handlers); a sync waits for it. */
  const pending = new Set<Promise<unknown>>();
  const syncs = new Set<Promise<unknown>>();
  const listeners = new Set<(s: SourceStatus) => void>();
  let unsubscribe: (() => void) | undefined;
  let running = false;

  for (const source of o.sources) {
    slots.set(source.name, {
      source, chain: Promise.resolve(), retrying: new Map(),
      status: { name: source.name, kind: source.kind, state: 'starting', itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail: source.describe() },
    });
  }

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

  async function reportQuestions(slot: Slot, jobId: string): Promise<boolean> {
    const qs = store.questions.list({ jobId }).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const q of qs) {
      const flags = flagsOf(store.jobs.get(jobId)!);
      if (q.status === 'open' && q.tier === 'human' && !flags.reportedQuestions?.includes(q.id)) {
        const ok = await send(slot, jobId, 'question', (job) => ({ kind: 'question', job, question: q }),
          (f) => ({ ...f, reportedQuestions: [...(f.reportedQuestions ?? []), q.id] }));
        if (!ok) return false;
      } else if (q.status === 'answered' && !flags.answeredQuestions?.includes(q.id)) {
        const ok = await send(slot, jobId, 'answered', (job) => ({ kind: 'answered', job, question: fresh(q) }),
          (f) => ({ ...f, answeredQuestions: [...(f.answeredQuestions ?? []), q.id] }));
        if (!ok) return false;
      }
    }
    return true;
  }

  const fresh = (q: Question) => store.questions.get(q.id) ?? q;

  async function reportJob(slot: Slot, jobId: string, hint: Hint): Promise<void> {
    let job = store.jobs.get(jobId);
    if (!job || job.source?.source !== slot.source.name) return;
    if (!flagsOf(job).claimReported) {
      if (!await send(slot, jobId, 'claimed', (j) => ({ kind: 'claimed', job: j }), (f) => ({ ...f, claimReported: true }))) return;
    }
    if (!await reportQuestions(slot, jobId)) return;
    job = store.jobs.get(jobId)!;
    const flags = flagsOf(job);
    if (isTerminal(job)) {
      if (flags.finalReported) return;
      if (job.status === 'cancelled' && !flags.cancelReason && hint.cancelReason) write(jobId, { ...flags, cancelReason: hint.cancelReason });
      const kind = job.status === 'finished' ? 'finished' : job.status === 'failed' ? 'failed' : 'cancelled';
      await send(slot, jobId, kind, (j) => ({ kind, job: j }), (f) => ({ ...f, finalReported: true }));
      return;
    }
    if (!hint.progress) return;
    const nowMs = clock.now().getTime();
    if (flags.lastProgressAt && nowMs - Date.parse(flags.lastProgressAt) < o.progressThrottleMs(slot.source.name)) return;
    await send(slot, jobId, 'progress', (j) => ({ kind: 'progress', job: j, message: j.progressMessage ?? '' }),
      (f) => ({ ...f, lastProgressAt: clock.now().toISOString() }));
  }

  function queueReport(slot: Slot, jobId: string, hint: Hint = {}): Promise<void> {
    return enqueue(jobId, () => reportJob(slot, jobId, hint));
  }

  function onEvent(e: DomainEvent) {
    if (!running || !e.jobId || !TRIGGERS.has(e.type)) return;
    const jobId = e.jobId;
    const hint: Hint = {
      ...(e.type === 'job.progressed' ? { progress: true } : {}),
      ...(e.type === 'job.cancelled' && typeof e.data.reason === 'string' ? { cancelReason: e.data.reason } : {}),
    };
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
      if (s.kind === 'answer') { host.answer(s.questionId, s.answer); continue; }
      await enqueue(s.jobId, async () => {
        const job = store.jobs.get(s.jobId);
        if (!job || isTerminal(job)) return;
        write(job.id, { ...flagsOf(job), cancelReason: s.reason });
        host.cancel(job.id, s.reason);
      });
    }
  }

  async function pull(slot: Slot): Promise<{ seen: number; created: number }> {
    const items = await slot.source.discover();
    let created = 0;
    for (const item of items) {
      const existing = store.jobs.getBySourceKey(item.key);
      if (existing) host.reprioritize(existing.id, item.priority, item.priorityReason);
      else if (host.ingest(item, { name: slot.source.name, kind: slot.source.kind })) created++;
    }
    return { seen: items.length, created };
  }

  async function syncOnce(slot: Slot) {
    const st = slot.status;
    try {
      const { seen, created } = await pull(slot);
      st.itemsSeen = seen;
      st.jobsCreated += created;
      await applySignals(slot, jobsOf(slot).filter((j) => !isTerminal(j)));
      await Promise.all(jobsOf(slot)
        .filter((j) => !isTerminal(j) || !flagsOf(j).finalReported || !flagsOf(j).claimReported)
        .map((j) => queueReport(slot, j.id)));
      await drain();
      st.state = 'ok';
      st.lastOkAt = clock.now().toISOString();
      delete st.lastError;
    } catch (e) {
      st.state = 'error';
      st.lastError = message(e);
    }
    const jobs = jobsOf(slot);
    st.lastSyncAt = clock.now().toISOString();
    st.activeJobs = jobs.filter((j) => !isTerminal(j)).length;
    st.detail = {
      ...slot.source.describe(),
      permanentErrors: jobs.filter((j) => flagsOf(j).permanentErrors?.length).length,
      reportRetries: slot.retrying.size,
    };
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

  return {
    statuses: () => [...slots.values()].map((s) => ({ ...s.status })),
    onStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
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
  };
}
