// The sweep (issue #410, design.md "Work tree" → "The sweep"): the reap runs when a job's pane closes, so a
// hopper that crashed, a pane lost, a machine that rebooted or could not be reached left nothing to run it.
// At startup, after recovery, and then on each machine every `sweep.everyMinutes` (a machine option, default
// 10), the sweep asks the machine what jobs left there — through an executor that reaches it — and reaps:
// - a scope or a process of a job this hopper knows that is not live (claimed, running, waiting on an
//   answer, or led by an operator): stopped;
// - an ended job's scratch dir, once it is `sweep.scratchMaxAgeHours` old (default 24), or at once while its
//   work was kept (job.work_kept): removed unless it still holds work not pushed. Its job worktree in the work tree's
//   `.worktrees` (issue #1188) goes or stays with it, and one whose scratch dir is gone is reaped by that dir all the same. Work kept that the sweep
//   then removes is recorded as job.work_removed; work it keeps for the first time, as job.work_kept.
// A job id the hopper does not know is never touched: it may be another hopper's, or a test's.
// Work kept is logged once, when first kept; the next passes keep it quietly (issue #1010). A person may discard it
// (issue #1010, design.md "Work not pushed"): its scratch dir is reaped on its machine whatever it holds. Kept work of a
// job whose work item is done, as the work-item ledger has it, waits on nobody: the sweep discards it so (issue #1105),
// recorded as job.work_removed, discarded, with no person and the reason `merged`. So does kept work a newer job of its
// item took over, once that job finished with nothing kept (`superseded`), and kept work of a job that finished a proposal
// or a research report (`proposal`, `research`): it never had work to push (issue #1187). Kept work whose scratch dir and job worktree are gone from a
// work tree the survey found on the job's machine (removed by hand, or by a cleanup outside the hopper) is resolved so
// (issue #1120): job.work_removed with gone, nothing removed. Should it come back, the sweep finds it and keeps it again.
// The survey also measures the hopper's own disk use in each work tree (issue #1120, design.md "Hopper's own disk use"): the
// sweep keeps each machine's last measure, which Machines shows. Over the user's disk budget, it reaps every ended job's
// scratch dir at once, whatever its age (work not pushed is still kept), and measures again; still over, a person is told
// once (machine.disk_over_budget), and once more when it is back within it (machine.disk_within_budget). Kept in memory:
// after a restart, the first pass measures again, and a machine still over is told again.
// An ended job with a container or a volume labelled with its id still on the machine (issue #1120) is reaped at once,
// whatever its age: the reap removes them. What any reap removed of them is recorded as job.containers_removed.
// Leftovers (issue #1116, design.md "Leftovers a person decides"): after its reaps, each pass lists what the layout before
// issue #1188 left in the `.hopper-scratch` of each work tree the survey found, with size, age and whether it holds work not
// pushed, and keeps, in memory, the leftovers it does not judge — a dir of no job the hopper knows, and the repository mirrors.
// Machines shows them; a person keeps or removes each one (`decideLeftover`). The sweep removes none by itself.
import type { ActingPerson, Discarding, DiskBudget, HopperDisk, HopperDiskPath, Job, KeptWork, MachineLeftovers, MachineSnapshot } from '../domain/types.ts';
import type { MachineShell, Reaped, Survey } from '../domain/ports.ts';
import { discardReasonOf, hopperDiskOf, keptScratchOf, keptWorkOf, machineRanOn, TERMINAL_STATUSES, WORK_EVENTS, type WorkDiscardReason } from '../domain/types.ts';
import { jobScratchOf, scratchParts, worktreeParts } from '../domain/job-layout.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { createLeftovers } from './sweep-leftovers.ts';

export const SWEEP_EVERY_MINUTES = 10;
export const SCRATCH_MAX_AGE_HOURS = 24;
/** How often the engine looks for a machine whose sweep is due. */
export const SWEEP_CHECK_MS = 60000;
/** The jobs whose work trees are swept: the newest this many. */
const JOBS_SWEPT = 2000;
/** The work-kept trail read back: the newest this many events. */
const KEPT_EVENTS = 1000;
/**
 * How long the sweep waits before it reaps again a job whose dir the reap could not remove (issue #1613): each pass would
 * only fail the same way, and a reset of its container storage is slow. A scope or process of the job is stopped all the same.
 */
export const STUCK_RETRY_MS = 6 * 3600_000;

/** A job whose processes may run: anything else of its own on a machine is a leftover. */
const LIVE = new Set<Job['status']>(['claimed', 'running', 'waiting_answer', 'waiting_on', 'operator_led']);

/** One reap the sweep asks of a machine. */
export interface SweepReap { jobId: string; scratch?: string }

/**
 * The known job a job worktree is of: `<job id>` its name (issue #1188), or `<name>-<job id>` in the layout before, whose
 * name may hold `-` too, so each split is tried.
 */
function treeJob(path: string, jobOf: (id: string) => Job | undefined): Job | undefined {
  const tree = worktreeParts(path);
  if (!tree) return undefined;
  const name = tree.name;
  if (!tree.old) return jobOf(name);
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
  for (const id of found.containers ?? []) {
    const job = jobOf(id);
    if (job && TERMINAL_STATUSES.includes(job.status)) plan.set(id, { jobId: id });
  }
  for (const dir of found.scratch) {
    const job = jobOf(dir.jobId);
    if (!job || !TERMINAL_STATUSES.includes(job.status)) continue;
    if (dir.ageMs >= maxAgeMs || kept.has(dir.jobId)) plan.set(dir.jobId, { jobId: dir.jobId, scratch: dir.path });
  }
  for (const tree of found.trees ?? []) {
    const job = treeJob(tree.path, jobOf);
    if (!job || !TERMINAL_STATUSES.includes(job.status) || plan.get(job.id)?.scratch) continue;
    const root = worktreeParts(tree.path)!.workTree;
    if (tree.ageMs >= maxAgeMs || kept.has(job.id)) plan.set(job.id, { jobId: job.id, scratch: jobScratchOf(root, job.id) });
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
    const root = scratch ? scratchParts(scratch)?.workTree : undefined;
    if (scratch && root && roots.has(root)) out.push({ jobId: job.id, scratch });
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
   * `job.work_removed` with `discarded` and who. Answers once the checks pass, before the reap (issue #1194): the reap
   * runs after, as `discarding` says; out of reach, or the machine kept it all the same (a client older than this), it
   * records `job.work_discard_failed` with why. Throws `not_found`, or `conflict` with why: no work kept, the job not
   * ended, or its machine unknown or offline. A discard while one is removed answers that one.
   */
  discard(jobId: string, by: ActingPerson): Promise<{ jobId: string; paths: string[] }>;
  /** A discard's removal under way, or why it failed (issue #1194); undefined: none asked, or it went through. */
  discarding(jobId: string): Discarding | undefined;
  /** Ends when every discard's removal under way ended. */
  removals(): Promise<void>;
  /** The hopper's own disk use on the machine as the sweep last measured it, against the disk budget now (issue #1120); undefined: never measured. */
  disk(machineId: string): HopperDisk | undefined;
  /** The leftovers on the machine the sweep last listed, with the decisions that stand (issue #1116); undefined: none listed. */
  leftovers(machineId: string): MachineLeftovers | undefined;
  /**
   * A person's decision on one leftover the sweep listed on the machine (issue #1116): `keep` records it
   * (`machine.leftover_kept`); `remove` removes it there whatever it holds, then records `machine.leftover_removed`. Throws
   * `not_found` (no such machine), or `conflict` with why: not listed there, the machine offline or out of reach, or the
   * removal left it there.
   */
  decideLeftover(machineId: string, path: string, decision: 'keep' | 'remove', by: ActingPerson): Promise<{ machineId: string; path: string; decision: 'keep' | 'remove' }>;
}

const WHY: Record<WorkDiscardReason, string> = {
  merged: 'its item is done', superseded: 'a newer job of its item finished', proposal: 'it finished a proposal', research: 'it finished a research report',
};

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

export function createSweep(c: Pick<EngineContext, 'store' | 'executors' | 'machines' | 'clock' | 'stopping'>, log: (line: string) => void = (l) => console.warn(l)): Sweep {
  const last = new Map<string, number>();
  /** Each machine's last measure (issue #1120), and the machines told over the disk budget. */
  const measured = new Map<string, { paths: HopperDiskPath[]; at: string }>();
  const told = new Set<string>();
  /** The jobs, by `<machine>/<job id>`, whose dirs the reap could not remove, told once (issue #1452), with when to try again (issue #1613). */
  const stuck = new Map<string, number>();
  let busy = false;
  /** Each discard's removal under way or failed, by job (issue #1194), and the reaps running. */
  const discards = new Map<string, Discarding>();
  const removing = new Set<Promise<void>>();
  const budgetNow = (): DiskBudget | undefined => c.store.settings.getDiskBudget();

  /** The machine as the first executor there that reaches it does. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };
  /** The leftovers the sweep does not judge (issue #1116), listed after each pass's reaps. */
  const leftovers = createLeftovers(c, shellOf, log);

  /** Work kept and not removed since: the newest work event of each job. */
  const keptNow = (): KeptWork[] => keptWorkOf(c.store.events.recent(KEPT_EVENTS, [...WORK_EVENTS]));

  /** Why the job's kept work waits on nobody (issue #1187): its item done, a newer job of it, or no work to push. */
  const discardReason = (job: Job | undefined, kept: ReadonlySet<string>): WorkDiscardReason | undefined => {
    if (!job) return undefined;
    const key = job.source?.key;
    return discardReasonOf(job, key !== undefined && c.store.workItems.get(key)?.state === 'done', key === undefined ? undefined : c.store.jobs.getBySourceKey(key), kept);
  };

  /** What a reap removed of the job's containers and volumes (issue #1120), recorded. */
  function recordRemoved(jobId: string, m: MachineSnapshot, said: Reaped): void {
    if (!said.removed) return;
    const { containers, volumes } = said.removed;
    log(`hopper: removed ${count(containers.length, 'container')} and ${count(volumes.length, 'volume')} of job ${jobId} on ${m.id}`);
    c.store.events.append({ type: 'job.containers_removed', jobId, machineId: m.id, data: said.removed });
  }

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
    const running = new Set([...found.scopes, ...found.processes]);
    const removed = await reapPlan(m, shell, planSweep(found, jobOf, kept, pressed?.over ? 0 : maxAgeMs(m)), jobOf, kept, running);
    if (c.stopping()) return;
    // What the reaps freed, measured again; a survey that fails then keeps the first measure.
    const after = pressed?.over && removed > 0 ? await shell.survey(roots).catch(() => found) : found;
    measure(m, after, budget);
    if (c.stopping()) return;
    await leftovers.list(m, shell, found.roots ?? [], jobOf);
  }

  /** The reaps of one pass on the machine; how many scratch dirs they removed. */
  async function reapPlan(m: MachineSnapshot, shell: MachineShell, plan: SweepReap[], jobOf: (id: string) => Job | undefined, kept: ReadonlySet<string>, running: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const r of plan) {
      if (c.stopping()) return removed;
      const where = `${m.id}/${r.jobId}`;
      // A dir the reap could not remove is tried again only after a wait (issue #1613), unless something of the job still runs.
      if ((stuck.get(where) ?? 0) > c.clock.now().getTime() && !running.has(r.jobId)) continue;
      const reason = r.scratch !== undefined && kept.has(r.jobId) ? discardReason(jobOf(r.jobId), kept) : undefined;
      const discard = reason !== undefined;
      let said;
      try {
        said = discard ? await shell.reap(r.jobId, r.scratch, false, true) : await shell.reap(r.jobId, r.scratch);
      } catch (e) {
        log(`hopper: the sweep could not reap job ${r.jobId} on ${m.id}: ${(e as Error).message}`);
        continue;
      }
      recordRemoved(r.jobId, m, said);
      // A dir the reap could not remove is still there (issue #1452): never said removed, and told once while it stays.
      if (said.left?.length) {
        if (!stuck.has(where)) log(`hopper: the sweep could not remove job ${r.jobId}'s scratch dir on ${m.id}: ${said.left.join(', ')} is still there`);
        stuck.set(where, c.clock.now().getTime() + STUCK_RETRY_MS);
        continue;
      }
      stuck.delete(where);
      if (r.scratch && said.kept.length === 0) removed += 1;
      if (discard && said.kept.length === 0) {
        log(`hopper: the sweep discarded job ${r.jobId}'s kept work on ${m.id}: ${WHY[reason]}`);
        c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch!], discarded: true, reason } });
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
    leftovers: (machineId) => leftovers.view(machineId),
    decideLeftover: (machineId, path, decision, by) => leftovers.decide(machineId, path, decision, by),
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
      if (discards.get(jobId)?.state === 'removing') return { jobId, paths: [scratch] };
      // The reap is a round trip to the machine that removes git worktrees: it runs after the answer (issue #1194).
      discards.set(jobId, { state: 'removing' });
      const failed = (why: string) => {
        discards.set(jobId, { state: 'failed', error: why });
        log(`hopper: job ${jobId}'s kept work was not discarded on ${m.id}: ${why}`);
        c.store.events.append({ type: 'job.work_discard_failed', jobId, data: { error: why, ...by } });
      };
      const removal = (async () => {
        let said;
        try {
          said = await shell.reap(jobId, scratch, false, true);
        } catch (e) {
          failed((e as Error).message);
          return;
        }
        recordRemoved(jobId, m, said);
        if (said.kept.length > 0) { failed(`the machine ${m.id} kept it: update its client, then discard it again`); return; }
        if (said.left?.length) { failed(`the machine ${m.id} could not remove ${said.left.join(', ')}`); return; }
        discards.delete(jobId);
        log(`hopper: job ${jobId}'s kept work was discarded on ${m.id}, its scratch dir removed`);
        c.store.events.append({ type: 'job.work_removed', jobId, data: { paths: [scratch], discarded: true, ...by } });
      })().catch((e: unknown) => { log(`hopper: job ${jobId}'s discard on ${m.id} could not be recorded: ${(e as Error).message}`); });
      removing.add(removal);
      void removal.finally(() => removing.delete(removal));
      return { jobId, paths: [scratch] };
    },
    discarding: (jobId) => discards.get(jobId),
    async removals() { await Promise.allSettled([...removing]); },
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
