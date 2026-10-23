// The sync loop: per source, pull (discover → ingest/re-sort), check (cancel signals), and push
// (the claim and the end of each job, event-driven with a retry scan). One writer of `sourceState.sync`; the adapter owns
// `sourceState.source`. Knows only the narrow SourceHost, never engine internals.
// A failing source is never silent (issue #358): its error is logged once when it changes (and once when
// it is ok again), and a source in error past the stall threshold records `source.stalled`, once per run
// of failures, which the notifiers send. The sources follow the
// plugins config live (issue #356, `setSources`): a new one is synced at once; a changed one (same name)
// is used from its next sync, for its jobs too; a removed one pulls nothing more, is paused as REMOVED,
// and goes once each of its jobs ended and its end is reported — a running job is never ended for it.
// A started job whose item is no longer assigned to its account is flagged, never ended (issue #387).
// A person's resolution of a hand-off (issue #551) is told to its job's item on the job's report chain, after the job's
// own end, when it is recorded and again at each sync until the source took it. After done (issue #579, `after-done.ts`): a
// finished job's pull request is followed to its merge or close, and a job that failed only for want of a merge is judged again.
// The in-motion cycle (issue #985, `followRound`): a sync follows pull requests in rounds, not each time. Every cycle interval
// it follows only the pull requests in motion; every reconcile interval it follows every one and reconciles; between rounds
// it follows none. The first sync, a sync a person asked for, and the sync after a merge or close follow every one. A pull
// request merged or closed while a source syncs makes its next sync run at once, so the others are seen and tended on the
// new base; one merged or closed between syncs (a person's Merge now) starts a sync at once.
// What a sync reads (issue #985): the first sync after start, a sync of a source new or changed in the plugins config, and a
// sync a person asked for (Sync now, an intake action, a new connection) ask the source to read everything again; every
// other sync — its timer, one after a merge, a rerun — only what is due (`discover({ due: true })`).
// A GitHub delivery (issue #1079, `repoChanged`) makes the repository due at each source whose job repository it is, and
// that source syncs once `DELIVERY_SYNC_MS` after the first delivery of a burst: a timed sync, before its timer.
// The GitHub outbox (issue #1238): an intake action answers and asks for no full sync. Its source's outbox sends its rows `OUTBOX_BATCH_MS`
// after it (a burst in one batch), and every `OUTBOX_EVERY_MS` the rows due; each repository a send wrote to is made due, and the source syncs then, a timed sync. A sync never waits for the outbox.
// Poll backoff (issue #1264, `poll-backoff.ts`): a configured source's timed syncs that find nothing changed come further
// apart; each pass's calls go to the call log, and its status shows its poll interval and its calls in the last hour and day.
// Waited pull requests (issue #1433, `waited-pull-requests.ts`): at every sync, each pull request a job of the source waits on
// is read, and the jobs on one merged or closed are woken, though no follow recorded its end.
import { SourceError } from '../domain/ports.ts';
import type { Clock, JobSource, SourceHost, SourceRegistry, SourceReport } from '../domain/ports.ts';
import { TERMINAL_STATUSES, isRerunnable, type ActingPerson, type DomainEvent, type JevFirst, type Job, type SourceCallLog, type SourceStatus } from '../domain/types.ts'; import type { GiveBackCheck, GiveBackChecked } from '../domain/give-back.ts';
import { offer } from './item-text.ts'; import { loopYield } from '../domain/yield-loop.ts';
import { intakeOrder } from './intake-order.ts';
import { REMOVED, detailOf, dropRetries, followSources, joined, keepArrivals, keepNotRerun, newSlot, notAssignedTold, told, type NotRerun, type Slot } from './sync-slots.ts';
import { liveIntake, withTakenStatus } from './intake-live.ts';
import { needsWork, pauseTold } from './sync-setup.ts';
import { createRerun } from './rerun.ts';
import { createWriteBacks } from './write-back.ts';
import { createAfterDone } from './after-done.ts';
import { createThreadAsks } from './thread-asks.ts'; import { createCommentWakes } from './comment-wakes.ts';
import { followRound, PR_ENDED, type FollowEvery } from './follow-rounds.ts'; import { waitedPullRequestEnds } from './waited-pull-requests.ts'; import { watchedEnds } from './watched-ends.ts';
import { signalsApplier, type SyncFlags } from './sync-signals.ts';
import { finishedIfClosedAsComplete } from './closed-as-complete.ts'; import { createFixingReports } from './fixing-reports.ts';
import { createAfterAnswerTimings, syncAsks, timed, timedSync, withAct } from './after-answer-timings.ts'; import { afterSync, answerPrint, nextPollMs } from './poll-backoff.ts'; import { outboxFlushes } from './outbox-flush.ts'; import { causeNow, traceSync } from '../telemetry/sources.ts';

export { REMOVED } from './sync-slots.ts';

export interface SourceSyncOptions {
  sources: JobSource[];
  host: SourceHost;
  clock: Clock;
  pollMs: (sourceName: string) => number;
  /** How long a source may stay in error before `source.stalled` is recorded. Default STALL_AFTER_MS. */
  stallAfterMs?: number;
  /** Jev first, for the order new items enter and the head of each tending queue (issue #796); absent: the rules decide. */
  jevFirst?: JevFirst;
  /** How often a round follows the pull requests in motion, and every one (issue #985), read at each sync. Absent: every sync follows every one. */
  followEvery?: () => FollowEvery;
  /** Poll backoff (issue #1264): whether the source's timed syncs come further apart while they find nothing changed (absent: never); the call log: each pass's calls, and each status shows the last hour and day from it. */
  backoff?: (sourceName: string) => boolean; calls?: SourceCallLog;
  outboxBatchMs?: number; // the outbox's batch window after an intake action (issue #1238); default OUTBOX_BATCH_MS
}

/** How long after a GitHub delivery its sources sync (issue #1079): GitHub sends opened, labeled and assigned at once. */
export const DELIVERY_SYNC_MS = 2_000;

/** A source in error this long has stopped intake: the owner is told. */
export const STALL_AFTER_MS = 30 * 60_000;

export type SourceSync = SourceRegistry & {
  start(): void;
  stop(): Promise<void>;
  syncNow(name?: string): Promise<void>;
  /** The sources as the plugins config names them now (issue #356). */
  setSources(sources: JobSource[]): void;
  /** The source synced under `name` now, a removed one still reporting its jobs included. */
  source(name: string): JobSource | undefined; giveBackChecks(check: GiveBackCheck): void; checkTendAgain(jobId: string, acting: ActingPerson): GiveBackChecked; // the services' checks of Retry, Continue, I fixed it, Push it and Tend again (issue #1238 part 5), set once they exist; Tend again's own, which they ask for `tend`
};


interface Hint { cancelReason?: string }

const NOT_REPORTED = 'its end is not reported to the source yet';

// `job.assessed`: a failure whose report waits on its assessment (issue #1230, `fixing`).
const TRIGGERS = new Set(['job.finished', 'job.failed', 'job.cancelled', 'job.rejected', 'job.assessed']);
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
  /** How the work after each person's act waited and ran (issue #1194). */
  const timings = createAfterAnswerTimings(() => clock.now());

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
    const next = (jobQueues.get(jobId) ?? Promise.resolve()).then(timed(timings, fn)).catch(() => undefined);
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
    } catch (e) {
      if (!(e instanceof SourceError && e.permanent)) {
        slot.retrying.set(jobId, message(e));
        return false;
      }
      const f = flagsOf(store.jobs.get(jobId) ?? job);
      write(jobId, mark({ ...f, permanentErrors: [...(f.permanentErrors ?? []), { kind, message: e.message }] }));
    }
    // Reported, or never to be (issue #1402): no retry is left.
    slot.retrying.delete(jobId);
    return true;
  }


  async function reportJob(slot: Slot, jobId: string, hint: Hint): Promise<void> {
    let job = store.jobs.get(jobId);
    if (!job || job.source?.source !== slot.source.name) return;
    if (!flagsOf(job).claimReported) {
      if (!await send(slot, jobId, 'claimed', (j) => ({ kind: 'claimed', job: j }), (f) => ({ ...f, claimReported: true }))) return;
    }
    job = store.jobs.get(jobId)!;
    if (!isTerminal(job) || flagsOf(job).finalReported) return;
    if (job.status === 'failed' && !await finishedIfClosedAsComplete(host, slot, job)) return;
    job = store.jobs.get(jobId)!;
    const flags = flagsOf(job);
    if (job.status === 'cancelled' && !flags.cancelReason && hint.cancelReason) write(jobId, { ...flags, cancelReason: hint.cancelReason });
    // Its own pull request's checks red (issue #1230): told once assessed, as one the hopper fixes itself while its Continue is pending.
    if (fixingReports.waits(job)) return;
    const kind = job.status === 'finished' || job.status === 'failed' || job.status === 'rejected' ? job.status : 'cancelled', fixing = fixingReports.fixing(job);
    await send(slot, jobId, kind, (j) => (kind === 'failed' && fixing ? { kind, job: j, fixing } : { kind, job: j }), (f) => ({ ...f, finalReported: true, fixingReported: fixing }));
  }

  function queueReport(slot: Slot, jobId: string, hint: Hint = {}): Promise<void> {
    return enqueue(jobId, () => reportJob(slot, jobId, hint));
  }

  /** Tell the job's end to its source again. */
  const reportAgain = (jobId: string): void => { const j = store.jobs.get(jobId); const slot = slots.get(j?.source?.source ?? ''); if (!j || !slot) return; write(jobId, { ...flagsOf(j), finalReported: false }); void queueReport(slot, jobId); };
  const fixingReports = createFixingReports({ store, flagsOf, reportAgain });

  /** A pull request ended: the base of the others moved, so its source syncs again at once and follows every one. */
  function pullRequestEnded(slot: Slot | undefined): void {
    if (!slot || slot.removed) return;
    slot.followAll = true;
    if (slot.status.syncing) { slot.again = true; return; }
    // Listeners fire inside append; never start a sync from there.
    setImmediate(() => { if (running && !slot.status.syncing) void runSync(slot); });
  }

  function onEvent(e: DomainEvent) {
    if (running && PR_ENDED.has(e.type)) pullRequestEnded(slots.get(store.jobs.get(e.jobId ?? '')?.source?.source ?? '')); if (running) commentWakes.follows(e);
    if (running && (writeBacks.follows(e) || threadAsks.follows(e) || fixingReports.follows(e))) return;
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

  const applySignals = signalsApplier({ store, host, clock, enqueue, write: (id, f) => write(id, f), flagsOf, isTerminal });

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

  async function pull(slot: Slot, asked: boolean): Promise<{ seen: number; created: number }> {
    const passAt = clock.now().toISOString(); const discovered = await slot.source.discover(asked ? undefined : { due: true }); slot.answer = answerPrint(discovered);
    // The items free to run at the listing: a job whose end is reported after it is not run again on it, as the listing is older than its end (issue #2392).
    // Nor one made or ended while this pass ran (issue #2570): another hopper's job of the same Run again, which this listing does not know.
    const listedFree = new Set(discovered.filter((i) => { const e = store.jobs.getBySourceKey(i.key); return !e || isRerunnable(e); }).map((i) => i.key)), items = await intakeOrder(o.jevFirst, slot.source.name, discovered, (i) => listedFree.has(i.key));
    let created = 0; const newer = (j: Job): boolean => j.createdAt > passAt || (j.finishedAt ?? '') > passAt;
    const notRerun: NotRerun[] = [], yieldIfHeld = loopYield();
    for (const item of items) {
      // Each item its own step: a long pass gives the loop back between items, and a request waits for one item, not the pass (issue #2392). Its job is read after the yield.
      await yieldIfHeld(); const existing = store.jobs.getBySourceKey(item.key); if (existing && isRerunnable(existing) && (!listedFree.has(item.key) || newer(existing))) continue;
      if (existing && isTerminal(existing) && !isRerunnable(existing)) notRerun.push({ key: item.key, job: existing.id, status: existing.status, reason: NOT_REPORTED });
      if (await offer(host, slot.source, item, existing)) created++;
    }
    for (const n of notRerun) {
      if (slot.loggedNotRerun.has(n.key)) continue;
      slot.loggedNotRerun.add(n.key);
      console.warn(`hopper: ${n.key} not run again: job ${n.job} ${n.status}, ${n.reason}`);
    }
    keepNotRerun(slot, notRerun);
    return { seen: items.length, created };
  }

  async function syncOnce(slot: Slot, asked: boolean): Promise<boolean> { // answers whether the sync went through
    const st = slot.status;
    // Issue #812: a sync asked for off its timer (Sync now, an intake action) runs now: its timer goes, so one timer per
    // source fires, at the next sync time shown; and the old next time goes while it runs.
    clearTimeout(slot.timer); delete st.nextSyncAt; delete slot.again;
    const all = asked || slot.followAll === true, made = st.jobsCreated;
    const round = followRound(slot, clock.now().getTime(), o.followEvery?.(), all);
    delete slot.followAll;
    st.syncing = true;
    emit(slot);
    const previous = st.state === 'error' ? st.lastError : undefined;
    // Paused: nothing new is pulled, but the source's own active jobs are still checked and reported.
    const paused = slot.removed ? REMOVED : slot.source.paused?.();
    if (!slot.removed) pauseTold(slot, paused);
    // One pass (issue #822): the source asks GitHub once for what the steps read twice.
    const pass = async () => {
      if (paused === undefined) {
        const { seen, created } = await pull(slot, asked);
        st.itemsSeen = seen;
        st.jobsCreated += created;
      } else {
        [st.itemsSeen, slot.notRerun] = [0, []];
      }
      await applySignals(slot.source, jobsOf(slot).filter((j) => !isTerminal(j)));
      await finishCompleteOperatorLed(slot, jobsOf(slot).filter((j) => !isTerminal(j)));
      await Promise.all(jobsOf(slot).filter(needsWork).map((j) => queueReport(slot, j.id)));
      await writeBacks.catchUp(slot.source);
      await Promise.all([afterDone.catchUp(slot.source, jobsOf(slot), round, asked), threadAsks.catchUp(slot.source, jobsOf(slot))]);
      // Issue #1433: a pull request a job waits on that no follow records the end of; read at every sync, not only a round's.
      await waitedEnds(slot.source, jobsOf(slot));
      // Issue #1508: the other items a job's wait names — issues, pull requests, workflow runs —, ended or not.
      await watchedItemEnds(slot.source, jobsOf(slot));
    };
    try {
      await (slot.source.pass ? slot.source.pass(pass, paused) : pass()); // its line says why it takes nothing new (issue #1351)
      await drain();
      st.state = 'ok';
      st.lastOkAt = clock.now().toISOString();
      delete st.lastError;
    } catch (e) {
      st.state = 'error';
      st.lastError = message(e);
    }
    told(slot, previous, { clock, stallAfterMs, events: store.events });
    const jobs = jobsOf(slot);
    dropRetries(slot, (id) => { const j = store.jobs.get(id); return !!j && needsWork(j); });
    delete st.syncing; st.lastSyncAt = clock.now().toISOString();
    st.activeJobs = jobs.filter((j) => !isTerminal(j)).length;
    if (paused !== undefined && st.state === 'ok' && st.activeJobs === 0) st.state = 'disabled';
    keepArrivals(slot, paused, store.intakeArrivals, st.lastSyncAt); st.detail = detailOf(slot, paused, jobs.filter((j) => flagsOf(j).permanentErrors?.length).length); notAssignedTold(slot, paused);
    afterSync(slot, { changed: all || st.state !== 'ok' || st.jobsCreated > made || st.activeJobs > 0, calls: o.calls, now: st.lastSyncAt });
    if (slot.removed && st.state !== 'error' && jobs.every((j) => isTerminal(j) && flagsOf(j).claimReported && flagsOf(j).finalReported)) {
      // Nothing of its own is left to report: the removed source goes.
      if (slots.get(slot.source.name) === slot) slots.delete(slot.source.name);
      delete st.nextSyncAt;
      emit(slot);
      return true;
    }
    schedule(slot);
    emit(slot);
    return st.state !== 'error';
  }

  function schedule(slot: Slot) {
    if (!running) { delete slot.status.nextSyncAt; return; }
    const ms = slot.again ? 0 : nextPollMs(slot, o.pollMs(slot.source.name), o.backoff?.(slot.source.name) === true);
    slot.status.nextSyncAt = new Date(clock.now().getTime() + ms).toISOString();
    slot.timer = setTimeout(() => { void runSync(slot); }, ms);
  }

  /**
   * `asked`: a start, a changed source or a person asked for this sync, so the source reads everything again. A sync asked
   * for while one waits to start joins it (issue #1019): it starts after the ask, so it sees what the ask did, and ten
   * approvals in a row wait for one sync behind the running one, not for ten in a row.
   */
  function runSync(slot: Slot, asked = false, askedAt?: number): Promise<void> {
    clearTimeout(slot.timer);
    // A person's act that asks for this sync (issue #1194) is timed as `sync:<act>`, its wait from now, or from when the act asked its outbox to send (issue #1238). Its span is linked to the action that asked for it (issue #1486 part 5): none for a timer or the sync before it.
    const asks = syncAsks(askedAt), cause = causeNow(), causes = cause ? [cause] : [];
    const joining = joined(slot, asked, asks, causes); if (joining) return joining;
    const queued: NonNullable<Slot['queued']> = { asked, done: Promise.resolve(), asks, causes };
    slot.queued = queued;
    slot.chain = slot.chain.then(() => { slot.queued = undefined; return timedSync(timings, queued.asks, () => traceSync(slot.source.name, queued.asked, queued.causes, () => syncOnce(slot, queued.asked))); });
    queued.done = slot.chain;
    syncs.add(slot.chain);
    void slot.chain.finally(() => syncs.delete(slot.chain)).catch(() => undefined);
    return slot.chain;
  }

  const outbox = outboxFlushes({ slots: () => slots.values(), running: () => running, sync: (slot, at) => { void runSync(slot, false, at); }, ...(o.outboxBatchMs === undefined ? {} : { batchMs: o.outboxBatchMs }), acts: () => ({ ...afterDone.outboxActs, ...giveBackRows }),
    refresh: (slot) => { slot.status.detail = detailOf(slot, slot.removed ? REMOVED : slot.source.paused?.(), jobsOf(slot).filter((j) => flagsOf(j).permanentErrors?.length).length); emit(slot); } });

  /** A status with each taken item's job as it is now (issue #798). */
  const live = (st: SourceStatus): SourceStatus => liveIntake(st, (key) => store.jobs.getBySourceKey(key));

  const emit = (slot: Slot) => { for (const l of listeners) l(live(slot.status)); };

  const sourceOfJob = (jobId: string) => (running ? slots.get(store.jobs.get(jobId)?.source?.source ?? '')?.source : undefined);
  const sendNow = (source: JobSource) => { const slot = slots.get(source.name); if (slot && running) outbox.now(slot); }, retry = (jobId: string, e: unknown) => { slots.get(store.jobs.get(jobId)?.source?.source ?? '')?.retrying.set(jobId, message(e)); };
  const writeBacks = createWriteBacks({ store, enqueue, finalReported: (j) => !isTerminal(j) || flagsOf(j).finalReported === true, sourceOf: sourceOfJob, kept: (s) => { const slot = slots.get(s.name); if (slot && running) outbox.soon(slot); } });
  const threadAsks = createThreadAsks({ store, host, enqueue, sourceOf: sourceOfJob, now: () => clock.now().toISOString(), failed: retry }), commentWakes = createCommentWakes({ store, host, enqueue, sourceOf: sourceOfJob, failed: retry });

  const waitedEnds = waitedPullRequestEnds(store), watchedItemEnds = watchedEnds(store);
  const afterDone = createAfterDone({
    store, host, enqueue, ...(o.jevFirst ? { jevFirst: o.jevFirst } : {}), finalReported: (j) => flagsOf(j).finalReported === true, sourceOf: (job) => (running ? slots.get(job.source?.source ?? '')?.source : undefined),
    setSource: (jobId, source) => { const j = store.jobs.get(jobId); if (j) write(jobId, flagsOf(j), source); },
    reportAgain,
    failed: retry, tend: (jobId, brief) => rerunning.rerun(jobId, 'tending', brief), now: () => clock.now().getTime(), sendNow,
  });

  // The source that takes a job's item back (issue #1352): its own while it runs, else a running source that adopts it — its source was removed, and another takes the same repository.
  const { outboxActs: giveBackRows, ...rerunning } = createRerun({ host, flagsOf, enqueue, sourceOf: (job) => sourceOfJob(job.id) ?? (running && !slots.has(job.source?.source ?? '') ? [...slots.values()].find((s) => !s.removed && s.source.adopts?.(job) === true)?.source : undefined), syncSoon: (source) => { const slot = slots.get(source.name); if (slot) void runSync(slot); }, sendNow, now: () => clock.now().toISOString() });

  return {
    statuses: () => [...slots.values()].map((s) => live(s.status)),
    afterAnswerTimings: () => [...timings.summary(), ...[...slots.values()].filter((s) => !s.removed)
      .flatMap((s) => (s.source.afterAnswerTimings?.() ?? []).map((t) => ({ ...t, source: s.source.name })))],
    onStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Run again, Continue and Rework.
    ...rerunning,
    pullRequestAct: afterDone.act,
    tendAgain: afterDone.tendAgain, checkTendAgain: afterDone.checkTendAgain,
    async intakeAction(name, action) {
      const slot = slots.get(name);
      if (!slot || slot.removed || !running) return { ok: false, reason: 'not_found', message: `no running job source ${name}` };
      if (!slot.source.intakeAction) return { ok: false, reason: 'conflict', message: `job source ${name} takes no intake action` };
      const result = await slot.source.intakeAction(action);
      withTakenStatus(result.failed, (key) => store.jobs.getBySourceKey(key));
      // The answer waits for no GitHub write and no sync (issues #1194, #1238): the outbox sends its rows after its batch window, then the source syncs, timed as the act's.
      if (result.done.length > 0) withAct(action.kind, () => outbox.soon(slot));
      return { ok: true, result };
    },
    start() {
      if (running) return;
      running = true;
      unsubscribe = store.events.subscribe(onEvent);
      for (const slot of slots.values()) void runSync(slot, true);
      outbox.start();
    },
    repoChanged(repo) {
      const named = running ? [...slots.values()].filter((s) => !s.removed && s.source.repoChanged?.(repo) === true) : [];
      // A delivery is a change (issue #1264): the backoff ends.
      for (const slot of named) { slot.unchanged = 0; slot.delivered ??= setTimeout(() => { delete slot.delivered; if (running) void runSync(slot); }, DELIVERY_SYNC_MS); }
      return named.map((s) => s.source.name);
    },
    async stop() {
      running = false;
      unsubscribe?.();
      outbox.stop();
      for (const slot of slots.values()) { clearTimeout(slot.timer); clearTimeout(slot.delivered); delete slot.delivered; }
      await drain();
      await Promise.allSettled([...syncs]);
      await drain();
    },
    async syncNow(name) {
      const targets = [...slots.values()].filter((s) => !name || s.source.name === name);
      await Promise.all(targets.map((s) => runSync(s, true)));
    },
    setSources(sources) {
      for (const slot of followSources(slots, sources)) if (running) void runSync(slot, true);
    },
    source: (name) => slots.get(name)?.source,
  };
}
