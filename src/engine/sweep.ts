// The sweep (issue #410, design.md "Work tree" → "The sweep"): the reap runs when a job's pane closes, so a
// hopper that crashed, a pane lost, a machine that rebooted or could not be reached left nothing to run it.
// At startup, after recovery, and then on each machine every `sweep.everyMinutes` (a machine option, default
// 10), the sweep asks the machine what jobs left there — through an executor that reaches it — and reaps:
// - a scope or a process of a job this hopper knows that is not live (claimed, running, waiting on an
//   answer, or led by an operator): stopped;
// - an ended job's scratch dir, once it is `sweep.scratchMaxAgeHours` old (default 24), or at once while its
//   work was kept (job.work_kept): removed unless it still holds work not pushed. Work kept that the sweep
//   then removes is recorded as job.work_removed; work it keeps for the first time, as job.work_kept.
// A job id the hopper does not know is never touched: it may be another hopper's, or a test's.
// Work kept is logged once, when first kept; the next passes keep it quietly (issue #1010). A person may discard it
// (issue #1010, design.md "Work not pushed"): its scratch dir is reaped on its machine whatever it holds.
import type { ActingPerson, Job, MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Survey } from '../domain/ports.ts';
import { keptScratchOf, keptWorkOf, machineRanOn, TERMINAL_STATUSES, WORK_EVENTS } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

export const SWEEP_EVERY_MINUTES = 10;
export const SCRATCH_MAX_AGE_HOURS = 24;
/** How often the engine looks for a machine whose sweep is due. */
export const SWEEP_CHECK_MS = 60000;
/** The jobs whose work trees are swept: the newest this many. */
const JOBS_SWEPT = 2000;
/** The work-kept trail read back: the newest this many events. */
const KEPT_EVENTS = 1000;

/** A job whose processes may run: anything else of its own on a machine is a leftover. */
const LIVE = new Set<Job['status']>(['claimed', 'running', 'waiting_answer', 'waiting_on', 'operator_led']);

/** One reap the sweep asks of a machine. */
export interface SweepReap { jobId: string; scratch?: string }

/** Pure: what to reap on one machine, from what its survey found. `kept`: jobs whose work was kept and not removed since. */
export function planSweep(found: Survey, jobOf: (id: string) => Job | undefined, kept: ReadonlySet<string>, maxAgeMs: number): SweepReap[] {
  const plan = new Map<string, SweepReap>();
  for (const id of new Set([...found.scopes, ...found.processes])) {
    const job = jobOf(id);
    if (job && !LIVE.has(job.status)) plan.set(id, { jobId: id });
  }
  for (const dir of found.scratch) {
    const job = jobOf(dir.jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status)) continue;
    if (dir.ageMs >= maxAgeMs || kept.has(dir.jobId)) plan.set(dir.jobId, { jobId: dir.jobId, scratch: dir.path });
  }
  return [...plan.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
}

const minutes = (m: MachineSnapshot): number => m.sweep?.everyMinutes ?? SWEEP_EVERY_MINUTES;
const maxAgeMs = (m: MachineSnapshot): number => (m.sweep?.scratchMaxAgeHours ?? SCRATCH_MAX_AGE_HOURS) * 3600_000;

export interface Sweep {
  /** Sweep every online machine that is due (`all`: every online machine now). Never throws; one at a time. */
  run(all?: boolean): Promise<void>;
  /**
   * Discard an ended job's kept work (issue #1010): its scratch dir reaped on its machine whatever it holds, then
   * `job.work_removed` with `discarded` and who. Throws `not_found`, or `conflict` with why: no work kept, the job not
   * ended, its machine unknown, offline or out of reach, or the machine kept it all the same (a client older than this).
   */
  discard(jobId: string, by: ActingPerson): Promise<{ jobId: string; paths: string[] }>;
}

export function createSweep(c: Pick<EngineContext, 'store' | 'executors' | 'machines' | 'clock' | 'stopping'>, log: (line: string) => void = (l) => console.warn(l)): Sweep {
  const last = new Map<string, number>();
  let busy = false;

  /** The machine as the first executor there that reaches it does. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };

  /** Jobs whose work was kept and not removed since: the newest work event of each. */
  const keptJobs = (): Set<string> => new Set(keptWorkOf(c.store.events.recent(KEPT_EVENTS, [...WORK_EVENTS])).map((k) => k.jobId));

  async function sweepOne(m: MachineSnapshot, shell: MachineShell, roots: string[], jobOf: (id: string) => Job | undefined, kept: Set<string>): Promise<void> {
    const found = await shell.survey(roots);
    for (const r of planSweep(found, jobOf, kept, maxAgeMs(m))) {
      if (c.stopping()) return;
      let said;
      try {
        said = await shell.reap(r.jobId, r.scratch);
      } catch (e) {
        log(`hopper: the sweep could not reap job ${r.jobId} on ${m.id}: ${(e as Error).message}`);
        continue;
      }
      // Kept again is no news: logged only the first time.
      const again = r.scratch !== undefined && said.kept.length > 0 && kept.has(r.jobId);
      if (!again) log(`hopper: the sweep reaped job ${r.jobId} on ${m.id}${r.scratch ? `, its scratch dir ${said.kept.length ? 'kept: it holds work not pushed' : 'removed'}` : ''}`);
      if (!r.scratch || c.stopping()) continue;
      if (said.kept.length > 0 && !kept.has(r.jobId)) c.store.events.append({ type: 'job.work_kept', jobId: r.jobId, data: { paths: said.kept } });
      if (said.kept.length === 0 && kept.has(r.jobId)) c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch] } });
    }
  }

  const refuse = (jobId: string, why: string): EngineError => new EngineError('conflict', `job ${jobId}'s work cannot be discarded: ${why}`);

  return {
    async discard(jobId, by) {
      const job = c.store.jobs.get(jobId);
      if (!job) throw new EngineError('not_found', `job ${jobId} not found`);
      const kept = keptWorkOf(c.store.events.recent(1, [...WORK_EVENTS], jobId))[0];
      if (!kept) throw new EngineError('conflict', `job ${jobId} has no work kept`);
      if (!TERMINAL_STATUSES.includes(job.status)) throw new EngineError('conflict', `job ${jobId} is ${job.status}: only an ended job's work is discarded`);
      const scratch = keptScratchOf(kept, job);
      if (!scratch) throw refuse(jobId, 'its scratch dir is not known');
      const machineId = machineRanOn(job);
      const m = machineId ? (await c.machines.list()).find((x) => x.id === machineId) : undefined;
      if (!machineId || !m) throw refuse(jobId, machineId ? `its machine ${machineId} is gone` : 'its machine is not known');
      if (!m.online) throw refuse(jobId, `its machine ${m.id} is offline`);
      const shell = shellOf(m);
      if (!shell) throw refuse(jobId, `no executor reaches its machine ${m.id}`);
      let said;
      try {
        said = await shell.reap(jobId, scratch, false, true);
      } catch (e) {
        throw refuse(jobId, (e as Error).message);
      }
      if (said.kept.length > 0) throw refuse(jobId, `the machine ${m.id} kept it: update its client, then discard it again`);
      log(`hopper: job ${jobId}'s kept work was discarded on ${m.id}, its scratch dir removed`);
      c.store.events.append({ type: 'job.work_removed', jobId, data: { paths: [scratch], discarded: true, ...by } });
      return { jobId, paths: [scratch] };
    },
    async run(all = false) {
      if (busy || c.stopping()) return;
      busy = true;
      try {
        const now = c.clock.now().getTime();
        const due = (await c.machines.list()).filter((m) => m.online && !m.docker && (all || now - (last.get(m.id) ?? -Infinity) >= minutes(m) * 60_000));
        if (due.length === 0) return;
        const recent = c.store.jobs.list({ limit: JOBS_SWEPT });
        const byId = new Map(recent.map((j) => [j.id, j]));
        const jobOf = (id: string): Job | undefined => byId.get(id) ?? c.store.jobs.get(id);
        const roots = [...new Set(recent.map((j) => (j.executorState as { cwd?: unknown } | undefined)?.cwd).filter((p): p is string => typeof p === 'string' && p.startsWith('/')))].sort();
        const kept = keptJobs();
        for (const m of due) {
          if (c.stopping()) return;
          last.set(m.id, now);
          const shell = shellOf(m);
          if (!shell) continue;
          await sweepOne(m, shell, roots, jobOf, kept).catch((e: unknown) => log(`hopper: the sweep could not survey ${m.id}: ${(e as Error).message}`));
        }
      } catch (e) {
        log(`hopper: the sweep failed: ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    },
  };
}
