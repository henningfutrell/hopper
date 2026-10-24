// The failure assessor (issue #509, design.md "Failure assessment"): every failed job is assessed once, from its
// `job.failed`; one left unassessed — a restart's, or a build's before the assessor — at start and by the sweep,
// whatever its age (issue #517). A record, the job's assessment, the events, and the problem a shared cause is
// grouped into are written in one transaction. The runs again it decides
// — a retry after its backoff, a redirect now, a held job released — are pending on the record, made by the sweep
// through the sync loop's Run again, so they outlive a restart. The sweep also marks superseded a failure whose item
// ran again since (issue #517), runs each open problem's check and prunes past the retention. A failed job automatic
// handling ended for is handed off to a person (issue #516, `handoffs.ts`) in the same transaction as the record that
// ended it. Stale data clears itself (issue #529): the sweep, and the start, close the hand-offs nothing waits on any
// more — a newer job of its item, its job finished or gone — and ask each open hand-off's source whether its item is
// closed and what its job's work shows (`work-check.ts`, issue #621). A failure no known cause explains, which the rules hand to a person, is a decider call
// (issue #550): Jev picks run it again or a person, after the rules; its pick runs it again only when its decision point
// is active and it is sure. A timed-out job (issue #630) is assessed from its liveness: its source is asked first whether
// a pull request of its own is open — at most `PR_LOOKUP_MS`, never holding the assessment —, and Continue, when due,
// resumes its own agent session in its kept work tree, else runs its item again, told to go on. A done-check miss (issue
// #637) is looked at once more first: done by now, its record is `resolved` and its job finished; else Jev picks, too. A
// failure of a job that reported a hopper bug about itself waits on that report's problem, never a person (issue #1147).
// A job whose own pull request's checks are red goes on to fix them, its failed checks run again first (issue #1230). One
// whose own pull request has merge conflicts or is a draft goes on to finish it (issue #1265). The same failure as its
// item's run before stops the item for a person, with no Jev pick (issue #1461). A finished job's kept work is pushed by itself, once (issue #1472, `autoPush`).
// A failure whose assessment throws is a poison failure (issue #1961, `poison.ts`): handed to a person with the reason.
// A failure of a job whose command ran out of heap in several jobs waits on that heap abort pattern's problem (issue #2722).
import type { Clock, RerunBy, UserStore } from '../domain/ports.ts';
import {
  failureSettingsOf, jobPriorityTag, type ActingPerson, type Discarding, type JevFirst, type FailureOutcome, type FailureRecord, type FailureSettings, type Job, type MachineSnapshot,
  type PendingRun, type Problem, type WorkState,
} from '../domain/types.ts';
import { assess, STALE_AFTER_MS } from './assess.ts';
import { BUILTIN_CAUSES, causePresent, matchCause, namedCause } from './causes.ts';
import { evidenceOf, machineOf } from './evidence.ts';
import { createJevSteps, type JevCase } from './jev.ts';
import { attemptOf, causeInputOf, recentOf, repeatedOf } from './chain.ts';
import { createTimeouts } from './timeouts.ts'; import { createChecksRed, type ChecksRedOptions } from './checks-red.ts'; import { createUnfinished, type UnfinishedDeps } from './unfinished.ts';
import { rerunRecordOf, retryable } from './rerun.ts'; import { settleLiveAgain } from './continued.ts';
import { createHandoffs, type HandoffsOptions } from './handoffs.ts'; import { createPoison } from './poison.ts';
import { createWorkCheck } from './work-check.ts'; import { createDoneAtSource, createWorkLook, DONE_NOTE, lookedAgain } from './done-at-source.ts';
import { createBackfill } from './backfill.ts'; import { autoPush, type Sessions } from './kept-work.ts'; import { killPoint } from '../sagas/kill-points.ts';
import type { FailureAction, Failures } from './failures.ts'; import { signatureOf } from './signature.ts';
import { fixLanded, HOPPER_BUG_CAUSE, ownReport, reportReason, reportSignature, reportsOf, reportTitle } from './hopper-bug.ts'; import { createHeapHolds } from './heap-holds.ts'; import { HEAP_ABORT_CAUSE } from './heap-pattern.ts';
import { highestFirst, newerOf, releasable, viewOf } from './view.ts'; import { soleLease, type SweepLease } from '../domain/leases.ts';

/** `rerun` (the sync loop's Run again, which the assessor's runs again use too), `continueJob`, `finishShipped`, `resumable`, `takesBack`, `dismiss`: as the hand-offs take them. `reopens` (`Engine.reopens`): Push it takes the job. */
export interface FailuresOptions extends Pick<HandoffsOptions, 'rerun' | 'continueJob' | 'finishShipped' | 'resumable' | 'takesBack' | 'dismiss'>, Pick<Sessions, 'reopens'>, ChecksRedOptions, Pick<UnfinishedDeps, 'unfinishedPullRequest'> {
  store: UserStore;
  clock: Clock;
  /** The machines now: a problem's check reads them. */
  machines(): Promise<MachineSnapshot[]>;
  /** What the job's work shows at its source (issues #529, #621); undefined: its source cannot tell. Throws: asked again later. */
  workState(job: Job): Promise<Omit<WorkState, 'checkedAt'> | undefined>;
  /** Ask for a Decision: a problem opened or resolved changes what may start. */
  trigger(reason: string): void;
  logger: { warn(line: string): void };
  /** How often the sweep runs. */
  sweepMs: number;
  /** The sweep's lease (issue #1627): on two hosts on one database, only its holder sweeps. Absent: this host alone. */
  lease?: SweepLease;
  /** Jev first (issue #550), asked about a failure no known cause explains, and whether the blast-radius gate keeps a machine. Absent: the rules only. */
  minorDecisions?: { first: JevFirst; gated(machineId: string): boolean };
  /** Whether a pull request of the job's own is open, by its source (issue #630); undefined: its source cannot tell. Throws: not known. */
  pullRequestOpen?(job: Job): Promise<boolean | undefined>;
  /** Whether the job's work is done at its source, asked before any run again of it (`done-at-source.ts`, issue #637). */
  doneAtSource?(job: Job): Promise<boolean>;
  /** When this hopper's build was made (its install record): a hopper bug's fix is in it only when it closed before (issue #1147). */
  installedAt?(): string | undefined;
  /** A discard of kept work under way or failed on its machine (issue #1194, `Engine.discarding`). Absent: none shown. */
  discarding?(jobId: string): Discarding | undefined;
}

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
const SOON_MS = 1000;
const JUST_FAILED_MS = 60_000;
const SOURCE_DOWN_MS = 30_000;
/** A Continue ran its job again too (issue #630): in its own agent session, or as a new job of its item. */
const DONE: Record<PendingRun, FailureOutcome> = { retry: 'retried', redirect: 'redirected', release: 'released', continue: 'retried' };

const CHECK_OF = new Map(BUILTIN_CAUSES.filter((c) => c.check).map((c) => [c.id, c.check!]));
export function createFailures(o: FailuresOptions): Failures {
  const { store, clock } = o;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined; const lease = o.lease ?? soleLease();
  let prunedAt = 0;
  const now = () => clock.now();
  // Settings saved before a field existed take its default; `auto` too, field by field (issue #630: `auto.continue`).
  const settings = (): FailureSettings => failureSettingsOf(store.settings.getFailureSettings());
  const handoffs = createHandoffs({ ...o, settings, live: () => !stopped });
  // Own PR checks red (issue #1230): its pending Continue runs the failed checks again first, and waits while they run.
  const timeouts = createTimeouts({ store, pullRequestOpen: o.pullRequestOpen, logger: o.logger, live: () => !stopped, resumable: o.resumable, continueJob: o.continueJob, rerun: o.rerun }), checksRed = createChecksRed({ ...o, store, now, live: () => !stopped }), unfinished = createUnfinished({ store, unfinishedPullRequest: o.unfinishedPullRequest, resumable: o.resumable, continueJob: o.continueJob, rerun: o.rerun });
  const doneCheck = createDoneAtSource({ store, doneAtSource: o.doneAtSource, finishShipped: o.finishShipped, now, live: () => !stopped }), heap = createHeapHolds({ store, now, settings });
  const backfill = createBackfill({ store, now, doneAtSource: o.doneAtSource, workState: o.workState, finishShipped: o.finishShipped, live: () => !stopped, logger: o.logger });
  const checkWork = createWorkCheck({ store, clock, workState: o.workState, checked: (id, work) => handoffs.checked(id, work), logger: o.logger, live: () => !stopped });

  /** The failed jobs whose source found the work done when looked at once more, before their assessment (issues #637, #2040). */
  const doneWhenAssessed = new Set<string>(), work = createWorkLook({ store, workState: o.workState, skip: (id) => doneWhenAssessed.has(id), live: () => !stopped });
  const lookAgain = async (id: string): Promise<void> => { if (!stopped && await lookedAgain(store, o.doneAtSource, id) && !stopped) doneWhenAssessed.add(id); };

  /** Its latest run has a record — unless the job was continued since (issue #551): its new failure is assessed anew. */
  const assessedRun = (jobId: string): boolean => { const r = store.failures.forJob(jobId); return r !== undefined && !(r.outcome === 'retried' && r.nextJobId === jobId); }, poison = createPoison({ store, now, assessedRun, afterRecord: (r) => handoffs.afterRecord(r), logger: o.logger });

  /** The open problem of a signature whose scope covers this machine. */
  const openFor = (signature: string, machineId: string | undefined): Problem | undefined =>
    store.problems.list({ status: 'open' }).find((p) => p.signature === signature && (p.scope.machineId === undefined || p.scope.machineId === machineId));

  /** Assess one failed job, once; `kick`: then sweep, for a run again due now (the backlog is assessed inside one). */
  function assessJob(jobId: string, kick = true): void {
    if (stopped) return;
    let grouped = false;
    let jevCase: JevCase | undefined;
    if (poison.skips(jobId)) return;
    const doneNow = doneWhenAssessed.delete(jobId);
    let finish = false;
    try { store.tx(() => {
      const job = store.jobs.get(jobId);
      if (!job || job.status !== 'failed' || job.assessment || assessedRun(jobId)) return;
      const s = settings();
      const at = now();
      const error = job.error ?? 'failed without a reason';
      const { normalised, signature } = signatureOf(error);
      const { cause, reason: workReason } = work.causeOf(jobId, matchCause(error, signature, store.settings.getNamedCauses()));
      const machineId = machineOf(job);
      const attempt = attemptOf(store, job);
      const ranMs = job.startedAt && job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : undefined;
      const recent = recentOf(store, job, signature, new Date(now().getTime() - s.groupWindowMin * 60_000).toISOString());
      const open = openFor(signature, machineId);
      // A job that reported a hopper bug about itself (issue #1147): its report's problem, open or to open.
      const report = ownReport(store.bugReports.list(), job.id);
      const reportOpen = report ? openFor(reportSignature(report), machineId) : undefined, heapOf = heap.patternOf(job), heapRetry = heap.retryOf(job); // And a heap abort pattern it is part of, or its heap retry (issue #2722).
      const a = assess({
        error, signature, cause, attempt, recent, settings: s,
        newer: newerOf(store, job), failedAgoMs: Math.max(0, at.getTime() - Date.parse(job.finishedAt ?? job.updatedAt)),
        job: { executor: job.spec.executor, pinned: job.spec.machineId !== undefined, ...(machineId ? { machineId } : {}) },
        ...(ranMs !== undefined ? { ranMs } : {}), ...(job.errorTail ? { tail: job.errorTail } : {}),
        ...(open ? { open: { id: open.id, title: open.title, decision: open.decision } } : {}),
        ...causeInputOf(store, job, cause?.id), repeated: repeatedOf(store, job, signature), ...(workReason ? { causeReason: workReason } : {}),
        ...(report ? { hopperBug: { title: reportTitle(report), reason: reportReason(report), ...(reportOpen ? { open: reportOpen.id } : {}) } } : {}),
        ...(heapOf ? { heapPattern: { title: heapOf.pattern.title, reason: heapOf.pattern.reason, ...(heapOf.open ? { open: heapOf.open.id } : {}) } } : {}), ...(heapRetry ? { heapRetry } : {}),
      });
      let problem: Problem | undefined;
      let opened = false;
      const joinId = a.problem?.kind === 'join' ? a.problem.id : undefined;
      const joining = [open, reportOpen, heapOf?.open].find((p) => p !== undefined && p.id === joinId);
      if (joining) {
        problem = store.problems.update(joining.id, { jobIds: [...joining.jobIds, job.id], updatedAt: at.toISOString() });
      } else if (a.problem?.kind === 'open') {
        const { kind: _k, ...plan } = a.problem;
        const of = plan.causeId === HOPPER_BUG_CAUSE && report ? reportSignature(report) : plan.causeId === HEAP_ABORT_CAUSE && heapOf ? heapOf.pattern.signature : signature;
        problem = store.problems.create({ ...plan, signature: of, status: 'open', openedAt: at.toISOString(), updatedAt: at.toISOString(), jobIds: [job.id] });
        opened = true;
      }
      const acts = a.auto && (a.decision === 'retry' || a.decision === 'redirect' || a.decision === 'continue');
      const pendingAt = a.decision === 'retry' ? new Date(at.getTime() + (a.retryInMs ?? 0)).toISOString() : at.toISOString();
      const record = store.failures.create({
        jobId: job.id, at: at.toISOString(), signature, normalised, cls: a.cls, decision: a.decision, reasons: a.reasons, summary: a.summary, auto: a.auto,
        ...(cause ? { causeId: cause.id, causeName: cause.name } : {}),
        evidence: evidenceOf(job, { error, attempt, sameSignature: recent.length, ...(machineId ? { machineId } : {}), ...(ranMs !== undefined ? { ranMs } : {}) }),
        ...(problem ? { problemId: problem.id } : {}),
        ...(a.decision === 'retry' && a.auto ? { retryAt: pendingAt } : {}),
        ...(doneNow ? { outcome: 'resolved' as const, outcomeAt: at.toISOString(), note: DONE_NOTE }
          : a.superseded ? { outcome: 'superseded' as const, outcomeAt: at.toISOString(), nextJobId: a.superseded }
          : acts ? { pending: a.decision as PendingRun, pendingAt } : { outcome: problem ? 'held' as const : 'surfaced' as const, outcomeAt: at.toISOString() }),
      });
      finish = doneNow;
      if (!doneNow) handoffs.afterRecord(record);
      if ((!cause || cause.id === 'not-complete') && !doneNow && a.decision === 'person' && !a.superseded && !a.repeated && Date.parse(record.at) - Date.parse(job.finishedAt ?? job.updatedAt) <= STALE_AFTER_MS && attempt - 1 < s.maxAttempts) {
        jevSteps.keep(jevCase = { recordId: record.id, job, error, attempt, doneCheck: cause !== undefined, ...(ranMs !== undefined ? { ranMs } : {}), ...(machineId ? { machineId } : {}) });
      }
      store.jobs.update(job.id, {
        assessment: {
          recordId: record.id, at: record.at, class: a.cls, decision: a.decision, summary: a.summary, reasons: a.reasons,
          ...(problem ? { problemId: problem.id, problemTitle: problem.title } : {}), ...(record.retryAt ? { retryAt: record.retryAt } : {}),
        },
      });
      store.events.append({
        type: 'job.assessed', jobId: job.id, ...(machineId ? { machineId } : {}),
        data: {
          recordId: record.id, signature, class: a.cls, decision: a.decision, reasons: a.reasons, summary: a.summary, attempt, auto: a.auto,
          ...(cause ? { causeId: cause.id } : {}), ...(problem ? { problemId: problem.id } : {}), ...(record.retryAt ? { retryAt: record.retryAt } : {}),
          ...jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), job.id),
        },
      });
      if (problem) {
        grouped = true;
        store.events.append({
          type: 'failure.grouped', jobId: job.id,
          data: { problemId: problem.id, signature, title: problem.title, opened, general: problem.general, decision: problem.decision, scope: problem.scope, affected: problem.jobIds.length },
        });
      }
      killPoint('failures:assess:before-commit'); }); } catch (e) { poison.handOff(jobId, e); return; } // A poison failure (issue #1961): a person's, never blocking the others.
    killPoint('failures:assess:after-commit');
    if (finish) o.finishShipped(jobId, { summary: DONE_NOTE });
    if (grouped) o.trigger('failure.grouped');
    if (jevCase) jevSteps.ask(jevCase);
    if (kick && !stopped) void sweep();
  }

  /** Jev's steps (issue #550): each kept on its record until Jev answered, so a restart asks it again (issue #1608). */
  const jevSteps = createJevSteps({ store, minorDecisions: o.minorDecisions, live: () => !stopped, logger: o.logger, now, rerun: (recordId, by, note) => rerunRecord(recordId, by, note) });
  const rerunRecord = (recordId: string, by: RerunBy, note: string): Promise<FailureAction<Job>> => rerunRecordOf({ store, rerun: o.rerun, takesBack: o.takesBack, now }, recordId, by, note);

  /**
   * Assess every failed job not assessed yet, whatever its age: a restart's, or an older build's backlog. The sweep
   * leaves a job that failed within `leaveMs` to its own `job.failed`, which comes once its end is handled.
   */
  function assessBacklog(leaveMs = 0): void {
    const before = now().getTime() - leaveMs;
    for (const job of store.jobs.list({ status: ['failed'], unassessed: true })) {
      if (Date.parse(job.finishedAt ?? job.updatedAt) <= before) assessJob(job.id, false);
    }
  }

  /**
   * Make one due run again; a refusal that may pass (its end not reported yet, its source down) is tried again later. Its
   * job live again (issue #1777: a Continue or a resume took it first), before the run or after a refusal: the record
   * ends taken by it, and no hand-off opens.
   */
  async function runPending(r: FailureRecord): Promise<void> {
    if (r.pending !== 'release' && heap.holdPending(r.jobId)) { o.trigger('failure.grouped'); return; } // A heap abort pattern shown since (issue #2722).
    if (store.tx(() => settleLiveAgain(store, r.jobId, now().toISOString())) || stopped || await checksRed.waits(r, SOURCE_DOWN_MS) || await doneCheck.beforeRun(r, SOURCE_DOWN_MS) || stopped) return;
    const result = r.pending === 'continue' ? await (checksRed.continueOf(r) ?? unfinished.continueOf(r) ?? timeouts.continueOf(r)) : await o.rerun(r.jobId, 'assessor');
    if (stopped) return;
    store.tx(() => {
      const cur = store.failures.get(r.id);
      if (!cur?.pending) return;
      const at = now();
      if (result.ok) {
        store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: DONE[cur.pending], outcomeAt: at.toISOString(), nextJobId: result.job.id, note: undefined });
        return;
      }
      if (settleLiveAgain(store, r.jobId, at.toISOString())) return; const later = result.reason === 'source' ? SOURCE_DOWN_MS : /not reported|not running/.test(result.message) ? SOON_MS : undefined;
      if (later !== undefined) store.failures.update(r.id, { pendingAt: new Date(at.getTime() + later).toISOString(), note: result.message });
      else handoffs.afterRecord(store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: 'not_retried', outcomeAt: at.toISOString(), note: result.message }));
    });
  }

  /**
   * A problem whose check saw its cause, then sees it gone, resolves by itself. A hopper bug's (issue #1147) once its
   * report's fix landed, from the report's state as Report a bug last read it.
   */
  async function runChecks(): Promise<void> {
    const bugs = store.problems.list({ status: 'open' }).filter((p) => p.causeId === HOPPER_BUG_CAUSE);
    if (bugs.length > 0) {
      const reports = store.bugReports.list();
      const installedAt = o.installedAt?.();
      for (const p of bugs) if (reportsOf(p.signature, reports).some((r) => fixLanded(r, installedAt))) resolveAs(p.id, 'check');
    }
    const open = store.problems.list({ status: 'open' }).filter((p) => p.causeId && CHECK_OF.has(p.causeId) && p.scope.machineId);
    if (open.length === 0) return;
    const machines = await o.machines();
    if (stopped) return;
    for (const p of open) {
      const m = machines.find((x) => x.id === p.scope.machineId);
      if (!m) continue;
      const present = causePresent(CHECK_OF.get(p.causeId!)!, m);
      if (present && !p.checkSawCause) store.problems.update(p.id, { checkSawCause: true });
      else if (!present && p.checkSawCause) resolveAs(p.id, 'check');
    }
  }

  function prune(): void {
    const at = now().getTime();
    if (at - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = at;
    const s = settings();
    const before = new Date(at - s.retentionDays * DAY_MS).toISOString();
    store.tx(() => { store.failures.prune(before); store.problems.prune(before); handoffs.prune(new Date(at - s.handoffRetentionDays * DAY_MS).toISOString()); });
  }

  /** At the start, or once this host takes the lease from another: what a stop left, before anything is handed off. */
  // Failed jobs left unassessed (a restart between the failure and the assessment, or an older build's backlog) and Jev's
  // steps a restart left unasked (issue #1608); then, for a
  // store from the build before (issue #529), what nothing waits on any more clears before anything is handed off.
  const catchUp = (): void => { assessBacklog(); jevSteps.askLeft(); handoffs.supersede(); handoffs.settle(); handoffs.dismissStale(); handoffs.catchUp(); };

  function sweep(): Promise<void> {
    sweeping ??= (async () => {
      try {
        const held = lease.hold();
        if (!held.held) return; if (held.taken) catchUp();
        assessBacklog(JUST_FAILED_MS);
        if (!stopped) { handoffs.supersede(); handoffs.settle(); handoffs.dismissStale(); }
        // High-priority jobs run again first (issue #535): by their live priority, then as due.
        for (const r of highestFirst(store, store.failures.due(now().toISOString()))) {
          if (stopped) return;
          await runPending(r);
        }
        if (!stopped) await checkWork(); if (!stopped && settings().auto.push) await autoPush({ store, resumable: o.resumable, reopens: o.reopens, takesBack: o.takesBack, continueJob: o.continueJob, live: () => !stopped, logger: o.logger });
        if (!stopped) await runChecks();
        if (!stopped) prune();
      } catch (e) {
        o.logger.warn(`hopper: the failure sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Cleared after the assignment (issue #1961): a pass that ends before its first await — the lease held by another
      // host, a throw — cleared it before, then was kept as the sweep under way, so no sweep ran on this host again.
    })().finally(() => { sweeping = undefined; });
    return sweeping;
  }

  /** Set the held jobs of a problem to run again now: how many. */
  function releaseHeld(problemId: string): number {
    const held = releasable(store, problemId);
    const at = now().toISOString();
    for (const r of held) store.failures.update(r.id, { pending: 'release', pendingAt: at });
    return held.length;
  }

  /** `acting`, `note`: a person's (issue #623); none for the check's. */
  function resolveAs(problemId: string, by: 'user' | 'check', acting?: ActingPerson, note?: string): FailureAction<Problem> {
    const done = store.tx((): FailureAction<Problem> => {
      const p = store.problems.get(problemId);
      if (!p) return { ok: false, reason: 'not_found', message: `problem ${problemId} not found` };
      if (p.status === 'resolved') return { ok: false, reason: 'conflict', message: `problem ${problemId} is already resolved` };
      const at = now().toISOString();
      const resolved = store.problems.update(p.id, { status: 'resolved', resolvedAt: at, resolvedBy: by, updatedAt: at });
      const released = releaseHeld(p.id);
      store.events.append({ type: 'failure.resolved', data: { problemId: p.id, title: p.title, by, released, ...acting, ...(note ? { note } : {}) } });
      return { ok: true, value: resolved };
    });
    if (done.ok) { o.trigger('failure.resolved'); void sweep(); } return done;
  }

  return {
    start() {
      if (lease.hold().held) catchUp();
      unsubscribe = store.events.subscribe((e) => {
        if (stopped) return;
        // A timeout's facts first (issue #630), then the assessment.
        if (e.type === 'job.failed' && e.jobId) { const id = e.jobId; setImmediate(() => { void timeouts.lookUpPullRequest(id).catch(() => {}).then(() => lookAgain(id)).catch(() => {}).then(() => work.look(id)).catch(() => {}).then(() => assessJob(id)); }); }
        // A heap abort the reap read after the assessment (issue #2722): its pending run again waits on the pattern; a
        // person's failure becomes its heap retry (part 4).
        if (e.type === 'job.heap_aborted' && e.jobId) { const id = e.jobId; setImmediate(() => { if (stopped) return; if (heap.holdPending(id)) o.trigger('failure.grouped'); else if (heap.retryPending(id)) void sweep(); }); } handoffs.onEvent(e);
      });
      timer = setInterval(() => { void sweep(); }, o.sweepMs);
      void sweep();
    },
    async stop() {
      stopped = true; unsubscribe?.();
      if (timer) clearInterval(timer); await sweeping;
    },
    sweep,
    dismissStale: () => handoffs.dismissStale(),
    backfill,
    view: () => viewOf(store, settings(), now(), { resumable: o.resumable, reopens: o.reopens }, o.takesBack, o.discarding),
    blocks() {
      if (!settings().auto.hold) return [];
      // A Recurring problem (`general`) holds only its own jobs, never its whole scope (issue #637): no known cause says others meet it.
      // Nor a hopper bug's (issue #1147): only the jobs that reported it are known to meet it. Nor a heap abort pattern's (issue #2722).
      return store.problems.list({ status: 'open' }).filter((p) => !p.general && p.causeId !== HOPPER_BUG_CAUSE && p.causeId !== HEAP_ABORT_CAUSE).map((p) => ({ id: p.id, title: p.title, ...p.scope }));
    },
    settings,
    setSettings(patch) {
      const s = settings();
      const next: FailureSettings = { ...s, ...patch, auto: { ...s.auto, ...patch.auto } };
      store.settings.setFailureSettings(next);
      o.trigger('failure.settings');
      return next;
    },
    resolve: (problemId, by, note) => resolveAs(problemId, 'user', by, note),
    release(problemId, by) {
      const done = store.tx((): FailureAction<Problem> => {
        const p = store.problems.get(problemId);
        if (!p) return { ok: false, reason: 'not_found', message: `problem ${problemId} not found` };
        const released = releaseHeld(p.id);
        if (released === 0) return { ok: false, reason: 'conflict', message: `problem ${problemId} holds no job` };
        store.events.append({ type: 'failure.released', data: { problemId: p.id, title: p.title, released, ...by } });
        return { ok: true, value: p };
      });
      if (done.ok) void sweep();
      return done;
    },
    retry: (recordId, by) => doneCheck.unlessDone(recordId, () => rerunRecordOf({ store, rerun: o.rerun, takesBack: o.takesBack, now }, recordId, 'user', 'run again by a person', by)),
    retryable: (recordId) => retryable({ store, takesBack: o.takesBack }, recordId),
    resolveHandoff: (handoffId, input, by) => handoffs.resolve(handoffId, input, by),
    handoffResolvable: (handoffId, action) => handoffs.resolvable(handoffId, action),
    nameCause(cause) {
      store.settings.setNamedCauses([...store.settings.getNamedCauses().filter((c) => c.signature !== cause.signature), cause]);
      return namedCause(cause);
    },
    forgetCause(signature) {
      const named = store.settings.getNamedCauses();
      store.settings.setNamedCauses(named.filter((c) => c.signature !== signature));
      return named.some((c) => c.signature === signature);
    },
  };
}
