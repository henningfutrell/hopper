// The sweep (issue #410, design.md "Work tree" → "The sweep"): the reap runs when a job's pane closes, so a
// hopper that crashed, a pane lost, a machine that rebooted or could not be reached left nothing to run it.
// At startup, after recovery, and then on each machine every `sweep.everyMinutes` (a machine option, default
// 10), the sweep asks the machine what jobs left there — through an executor that reaches it — and reaps:
// - a scope or a process of a job this hopper knows that is not live (claimed, running, waiting on an
//   answer, or led by an operator): stopped;
// - an ended job's scratch dir, once it is `sweep.scratchMaxAgeHours` old (default 24), or at once while its
//   work was kept (job.work_kept): removed unless it still holds work not pushed. Its job worktree in the work tree's
//   workspace (issue #1103) goes or stays with it, and one whose scratch dir is gone is reaped by that dir all the same. Work kept that the sweep
//   then removes is recorded as job.work_removed; work it keeps for the first time, as job.work_kept.
// A job id the hopper does not know is never touched: it may be another hopper's, or a test's.
// Work kept is logged once, when first kept; the next passes keep it quietly (issue #1010). A person may discard it
// (issue #1010, design.md "Work not pushed"): its scratch dir is reaped on its machine whatever it holds. Kept work of a
// job whose work item is done, as the work-item ledger has it, waits on nobody: the sweep discards it so (issue #1105),
// recorded as job.work_removed, discarded, with no person. Kept work whose scratch dir and job worktree are gone from a
// work tree the survey found on the job's machine (removed by hand, or by a cleanup outside the hopper) is resolved so
// (issue #1120): job.work_removed with gone, nothing removed. Should it come back, the sweep finds it and keeps it again.
// The survey also measures the hopper's own disk use in each work tree (issue #1120, design.md "Hopper's own disk use"): the
// sweep keeps each machine's last measure, which Machines shows. Over the user's disk budget, it reaps every ended job's
// scratch dir at once, whatever its age (work not pushed is still kept), and measures again; still over, a person is told
// once (machine.disk_over_budget), and once more when it is back within it (machine.disk_within_budget). Kept in memory:
// after a restart, the first pass measures again, and a machine still over is told again.
import type { ActingPerson, DiskBudget, HopperDisk, HopperDiskPath, Job, KeptWork, MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Survey } from '../domain/ports.ts';
import { hopperDiskOf, keptScratchOf, keptWorkOf, machineRanOn, TERMINAL_STATUSES, WORK_EVENTS } from '../domain/types.ts';
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

const TREES = '/workspace/worktrees/';

/** The known job a job worktree `<name>-<job id>` is of (issue #1103): its name may hold `-` too, so each split is tried. */
function treeJob(path: string, jobOf: (id: string) => Job | undefined): Job | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  for (let at = name.indexOf('-'); at >= 0; at = name.indexOf('-', at + 1)) {
    const job = jobOf(name.slice(at + 1));
    if (job) return job;
  }
  return undefined;
}

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
  for (const tree of found.trees ?? []) {
    const job = treeJob(tree.path, jobOf);
    if (!job || !TERMINAL_STATUSES.includes(job.status) || plan.get(job.id)?.scratch) continue;
    const root = tree.path.slice(0, tree.path.lastIndexOf(TREES));
    if (tree.ageMs >= maxAgeMs || kept.has(job.id)) plan.set(job.id, { jobId: job.id, scratch: `${root}/.hopper-scratch/${job.id}` });
  }
  return [...plan.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
}

/**
 * Pure: the kept work on machine `machineId` that is gone (issue #1120), each with its scratch dir: an ended job's that ran
 * there, whose scratch dir is in a work tree the survey found (`found.roots`), and which the survey found neither as a
 * scratch dir nor as a job worktree. None when the survey names no work tree (a client older than this).
 */
export function goneKept(found: Survey, kept: readonly KeptWork[], jobOf: (id: string) => Job | undefined, machineId: string): { jobId: string; scratch: string }[] {
  const roots = new Set(found.roots ?? []);
  if (roots.size === 0) return [];
  const there = new Set(found.scratch.map((d) => d.jobId));
  for (const tree of found.trees ?? []) {
    const job = treeJob(tree.path, jobOf);
    if (job) there.add(job.id);
  }
  const out: { jobId: string; scratch: string }[] = [];
  for (const k of kept) {
    const job = jobOf(k.jobId);
    if (!job || there.has(job.id) || !TERMINAL_STATUSES.includes(job.status) || machineRanOn(job) !== machineId) continue;
    const scratch = keptScratchOf(k, job);
    if (scratch && roots.has(scratch.slice(0, scratch.lastIndexOf('/.hopper-scratch/')))) out.push({ jobId: job.id, scratch });
  }
  return out.sort((a, b) => a.jobId.localeCompare(b.jobId));
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
  /** The hopper's own disk use on the machine as the sweep last measured it, against the disk budget now (issue #1120); undefined: never measured. */
  disk(machineId: string): HopperDisk | undefined;
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

export function createSweep(c: Pick<EngineContext, 'store' | 'executors' | 'machines' | 'clock' | 'stopping'>, log: (line: string) => void = (l) => console.warn(l)): Sweep {
  const last = new Map<string, number>();
  /** Each machine's last measure (issue #1120), and the machines told over the disk budget. */
  const measured = new Map<string, { paths: HopperDiskPath[]; at: string }>();
  const told = new Set<string>();
  let busy = false;
  const budgetNow = (): DiskBudget | undefined => c.store.settings.getDiskBudget();

  /** The machine as the first executor there that reaches it does. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };

  /** Work kept and not removed since: the newest work event of each job. */
  const keptNow = (): KeptWork[] => keptWorkOf(c.store.events.recent(KEPT_EVENTS, [...WORK_EVENTS]));

  /** Whether the job's work item is done, as the ledger has it: its kept work waits on nobody. */
  const itemDone = (job: Job | undefined): boolean => {
    const key = job?.source?.key;
    return key !== undefined && c.store.workItems.get(key)?.state === 'done';
  };

  /** The machine's measure kept, and a person told when it goes over the budget or back within it. */
  function measure(m: MachineSnapshot, found: Survey, budget: DiskBudget | undefined): void {
    const at = c.clock.now().toISOString();
    const disk = hopperDiskOf(found.usage, at, budget);
    if (!disk) return;
    measured.set(m.id, { paths: disk.paths, at });
    if (!budget) { told.delete(m.id); return; }
    if (disk.over && !told.has(m.id)) {
      told.add(m.id);
      log(`hopper: the hopper's own disk use on ${m.id} is ${gb(disk.bytes)}, still over its disk budget of ${gb(budget.bytes)}`);
      c.store.events.append({ type: 'machine.disk_over_budget', machineId: m.id, data: { machineId: m.id, usedBytes: disk.bytes, budgetBytes: budget.bytes, paths: disk.paths } });
    } else if (!disk.over && told.delete(m.id)) {
      c.store.events.append({ type: 'machine.disk_within_budget', machineId: m.id, data: { machineId: m.id, usedBytes: disk.bytes, budgetBytes: budget.bytes } });
    }
  }

  async function sweepOne(m: MachineSnapshot, shell: MachineShell, roots: string[], jobOf: (id: string) => Job | undefined, keptWork: KeptWork[]): Promise<void> {
    const kept = new Set(keptWork.map((k) => k.jobId));
    const found = await shell.survey(roots);
    for (const g of goneKept(found, keptWork, jobOf, m.id)) {
      if (c.stopping()) return;
      log(`hopper: job ${g.jobId}'s kept work is gone from ${m.id}: its scratch dir ${g.scratch} is no longer there`);
      c.store.events.append({ type: 'job.work_removed', jobId: g.jobId, data: { paths: [g.scratch], gone: true } });
    }
    const budget = budgetNow();
    const pressed = hopperDiskOf(found.usage, '', budget);
    if (pressed?.over) log(`hopper: the hopper's own disk use on ${m.id} is ${gb(pressed.bytes)}, over its disk budget of ${gb(budget!.bytes)}: the sweep reaps every ended job's scratch dir now, whatever its age`);
    const removed = await reapPlan(m, shell, planSweep(found, jobOf, kept, pressed?.over ? 0 : maxAgeMs(m)), jobOf, kept);
    if (c.stopping()) return;
    // What the reaps freed, measured again; a survey that fails then keeps the first measure.
    const after = pressed?.over && removed > 0 ? await shell.survey(roots).catch(() => found) : found;
    measure(m, after, budget);
  }

  /** The reaps of one pass on the machine; how many scratch dirs they removed. */
  async function reapPlan(m: MachineSnapshot, shell: MachineShell, plan: SweepReap[], jobOf: (id: string) => Job | undefined, kept: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const r of plan) {
      if (c.stopping()) return removed;
      const discard = r.scratch !== undefined && kept.has(r.jobId) && itemDone(jobOf(r.jobId));
      let said;
      try {
        said = discard ? await shell.reap(r.jobId, r.scratch, false, true) : await shell.reap(r.jobId, r.scratch);
      } catch (e) {
        log(`hopper: the sweep could not reap job ${r.jobId} on ${m.id}: ${(e as Error).message}`);
        continue;
      }
      if (r.scratch && said.kept.length === 0) removed += 1;
      if (discard && said.kept.length === 0) {
        log(`hopper: the sweep discarded job ${r.jobId}'s kept work on ${m.id}: its item is done`);
        c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch!], discarded: true } });
        continue;
      }
      // Kept again is no news: logged only the first time.
      const again = r.scratch !== undefined && said.kept.length > 0 && kept.has(r.jobId);
      if (!again) log(`hopper: the sweep reaped job ${r.jobId} on ${m.id}${r.scratch ? `, its scratch dir ${said.kept.length ? 'kept: it holds work not pushed' : 'removed'}` : ''}`);
      if (!r.scratch || c.stopping()) continue;
      if (said.kept.length > 0 && !kept.has(r.jobId)) c.store.events.append({ type: 'job.work_kept', jobId: r.jobId, data: { paths: said.kept } });
      if (said.kept.length === 0 && kept.has(r.jobId)) c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch] } });
    }
    return removed;
  }

  const refuse = (jobId: string, why: string): EngineError => new EngineError('conflict', `job ${jobId}'s work cannot be discarded: ${why}`);

  return {
    disk(machineId) {
      const m = measured.get(machineId);
      return m ? hopperDiskOf(m.paths, m.at, budgetNow()) : undefined;
    },
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
        const kept = keptNow();
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
