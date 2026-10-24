// Releasing what a job holds outside the process (its herdr pane) and reaping what it left (issue #401).
// Called after the transaction that recorded a terminal outcome, and by restart recovery. Never throws.
// That transaction writes the cleanup's record (`cleanupDue`, issue #1570): a hopper that stops before the cleanup went
// through does it from the record at its next start (`resume`), and records `job.cleaned_up` with `dueAt`.
// A cleanup that could not reach the job's machine is deferred (issue #371): recorded on the job, tried
// again on every tick until it goes through, and meanwhile a waiting job of the same item is held. A cleanup the job's own
// route cannot do (issue #2490: its ssh name no longer resolves) reaps through the machine as it is reached now.
// With a retention set for the status the job ended in on its machine (issue #2494), the reap keeps its scratch dir: the
// sweep removes it once the retention is over.
import { jobScratchOf } from '../domain/job-layout.ts';
import type { MachineShell, Reaped } from '../domain/ports.ts';
import { keptData, keptPushedOf, keptScratchOf, keptWorkOf, machineRanOn, PROXY_PUSH_EVENTS, proxyPushedOf, PUSHES_READ, TERMINAL_STATUSES, WORK_EVENTS, type CleanupDue, type Job, type MachineSnapshot } from '../domain/types.ts';
import { EngineError } from './errors.ts';
import { closeLedger, closePanesByHand, retainLedger } from './resource-ledger.ts';
import { retainedUntilOf, retainsAtEnd } from '../domain/retention.ts';
import type { SweepSettings } from '../domain/machines.ts';
import { nowIso, type EngineContext } from './context.ts';
import { heapAbortedOf } from '../domain/heap-aborts.ts';
import { coreDumpedOf, oomKilledOf } from '../domain/process-crashes.ts';
import { FAILED_PROCESS_EVENTS, failedProcessNote } from '../domain/failed-processes.ts';

/** The events of failed processes a job's cleanup reads for its note (issue #2722 part 7). */
const FAILED_PROCESSES_READ = 50;

export type Cleanup = (jobId: string) => Promise<void>;

export interface Cleanups {
  run: Cleanup;
  /** Every cleanup a record says is due or deferred (a stop before it went through), done now; ends when each ended. */
  resume(): Promise<void>;
  /** Try every deferred cleanup again that is not running now. */
  retry(): void;
  /** The ended jobs whose cleanup is running or deferred: the decider holds a waiting job of the same item. */
  due(): CleanupDue[];
  /** The user closed what the deferred cleanup could not reach, by hand, or its machine is gone for good: no longer tried. */
  markCleanedUp(jobId: string): Job;
}

/** Statuses a job can end in with its cleanup due. */
const ENDED = TERMINAL_STATUSES;

/** The cleanup's record, for the patch of the transaction that records the job's end (issue #1570). */
export const cleanupDue = (c: Pick<EngineContext, 'clock'>): Pick<Job, 'cleanupDue'> => ({ cleanupDue: { at: nowIso(c) } });

export function createCleanups(c: Pick<EngineContext, 'store' | 'executors' | 'machines' | 'keepPanes' | 'clock' | 'trigger' | 'stopping'>): Cleanups {
  const running = new Set<string>();
  /** The jobs whose cleanup `resume` found due from a stop: said so once it goes through. */
  const resumed = new Set<string>();
  /** Deferred cleanups by job id: the job's item key, and why. Seeded from the store by `resume`, so a restart keeps them. */
  const deferred = new Map<string, { sourceKey?: string; error: string }>();

  /** The machine as the first executor there that reaches it does, as the sweep reaches it. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };

  /**
   * The reap of the job's scratch dir through its machine as it is reached now (issue #2490), when its own route failed:
   * its processes stopped, its scratch dir removed unless it holds work not pushed (kept when it timed out, issue #630).
   * Rejects with its own route's error when the machine is not reached this way either.
   */
  async function reapThroughMachine(job: Job, error: unknown, keep: boolean): Promise<Reaped> {
    const cwd = (job.executorState as { cwd?: unknown } | undefined)?.cwd;
    const id = machineRanOn(job);
    const m = typeof cwd === 'string' && cwd.startsWith('/') && id ? (await c.machines.list().catch(() => [])).find((x) => x.id === id) : undefined;
    const shell = m && !m.containerImage ? shellOf(m) : undefined;
    if (!shell || typeof cwd !== 'string') throw error;
    try { return await shell.reap(job.id, jobScratchOf(cwd, job.id), job.liveness !== undefined || keep); } catch { throw error; }
  }

  /** How the job's machine sweeps (issue #2494), for its retention; machines that cannot be read keep none, as before. */
  async function sweepOf(job: Job): Promise<SweepSettings | undefined> {
    const id = machineRanOn(job);
    if (!id) return undefined;
    const machines = await Promise.resolve().then(() => c.machines.list()).catch(() => []);
    return machines.find((m) => m.id === id)?.sweep;
  }

  const run: Cleanup = async (jobId) => {
    // Scheduled with setImmediate after the tx that ended the job, so a stop and the store's close can come first (issue #828).
    if (c.keepPanes || c.stopping() || running.has(jobId)) return;
    const job = c.store.jobs.get(jobId);
    const executor = job ? c.executors.get(job.spec.executor) : undefined;
    if (!job || !ENDED.includes(job.status)) return;
    if (!executor?.cleanup) {
      if (job.cleanupDue) c.store.jobs.update(jobId, { cleanupDue: undefined });
      return;
    }
    running.add(jobId);
    try {
      // A retention set for the status it ended in, on its machine (issue #2494), or its dry run: the reap keeps its scratch dir for the sweep.
      const sweep = await sweepOf(job), keepScratch = sweep?.dryRun === true || retainsAtEnd(sweep, job.status);
      // Until when that reap, or a timed-out job's, keeps it (issue #2504 part 5): its ledger entries stay open until then.
      const retainedUntil = retainedUntilOf(sweep, job, c.clock.now().getTime());
      // Only the job's executor closes its pane (issue #2504 part 13): a reap through the machine does not.
      let panes: 'closed' | 'not_reached' = 'closed';
      const said = await executor.cleanup(job, { keepScratch }).catch((e: unknown) => { panes = 'not_reached'; return reapThroughMachine(job, e, keepScratch); });
      if (c.stopping()) return;
      // Work the hopper pushed for the job (issue #2087) is not work not pushed, whatever its remote branches say: the
      // sweep removes it.
      const pushed = said && said.kept.length > 0 ? keptPushedOf(said, proxyPushedOf(c.store.events.recent(PUSHES_READ, [...PROXY_PUSH_EVENTS], jobId))) : [];
      const reaped = said && pushed.length > 0 ? { ...said, kept: said.kept.filter((p) => !pushed.includes(p)) } : said;
      deferred.delete(jobId);
      const was = c.store.jobs.get(jobId)?.cleanupDeferred;
      c.store.tx(() => {
        // Never removed silently (issue #401): what the reap kept is flagged on the job.
        if (reaped && reaped.kept.length > 0) c.store.events.append({ type: 'job.work_kept', jobId, data: keptData(reaped, reaped.kept) });
        // The job's containers and volumes it removed (issue #1120), with what it said of each container (issue #975).
        const removed = reaped?.removed;
        const machineId = machineRanOn(job);
        if (removed && (removed.containers.length > 0 || removed.volumes.length > 0)) {
          c.store.events.append({ type: 'job.containers_removed', jobId, ...(machineId ? { machineId } : {}), data: removed });
        }
        // What the job's scope used (issue #2498), as its reap read it before it stopped the scope.
        if (reaped?.used) c.store.events.append({ type: 'job.resources_used', jobId, ...(machineId ? { machineId } : {}), data: reaped.used });
        // Each heap abort of its Node processes (issue #2722), as the reap read the report each wrote.
        for (const h of reaped?.heap ?? []) c.store.events.append({ type: 'job.heap_aborted', jobId, ...(machineId ? { machineId } : {}), data: heapAbortedOf(h) });
        // And each core dump and OOM kill of its processes (part 3), as the reap read them from the journal.
        for (const d of reaped?.cores ?? []) c.store.events.append({ type: 'job.core_dumped', jobId, ...(machineId ? { machineId } : {}), data: coreDumpedOf(d) });
        for (const k of reaped?.oomKilled ?? []) c.store.events.append({ type: 'job.oom_killed', jobId, ...(machineId ? { machineId } : {}), data: oomKilledOf(k) });
        // Its scope, when the reap could not stop it (part 6): the sweep reaps it again while it is there.
        if (reaped?.scopeNotStopped) c.store.events.append({ type: 'job.scope_not_stopped', jobId, ...(machineId ? { machineId } : {}), data: { ...reaped.scopeNotStopped } });
        // A job that ended well keeps what failed for its cards (part 7): they read no events of a job.
        const failedNote = reaped?.heap?.length || reaped?.cores?.length || reaped?.oomKilled?.length || reaped?.scopeNotStopped
          ? failedProcessNote(job.status, c.store.events.recent(FAILED_PROCESSES_READ, [...FAILED_PROCESS_EVENTS], jobId)) : undefined;
        if (failedNote) c.store.jobs.update(jobId, { failedProcesses: failedNote });
        // Its resource ledger (issue #2504) closed as the reap said: reaped, kept with the work, or failed with why.
        // A reap that kept the scratch dir for a time (part 5) closes the scope only; the sweep judges the rest after.
        if (said) closeLedger(c.store, jobId, said, nowIso(c), retainedUntil === undefined, panes);
        if (said && retainedUntil) retainLedger(c.store, jobId, retainedUntil);
        // Work an earlier end kept, pushed by the job that went on with it (issue #1010): no longer kept.
        const before = reaped && reaped.kept.length === 0 ? keptWorkOf(c.store.events.recent(1, [...WORK_EVENTS], jobId))[0] : undefined;
        if (before) c.store.events.append({ type: 'job.work_removed', jobId, data: { paths: [keptScratchOf(before, job) ?? before.paths[0]!] } });
        const now = c.store.jobs.get(jobId);
        if (now?.cleanupDeferred || now?.cleanupDue) c.store.jobs.update(jobId, { cleanupDeferred: undefined, cleanupDue: undefined });
        // Done after a stop of the hopper (issue #1570), or after it was deferred: said so.
        const due = resumed.has(jobId) ? job.cleanupDue?.at : undefined;
        if (was || due) c.store.events.append({ type: 'job.cleaned_up', jobId, data: { ...(was ? { deferredAt: was.at } : {}), ...(due ? { dueAt: due } : {}) } });
      });
    } catch (e) {
      if (c.stopping()) return;
      const error = e instanceof Error ? e.message : String(e);
      const first = !deferred.has(jobId);
      deferred.set(jobId, { sourceKey: job.source?.key, error });
      // Recorded once per deferral; a retry that fails again changes nothing.
      if (first && !c.store.jobs.get(jobId)?.cleanupDeferred) {
        console.error('executor cleanup deferred', jobId, error);
        c.store.tx(() => {
          c.store.jobs.update(jobId, { cleanupDeferred: { at: nowIso(c), error } });
          c.store.events.append({ type: 'job.cleanup_deferred', jobId, data: { error } });
        });
      }
    } finally {
      running.delete(jobId);
      resumed.delete(jobId);
    }
    // A waiting job of the same item may be admitted now, or held with the new reason.
    c.trigger('cleanup');
  };

  return {
    run,
    async resume() {
      if (c.keepPanes) return;
      const owed = c.store.jobs.list({ status: [...ENDED] }).filter((j) => j.cleanupDue || j.cleanupDeferred);
      for (const job of owed) {
        if (job.cleanupDeferred) deferred.set(job.id, { sourceKey: job.source?.key, error: job.cleanupDeferred.error });
        else resumed.add(job.id);
      }
      await Promise.all(owed.map((j) => run(j.id)));
    },
    retry() {
      for (const jobId of deferred.keys()) if (!running.has(jobId)) void run(jobId);
    },
    due() {
      const out: CleanupDue[] = [];
      for (const [jobId, d] of deferred) if (d.sourceKey) out.push({ jobId, sourceKey: d.sourceKey, error: d.error });
      for (const jobId of running) {
        if (deferred.has(jobId)) continue;
        const key = c.store.jobs.get(jobId)?.source?.key;
        if (key) out.push({ jobId, sourceKey: key });
      }
      return out.sort((a, b) => a.jobId.localeCompare(b.jobId));
    },
    markCleanedUp(jobId) {
      const job = c.store.jobs.get(jobId);
      if (!job) throw new EngineError('not_found', `job ${jobId} not found`);
      const was = job.cleanupDeferred;
      if (!was) throw new EngineError('conflict', `job ${jobId} has no deferred cleanup`);
      if (running.has(jobId)) throw new EngineError('conflict', `job ${jobId}'s cleanup is being tried now: try again`);
      deferred.delete(jobId);
      const next = c.store.tx(() => {
        const marked = c.store.jobs.update(jobId, { cleanupDeferred: undefined, cleanupDue: undefined });
        closePanesByHand(c.store, jobId, nowIso(c));
        c.store.events.append({ type: 'job.cleaned_up', jobId, data: { deferredAt: was.at, by: 'user' } });
        return marked;
      });
      c.trigger('cleanup');
      return next;
    },
  };
}
