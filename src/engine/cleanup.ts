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
import { closeLedger } from './resource-ledger.ts';
import { retainsAtEnd } from '../domain/retention.ts';
import { nowIso, type EngineContext } from './context.ts';

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

  /** Whether the job's machine keeps its work past its end (issue #2494); machines that cannot be read keep none, as before. */
  async function retainedAtEnd(job: Job): Promise<boolean> {
    const id = machineRanOn(job);
    if (!id) return false;
    const machines = await Promise.resolve().then(() => c.machines.list()).catch(() => []);
    return retainsAtEnd(machines.find((m) => m.id === id)?.sweep, job.status);
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
      // A retention set for the status it ended in, on its machine (issue #2494): the reap keeps its scratch dir for the sweep.
      const keepScratch = await retainedAtEnd(job);
      const said = await executor.cleanup(job, { keepScratch }).catch((e: unknown) => reapThroughMachine(job, e, keepScratch));
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
        // Its resource ledger (issue #2504) closed as the reap said: reaped, kept with the work, or failed with why.
        if (said) closeLedger(c.store, jobId, said, nowIso(c));
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
        c.store.events.append({ type: 'job.cleaned_up', jobId, data: { deferredAt: was.at, by: 'user' } });
        return marked;
      });
      c.trigger('cleanup');
      return next;
    },
  };
}
