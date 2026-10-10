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
// is active and it is sure. A timed-out job (issue #630) is assessed from its liveness: its source is asked first whether
// a pull request of its own is open — at most `PR_LOOKUP_MS`, never holding the assessment —, and Continue, when due,
// resumes its own agent session in its kept work tree, else runs its item again, told to go on.
import type { Clock, RerunBy, UserStore } from '../domain/ports.ts';
import {
  failureSettingsOf, jobPriorityTag, type ActingPerson, type JevFirst, type FailureOutcome, type FailureRecord, type FailureSettings, type FailuresView, type Job, type KnownCause, type MachineSnapshot,
  type HandoffView, type NamedCause, type PendingRun, type Problem, type ProblemBlock,
} from '../domain/types.ts';
import { assess, STALE_AFTER_MS, type RecentFailure } from './assess.ts';
import { BUILTIN_CAUSES, matchCause, namedCause } from './causes.ts';
import { evidenceOf, machineOf } from './evidence.ts';
import { askJev, type JevCase } from './jev.ts';
import { attemptOf, timeoutInputOf } from './chain.ts';
import { createTimeouts } from './timeouts.ts';
import { rerunRecordOf } from './rerun.ts';
import { createHandoffs, type HandoffResolve, type HandoffsOptions } from './handoffs.ts';
import { createItemCheck } from './item-check.ts';
import { signatureOf } from './signature.ts';
import { highestFirst, newerOf, releasable, viewOf } from './view.ts';

/** `rerun` (the sync loop's Run again, which the assessor's runs again use too), `continueJob`, `resumable`, `dismiss`: as the hand-offs take them. */
export interface FailuresOptions extends Pick<HandoffsOptions, 'rerun' | 'continueJob' | 'resumable' | 'dismiss'> {
  store: UserStore;
  clock: Clock;
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
  /** Whether a pull request of the job's own is open, by its source (issue #630); undefined: its source cannot tell. Throws: not known. */
  pullRequestOpen?(job: Job): Promise<boolean | undefined>;
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
  /** A person resolves a problem, with a note if any: its held jobs run again, new jobs are no longer held for it. */
  resolve(problemId: string, by: ActingPerson, note?: string): FailureAction<Problem>;
  /** A person releases a problem's held jobs now: they run again through the normal queue. */
  release(problemId: string, by: ActingPerson): FailureAction<Problem>;
  /** A person runs a surfaced failure's job again. */
  retry(recordId: string, by: ActingPerson): Promise<FailureAction<Job>>;
  /** A person resolves a hand-off (issue #551), `by` the person signed in and the way: the hand-off and the job that follows, if any. */
  resolveHandoff(handoffId: string, input: HandoffResolve, by: ActingPerson): Promise<FailureAction<{ handoff: HandoffView; job?: Job }>>;
  nameCause(cause: NamedCause): KnownCause;
  forgetCause(signature: string): boolean;
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
  let sweeping: Promise<void> | undefined;
  let prunedAt = 0;
  const now = () => clock.now();
  // Settings saved before a field existed take its default; `auto` too, field by field (issue #630: `auto.continue`).
  const settings = (): FailureSettings => failureSettingsOf(store.settings.getFailureSettings());
  const handoffs = createHandoffs({ store, clock, settings, rerun: o.rerun, continueJob: o.continueJob, resumable: o.resumable, dismiss: o.dismiss, logger: o.logger, live: () => !stopped });
  const timeouts = createTimeouts({ store, pullRequestOpen: o.pullRequestOpen, logger: o.logger, live: () => !stopped, resumable: o.resumable, continueJob: o.continueJob, rerun: o.rerun });
  const checkItems = createItemCheck({ store, clock, itemClosed: o.itemClosed, closed: (id) => handoffs.itemClosed(id), logger: o.logger, live: () => !stopped });

  /** Its latest run has a record — unless the job was continued since (issue #551): its new failure is assessed anew. */
  const assessedRun = (jobId: string): boolean => { const r = store.failures.forJob(jobId); return r !== undefined && !(r.outcome === 'retried' && r.nextJobId === jobId); };

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
      if (!job || job.status !== 'failed' || job.assessment || assessedRun(jobId)) return;
      const s = settings();
      const at = now();
      const error = job.error ?? 'failed without a reason';
      const { normalised, signature } = signatureOf(error);
      const cause = matchCause(error, signature, store.settings.getNamedCauses());
      const machineId = machineOf(job);
      const attempt = attemptOf(store, job);
      const ranMs = job.startedAt && job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : undefined;
      const recent = recentOf(job, signature, s);
      const open = openFor(signature, machineId);
      const a = assess({
        error, signature, cause, attempt, recent, settings: s,
        newer: newerOf(store, job), failedAgoMs: Math.max(0, at.getTime() - Date.parse(job.finishedAt ?? job.updatedAt)),
        job: { executor: job.spec.executor, pinned: job.spec.machineId !== undefined, ...(machineId ? { machineId } : {}) },
        ...(ranMs !== undefined ? { ranMs } : {}), ...(job.errorTail ? { tail: job.errorTail } : {}),
        ...(open ? { open: { id: open.id, title: open.title, decision: open.decision } } : {}),
        ...(cause?.id === 'timed-out' ? timeoutInputOf(store, job) : {}),
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
      const acts = a.auto && (a.decision === 'retry' || a.decision === 'redirect' || a.decision === 'continue');
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
    const result = r.pending === 'continue' ? await timeouts.continueOf(r) : await o.rerun(r.jobId, 'assessor');
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
        // A timeout's facts first (issue #630), then the assessment.
        if (e.type === 'job.failed' && e.jobId) { const id = e.jobId; setImmediate(() => { void timeouts.lookUpPullRequest(id).catch(() => {}).then(() => assessJob(id)); }); }
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
    view: () => viewOf(store, settings(), now(), o.resumable),
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
    retry: (recordId, by) => rerunRecordOf({ store, rerun: o.rerun, now }, recordId, 'user', 'run again by a person', by),
    resolveHandoff: (handoffId, input, by) => handoffs.resolve(handoffId, input, by),
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
