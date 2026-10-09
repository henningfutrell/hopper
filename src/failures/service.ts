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
// closed (`item-check.ts`). A failure no known cause explains, which the rules hand to a person, is a minor decision
// (issue #550): Jev picks run it again or a person, after the rules; its pick runs it again only when its decision point
// is active and it is sure.
import type { Clock, RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import {
  DEFAULT_FAILURE_SETTINGS, jobPriorityTag, type JevFirst, type FailureOutcome, type FailureRecord, type FailureSettings, type FailuresView, type Job, type KnownCause, type MachineSnapshot,
  type Handoff, type NamedCause, type PendingRun, type Problem, type ProblemBlock,
} from '../domain/types.ts';
import { assess, STALE_AFTER_MS, type RecentFailure } from './assess.ts';
import { BUILTIN_CAUSES, matchCause, namedCause } from './causes.ts';
import { evidenceOf, machineOf } from './evidence.ts';
import { askJev, type JevCase } from './jev.ts';
import { rerunRecordOf } from './rerun.ts';
import { createHandoffs } from './handoffs.ts';
import { createItemCheck } from './item-check.ts';
import { signatureOf } from './signature.ts';
import { highestFirst, newerOf, releasable, viewOf } from './view.ts';

export interface FailuresOptions {
  store: UserStore;
  clock: Clock;
  /** Run an ended job's item again: the sync loop's Run again. */
  rerun(jobId: string, by: RerunBy): Promise<RerunResult>;
  /** Dismiss a failed job's locked entry (issue #355): a cleared hand-off leaves the queue too. Throws when it is not one. */
  dismiss(jobId: string): void;
  /** The machines now: a problem's check reads them. */
  machines(): Promise<MachineSnapshot[]>;
  /** Whether the job's item is closed at its source (issue #529); undefined: its source cannot tell. Throws: asked again later. */
  itemClosed(job: Job): Promise<boolean | undefined>;
  /** Ask for a Decision: a problem opened or resolved changes what may start. */
  trigger(reason: string): void;
  logger: { warn(line: string): void };
  /** How often the sweep runs. */
  sweepMs: number;
  /** Jev first (issue #550), asked about a failure no known cause explains, and whether the blast-radius gate keeps a machine. Absent: the rules only. */
  minorDecisions?: { first: JevFirst; gated(machineId: string): boolean };
}

export type FailureAction<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'conflict'; message: string };

export interface Failures {
  /** Assess what a restart left unassessed, follow `job.failed`, start the sweep. Once. */
  start(): void;
  stop(): Promise<void>;
  /** The due runs again, the checks, the prune — now (tests, and after an action). */
  sweep(): Promise<void>;
  view(): FailuresView;
  /** The open problems the decider reads; none while automatic hold is off. */
  blocks(): ProblemBlock[];
  settings(): FailureSettings;
  setSettings(patch: Partial<FailureSettings>): FailureSettings;
  /** A person resolves a problem: its held jobs run again, new jobs are no longer held for it. */
  resolve(problemId: string): FailureAction<Problem>;
  /** A person releases a problem's held jobs now: they run again through the normal queue. */
  release(problemId: string): FailureAction<Problem>;
  /** A person runs a surfaced failure's job again. */
  retry(recordId: string): Promise<FailureAction<Job>>;
  /** A person runs a hand-off's job again (issue #516): past its retry limit, past its problem's hold. */
  runAgain(handoffId: string): Promise<FailureAction<Job>>;
  /** A person clears a hand-off: acknowledged, no more work; its locked entry leaves the queue. */
  clear(handoffId: string): FailureAction<Handoff>;
  nameCause(cause: NamedCause): KnownCause;
  forgetCause(signature: string): boolean;
}

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
const SOON_MS = 1000;
const JUST_FAILED_MS = 60_000;
const SOURCE_DOWN_MS = 30_000;
const DONE: Record<PendingRun, FailureOutcome> = { retry: 'retried', redirect: 'redirected', release: 'released' };
const CHECK_OF = new Map(BUILTIN_CAUSES.filter((c) => c.check).map((c) => [c.id, c.check!]));
export function createFailures(o: FailuresOptions): Failures {
  const { store, clock } = o;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined;
  let prunedAt = 0;
  const now = () => clock.now();
  const settings = (): FailureSettings => ({ ...DEFAULT_FAILURE_SETTINGS, ...store.settings.getFailureSettings() });
  const handoffs = createHandoffs({ store, clock, settings, rerun: o.rerun, dismiss: o.dismiss, logger: o.logger, live: () => !stopped });
  const checkItems = createItemCheck({ store, clock, itemClosed: o.itemClosed, closed: (id) => handoffs.itemClosed(id), logger: o.logger, live: () => !stopped });

  /** Its run in its chain of retries: 1, plus each earlier job of its item that a retry ran again. */
  function attemptOf(job: Job): number {
    let n = 1;
    for (let prev = job.rerunOf; prev !== undefined; prev = store.jobs.get(prev)?.rerunOf) {
      if (store.failures.forJob(prev)?.outcome !== 'retried') break;
      n += 1;
    }
    return n;
  }

  /** Other items' failures with this signature in the grouping window, one per item. */
  function recentOf(job: Job, signature: string, s: FailureSettings): RecentFailure[] {
    const since = new Date(now().getTime() - s.groupWindowMin * 60_000).toISOString();
    const itemOf = (jobId: string) => store.jobs.get(jobId)?.source?.key ?? jobId;
    const mine = itemOf(job.id);
    const byItem = new Map<string, RecentFailure>();
    for (const r of store.failures.list({ signature, since })) {
      const item = itemOf(r.jobId);
      if (item !== mine && !byItem.has(item)) byItem.set(item, { jobId: r.jobId, executor: r.evidence.executor, ...(r.evidence.machineId ? { machineId: r.evidence.machineId } : {}) });
    }
    return [...byItem.values()];
  }

  /** The open problem of a signature whose scope covers this machine. */
  const openFor = (signature: string, machineId: string | undefined): Problem | undefined =>
    store.problems.list({ status: 'open' }).find((p) => p.signature === signature && (p.scope.machineId === undefined || p.scope.machineId === machineId));

  /** Assess one failed job, once; `kick`: then sweep, for a run again due now (the backlog is assessed inside one). */
  function assessJob(jobId: string, kick = true): void {
    if (stopped) return;
    let grouped = false;
    let jevCase: JevCase | undefined;
    store.tx(() => {
      const job = store.jobs.get(jobId);
      if (!job || job.status !== 'failed' || job.assessment || store.failures.forJob(jobId)) return;
      const s = settings();
      const at = now();
      const error = job.error ?? 'failed without a reason';
      const { normalised, signature } = signatureOf(error);
      const cause = matchCause(error, signature, store.settings.getNamedCauses());
      const machineId = machineOf(job);
      const attempt = attemptOf(job);
      const ranMs = job.startedAt && job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : undefined;
      const recent = recentOf(job, signature, s);
      const open = openFor(signature, machineId);
      const a = assess({
        error, signature, cause, attempt, recent, settings: s,
        newer: newerOf(store, job), failedAgoMs: Math.max(0, at.getTime() - Date.parse(job.finishedAt ?? job.updatedAt)),
        job: { executor: job.spec.executor, pinned: job.spec.machineId !== undefined, ...(machineId ? { machineId } : {}) },
        ...(ranMs !== undefined ? { ranMs } : {}), ...(job.errorTail ? { tail: job.errorTail } : {}),
        ...(open ? { open: { id: open.id, title: open.title, decision: open.decision } } : {}),
      });
      let problem: Problem | undefined;
      let opened = false;
      if (a.problem?.kind === 'join' && open) {
        problem = store.problems.update(open.id, { jobIds: [...open.jobIds, job.id], updatedAt: at.toISOString() });
      } else if (a.problem?.kind === 'open') {
        const { kind: _k, ...plan } = a.problem;
        problem = store.problems.create({ ...plan, signature, status: 'open', openedAt: at.toISOString(), updatedAt: at.toISOString(), jobIds: [job.id] });
        opened = true;
      }
      const acts = a.auto && (a.decision === 'retry' || a.decision === 'redirect');
      const pendingAt = a.decision === 'retry' ? new Date(at.getTime() + (a.retryInMs ?? 0)).toISOString() : at.toISOString();
      const record = store.failures.create({
        jobId: job.id, at: at.toISOString(), signature, normalised, cls: a.cls, decision: a.decision, reasons: a.reasons, summary: a.summary, auto: a.auto,
        ...(cause ? { causeId: cause.id, causeName: cause.name } : {}),
        evidence: evidenceOf(job, { error, attempt, sameSignature: recent.length, ...(machineId ? { machineId } : {}), ...(ranMs !== undefined ? { ranMs } : {}) }),
        ...(problem ? { problemId: problem.id } : {}),
        ...(a.decision === 'retry' && a.auto ? { retryAt: pendingAt } : {}),
        ...(a.superseded ? { outcome: 'superseded' as const, outcomeAt: at.toISOString(), nextJobId: a.superseded }
          : acts ? { pending: a.decision as PendingRun, pendingAt } : { outcome: problem ? 'held' as const : 'surfaced' as const, outcomeAt: at.toISOString() }),
      });
      handoffs.afterRecord(record);
      if (!cause && a.decision === 'person' && !a.superseded && Date.parse(record.at) - Date.parse(job.finishedAt ?? job.updatedAt) <= STALE_AFTER_MS && attempt - 1 < s.maxAttempts) {
        jevCase = { recordId: record.id, job, error, attempt, ...(ranMs !== undefined ? { ranMs } : {}), ...(machineId ? { machineId } : {}) };
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
    });
    if (grouped) o.trigger('failure.grouped');
    if (jevCase) void jevStep(jevCase);
    if (kick && !stopped) void sweep();
  }

  const jevStep = (c: JevCase) => (o.minorDecisions ? askJev({ ...o.minorDecisions, live: () => !stopped, logger: o.logger, rerun: rerunRecord }, c) : Promise.resolve());
  const rerunRecord = (recordId: string, by: RerunBy, note: string): Promise<FailureAction<Job>> => rerunRecordOf({ store, rerun: o.rerun, now }, recordId, by, note);

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

  /** Make one due run again; a refusal that may pass (its end not reported yet, its source down) is tried again later. */
  async function runPending(r: FailureRecord): Promise<void> {
    const result = await o.rerun(r.jobId, 'assessor');
    if (stopped) return;
    store.tx(() => {
      const cur = store.failures.get(r.id);
      if (!cur?.pending) return;
      const at = now();
      if (result.ok) {
        store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: DONE[cur.pending], outcomeAt: at.toISOString(), nextJobId: result.job.id, note: undefined });
        return;
      }
      const later = result.reason === 'source' ? SOURCE_DOWN_MS : /not reported|not running/.test(result.message) ? SOON_MS : undefined;
      if (later !== undefined) store.failures.update(r.id, { pendingAt: new Date(at.getTime() + later).toISOString(), note: result.message });
      else handoffs.afterRecord(store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: 'not_retried', outcomeAt: at.toISOString(), note: result.message }));
    });
  }

  /** A problem whose check saw its cause, then sees it gone, resolves by itself. */
  async function runChecks(): Promise<void> {
    const open = store.problems.list({ status: 'open' }).filter((p) => p.causeId && CHECK_OF.has(p.causeId) && p.scope.machineId);
    if (open.length === 0) return;
    const machines = await o.machines();
    if (stopped) return;
    for (const p of open) {
      const m = machines.find((x) => x.id === p.scope.machineId);
      if (!m) continue;
      const present = CHECK_OF.get(p.causeId!) === 'online' ? !m.online : m.disk?.low === true;
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

  function sweep(): Promise<void> {
    sweeping ??= (async () => {
      try {
        assessBacklog(JUST_FAILED_MS);
        if (!stopped) { handoffs.supersede(); handoffs.settle(); }
        // High-priority jobs run again first (issue #535): by their live priority, then as due.
        for (const r of highestFirst(store, store.failures.due(now().toISOString()))) {
          if (stopped) return;
          await runPending(r);
        }
        if (!stopped) await checkItems();
        if (!stopped) await runChecks();
        if (!stopped) prune();
      } catch (e) {
        o.logger.warn(`hopper: the failure sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        sweeping = undefined;
      }
    })();
    return sweeping;
  }

  /** Set the held jobs of a problem to run again now: how many. */
  function releaseHeld(problemId: string): number {
    const held = releasable(store, problemId);
    const at = now().toISOString();
    for (const r of held) store.failures.update(r.id, { pending: 'release', pendingAt: at });
    return held.length;
  }

  function resolveAs(problemId: string, by: 'user' | 'check'): FailureAction<Problem> {
    const done = store.tx((): FailureAction<Problem> => {
      const p = store.problems.get(problemId);
      if (!p) return { ok: false, reason: 'not_found', message: `problem ${problemId} not found` };
      if (p.status === 'resolved') return { ok: false, reason: 'conflict', message: `problem ${problemId} is already resolved` };
      const at = now().toISOString();
      const resolved = store.problems.update(p.id, { status: 'resolved', resolvedAt: at, resolvedBy: by, updatedAt: at });
      const released = releaseHeld(p.id);
      store.events.append({ type: 'failure.resolved', data: { problemId: p.id, title: p.title, by, released } });
      return { ok: true, value: resolved };
    });
    if (done.ok) { o.trigger('failure.resolved'); void sweep(); }
    return done;
  }

  return {
    start() {
      // Failed jobs left unassessed: a restart between the failure and the assessment, or an older build's backlog.
      assessBacklog();
      // A store from the build before (issue #529): what nothing waits on any more clears before anything is handed off.
      handoffs.supersede();
      handoffs.settle();
      handoffs.catchUp();
      unsubscribe = store.events.subscribe((e) => {
        if (stopped) return;
        if (e.type === 'job.failed' && e.jobId) { const id = e.jobId; setImmediate(() => assessJob(id)); }
        handoffs.onEvent(e);
      });
      timer = setInterval(() => { void sweep(); }, o.sweepMs);
      void sweep();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      await sweeping;
    },
    sweep,
    view: () => viewOf(store, settings(), now()),
    blocks() {
      if (!settings().auto.hold) return [];
      return store.problems.list({ status: 'open' }).map((p) => ({ id: p.id, title: p.title, ...p.scope }));
    },
    settings,
    setSettings(patch) {
      const s = settings();
      const next: FailureSettings = { ...s, ...patch, auto: { ...s.auto, ...patch.auto } };
      store.settings.setFailureSettings(next);
      o.trigger('failure.settings');
      return next;
    },
    resolve: (problemId) => resolveAs(problemId, 'user'),
    release(problemId) {
      const done = store.tx((): FailureAction<Problem> => {
        const p = store.problems.get(problemId);
        if (!p) return { ok: false, reason: 'not_found', message: `problem ${problemId} not found` };
        if (releaseHeld(p.id) === 0) return { ok: false, reason: 'conflict', message: `problem ${problemId} holds no job` };
        return { ok: true, value: p };
      });
      if (done.ok) void sweep();
      return done;
    },
    retry: (recordId) => rerunRecord(recordId, 'user', 'run again by a person'),
    runAgain: (handoffId) => handoffs.runAgain(handoffId),
    clear: (handoffId) => handoffs.clear(handoffId),
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
