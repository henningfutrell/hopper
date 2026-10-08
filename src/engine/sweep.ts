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
import type { Job, MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Survey } from '../domain/ports.ts';
import { TERMINAL_STATUSES } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export const SWEEP_EVERY_MINUTES = 10;
export const SCRATCH_MAX_AGE_HOURS = 24;
/** How often the engine looks for a machine whose sweep is due. */
export const SWEEP_CHECK_MS = 60000;
/** The jobs whose work trees are swept: the newest this many. */
const JOBS_SWEPT = 2000;
/** The work-kept trail read back: the newest this many events. */
const KEPT_EVENTS = 1000;

/** A job whose processes may run: anything else of its own on a machine is a leftover. */
const LIVE = new Set<Job['status']>(['claimed', 'running', 'waiting_answer', 'operator_led']);

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
}

export function createSweep(c: Pick<EngineContext, 'store' | 'executors' | 'machines' | 'clock' | 'stopping'>, log: (line: string) => void = (l) => console.info(l)): Sweep {
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
  function keptJobs(): Set<string> {
    const seen = new Set<string>();
    const kept = new Set<string>();
    for (const e of c.store.events.recent(KEPT_EVENTS, ['job.work_kept', 'job.work_removed'])) {
      if (!e.jobId || seen.has(e.jobId)) continue;
      seen.add(e.jobId);
      if (e.type === 'job.work_kept') kept.add(e.jobId);
    }
    return kept;
  }

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
      log(`hopper: the sweep reaped job ${r.jobId} on ${m.id}${r.scratch ? `, its scratch dir ${said.kept.length ? 'kept: it holds work not pushed' : 'removed'}` : ''}`);
      if (!r.scratch || c.stopping()) continue;
      if (said.kept.length > 0 && !kept.has(r.jobId)) c.store.events.append({ type: 'job.work_kept', jobId: r.jobId, data: { paths: said.kept } });
      if (said.kept.length === 0 && kept.has(r.jobId)) c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch] } });
    }
  }

  return {
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
