// The sweep (issue #410, design.md "Work tree" → "The sweep"): the reap runs when a job's pane closes, so a
// hopper that crashed, a pane lost, a machine that rebooted or could not be reached left nothing to run it.
// At startup, after recovery, and then on each machine every `sweep.everyMinutes` (a machine option, default
// 10), the sweep asks the machine what jobs left there — through an executor that reaches it — and reaps:
// - a scope or a process of a job this hopper knows that is not live (claimed, running, waiting on an
//   answer, or led by an operator): stopped;
// - an ended job's scratch dir, once it is `sweep.scratchMaxAgeHours` old (default 24) — or, with a retention set for the
//   status it ended in (`sweep.retainHours`, issue #2494), that many hours after its end —, or at once while its
//   work was kept (job.work_kept): removed unless it still holds work not pushed. Its job worktree in the work tree's
//   `.worktrees` (issue #1188) goes or stays with it, and one whose scratch dir is gone is reaped by that dir all the same. Work kept that the sweep
//   then removes is recorded as job.work_removed; work it keeps for the first time, as job.work_kept.
// A job id the hopper does not know is never touched: it may be another hopper's, or a test's.
// Work kept is logged once, when first kept; the next passes keep it quietly (issue #1010). A person may discard it
// (issue #1010, design.md "Work not pushed"): its scratch dir is reaped on its machine whatever it holds. The discard is a
// record on the job (`Job.discard`, issue #1570) until its removal ends: one a stop cut short is done again by the next
// sweep of its machine, before its reaps. Kept work of a
// job whose work item is done, as the work-item ledger has it, waits on nobody: the sweep discards it so (issue #1105),
// recorded as job.work_removed, discarded, with no person and the reason `merged`. So does kept work a newer job of its
// item took over, once that job finished with nothing kept (`superseded`), and kept work of a job that finished a proposal
// or a research report (`proposal`, `research`): it never had work to push (issue #1187). So does work whose every commit
// the reap names (a clean checkout's) the hopper pushed for the job (`pushed`, issue #2087). Kept work whose scratch dir and job worktree are gone from a
// work tree the survey found on the job's machine (removed by hand, or by a cleanup outside the hopper) is resolved so
// (issue #1120): job.work_removed with gone, nothing removed. Should it come back, the sweep finds it and keeps it again.
// The survey also measures the hopper's own disk use in each work tree (issue #1120, design.md "Hopper's own disk use"): the
// sweep keeps each machine's last measure, which Machines shows. Over the user's disk budget, it reaps every ended job's
// scratch dir at once, whatever its age (work not pushed is still kept), and measures again; still over, a person is told
// once (machine.disk_over_budget), and once more when it is back within it (machine.disk_within_budget). The last measure
// is kept in the store too (issue #2494), so a restart still shows it, and what the event log last told of each machine
// stands: a machine still over is not told again.
// A machine whose disk is low (issue #2490, design.md "A machine's disk") takes no new job; the sweep frees what it may there:
// it sweeps the machine at once when its disk turns low (then by its interval), and reaps every ended job's scratch dir
// whatever its age, as over the budget.
// An ended job with a container or a volume labelled with its id still on the machine (issue #1120) is reaped at once,
// whatever its age: the reap removes them. What any reap removed of them is recorded as job.containers_removed.
// Job pods (issue #1570): at startup, then every `SWEEP_EVERY_MINUTES`, each executor that starts work outside any machine
// (`Executor.sweep`: the kubernetes executor's job pods) removes what it started for a job of this hopper that ended and
// whose cleanup no record still owes: job.pod_removed. A job this hopper does not know is never touched.
// Leftovers (issue #1116, design.md "Leftovers a person decides"): after its reaps, each pass lists what the layout before
// issue #1188 left in the `.hopper-scratch` of each work tree the survey found, with size, age and whether it holds work not
// pushed, and keeps, in memory, the leftovers it does not judge — a dir of no job the hopper knows, and the repository mirrors.
// Machines shows them; a person keeps or removes each one (`decideLeftover`). The sweep removes none by itself.
// The storage prune (issue #2494, sweep-prune.ts): last, on a machine with `sweep.pruneAfterDays`, once a day.
// The cache caps (issue #2494, sweep-caches.ts): then, on a machine with `sweep.cacheCapsGiB`, while no job is there.
// The trim (issue #2494, sweep-trim.ts): then, on a machine with `sweep.trimAboveGiB`, fstrim once the cleanups freed that much.
// The dry run (issue #2494, sweep-dry-run.ts): on a machine with `sweep.dryRun`, a pass reaps, prunes, clears and trims
// nothing, and records what it would remove. A machine's `sweep.budgetGiB` is its disk budget, in place of the user's.
// The pass's record (issue #2494, sweep-pass.ts): each real pass that removed, newly kept or trimmed records machine.sweep_passed.
import type { ActingPerson, Discarding, DiskBudget, DiskMeasure, HopperDisk, Job, KeptWork, MachineLeftovers, MachineSnapshot, SweepSettings } from '../domain/types.ts';
import type { MachineShell, Reaped, Survey } from '../domain/ports.ts';
import { BUDGET_EVENTS, discardingOf, discardReasonOf, hopperDiskOf, jobDiskOf, overBudgetTold, keptData, keptPushedOf, keptScratchOf, keptWorkOf, machineRanOn, PROXY_PUSH_EVENTS, PUSHES_READ, proxyPushedOf, TERMINAL_STATUSES, WORK_EVENTS, type WorkDiscardReason } from '../domain/types.ts';
import { jobScratchOf, scratchParts, worktreeJobOf as treeJob, worktreeParts } from '../domain/job-layout.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { createLeftovers } from './sweep-leftovers.ts'; import { closeLedger, reconcileLedger, sweptRoots } from './resource-ledger.ts'; import { createPrune } from './sweep-prune.ts'; import { createTrim, freedBetween } from './sweep-trim.ts'; import { createCaches } from './sweep-caches.ts'; import { createDryRun } from './sweep-dry-run.ts'; import { passTally, type PassTally } from './sweep-pass.ts'; import { budgetOf } from '../domain/sweep-dry-run.ts';
import { createSweepDue, SWEEP_EVERY_MINUTES } from './sweep-due.ts';
import { retentionOver } from '../domain/retention.ts';
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
 * Pure: what to reap on one machine, from what its survey found. `kept`: jobs whose work was kept and not removed since.
 * `over`: whether an ended job's work, its dir that old, is past its retention (issue #2494).
 */
export function planSweep(found: Survey, jobOf: (id: string) => Job | undefined, kept: ReadonlySet<string>, over: (job: Job, ageMs: number) => boolean): SweepReap[] {
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
    if (over(job, dir.ageMs) || kept.has(dir.jobId)) plan.set(dir.jobId, { jobId: dir.jobId, scratch: dir.path });
  }
  for (const tree of found.trees ?? []) {
    const job = treeJob(tree.path, jobOf);
    if (!job || !TERMINAL_STATUSES.includes(job.status) || plan.get(job.id)?.scratch) continue;
    const root = worktreeParts(tree.path)!.workTree;
    if (over(job, tree.ageMs) || kept.has(job.id)) plan.set(job.id, { jobId: job.id, scratch: jobScratchOf(root, job.id) });
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
  /** The hopper's own disk use on the machine as the sweep last measured it, against the disk budget now (issue #1120) — its own with `sweep.budgetGiB` (issue #2494) —; undefined: never measured. */
  disk(machineId: string, sweep?: SweepSettings): HopperDisk | undefined;
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
  merged: 'its item is done', superseded: 'a newer job of its item finished', proposal: 'it finished a proposal', research: 'it finished a research report', pushed: 'the hopper pushed its work',
};

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

export function createSweep(c: Pick<EngineContext, 'store' | 'executors' | 'machines' | 'clock' | 'stopping'>, log: (line: string) => void = (l) => console.warn(l)): Sweep {
  const schedule = createSweepDue();
  /** Each machine's last measure (issue #1120), read from the store once (issue #2494), and the machines told over the disk budget. */
  let kept: Map<string, DiskMeasure> | undefined, toldOver: Set<string> | undefined;
  const measured = (): Map<string, DiskMeasure> => (kept ??= new Map(c.store.diskMeasures.all())), told = (): Set<string> => (toldOver ??= overBudgetTold(c.store.events.recent(KEPT_EVENTS, [...BUDGET_EVENTS])));
  /** The jobs, by `<machine>/<job id>`, whose dirs the reap could not remove, told once (issue #1452), with when to try again (issue #1613). */
  const stuck = new Map<string, number>();
  let busy = false;
  let podsAt = -Infinity;
  /** The discards whose removal runs in this process now (issue #1194), by job, and those removals. */
  const removingNow = new Set<string>();
  const removing = new Set<Promise<boolean>>();
  const budgetNow = (s: SweepSettings | undefined): DiskBudget | undefined => budgetOf(s, c.store.settings.getDiskBudget());

  /** The machine as the first executor there that reaches it does. */
  const shellOf = (m: MachineSnapshot): MachineShell | undefined => {
    for (const name of m.executors) {
      const shell = c.executors.get(name)?.machineShell?.(m);
      if (shell) return shell;
    }
    return undefined;
  };
  /** The leftovers the sweep does not judge (issue #1116), listed after each pass's reaps. */
  const leftovers = createLeftovers(c, shellOf, log); const prune = createPrune(c, log), trim = createTrim(c, log), caches = createCaches(c, log), dryRun = createDryRun(c, log);

  /** The commits the hopper pushed for the job (issue #2087). */
  const pushedFor = (jobId: string): Set<string> => proxyPushedOf(c.store.events.recent(PUSHES_READ, [...PROXY_PUSH_EVENTS], jobId));
  /** Work kept and not removed since: the newest work event of each job. */
  const keptNow = (): KeptWork[] => keptWorkOf(c.store.events.recent(KEPT_EVENTS, [...WORK_EVENTS]));

  /** Why the job's kept work waits on nobody (issue #1187): its item done, a newer job of it, or no work to push. */
  const discardReason = (job: Job | undefined, kept: ReadonlySet<string>): WorkDiscardReason | undefined => {
    if (!job) return undefined;
    const key = job.source?.key;
    return discardReasonOf(job, key !== undefined && c.store.workItems.get(key)?.state === 'done', key === undefined ? undefined : c.store.jobs.getBySourceKey(key), kept);
  };

  /** What a reap removed of the job's containers and volumes (issue #1120), recorded; `scratch` false: it did not look at the scratch dir. */
  function recordRemoved(jobId: string, m: MachineSnapshot, said: Reaped, scratch = true): void {
    // Its resource ledger (issue #2504) closed as the reap said.
    closeLedger(c.store, jobId, said, c.clock.now().toISOString(), scratch); if (!said.removed) return;
    const { containers, volumes } = said.removed;
    log(`hopper: removed ${count(containers.length, 'container')} and ${count(volumes.length, 'volume')} of job ${jobId} on ${m.id}`);
    c.store.events.append({ type: 'job.containers_removed', jobId, machineId: m.id, data: said.removed });
  }

  /** The machine's measure kept, and a person told when it goes over the budget or back within it. */
  function measure(m: MachineSnapshot, found: Survey, budget: DiskBudget | undefined): void {
    const at = c.clock.now().toISOString();
    const more = { caches: found.caches, storage: found.storage, jobs: jobDiskOf(found.jobs ?? []) }, disk = hopperDiskOf(found.usage, at, budget, more);
    if (!disk) return; const last: DiskMeasure = { at, paths: disk.paths, ...(found.caches?.length ? { caches: found.caches } : {}), ...(found.storage?.length ? { storage: found.storage } : {}), ...(disk.jobs ? { jobs: disk.jobs } : {}) };
    measured().set(m.id, last); c.store.diskMeasures.keep(m.id, last);
    if (!budget) { told().delete(m.id); return; }
    if (disk.over && !told().has(m.id)) {
      told().add(m.id);
      log(`hopper: the hopper's own disk use on ${m.id} is ${gb(disk.bytes)}, still over its disk budget of ${gb(budget.bytes)}`);
      c.store.events.append({ type: 'machine.disk_over_budget', machineId: m.id, data: { machineId: m.id, usedBytes: disk.bytes, budgetBytes: budget.bytes, paths: disk.paths } });
    } else if (!disk.over && told().delete(m.id)) {
      c.store.events.append({ type: 'machine.disk_within_budget', machineId: m.id, data: { machineId: m.id, usedBytes: disk.bytes, budgetBytes: budget.bytes } });
    }
  }

  /**
   * The removal its discard record asks for on the job's machine (issue #1570), unless one runs now: then
   * `job.work_removed` and the record gone, or `job.work_discard_failed` and the record with why. A stop keeps the record
   * as it is. Whether it removed the work.
   */
  async function removeDiscard(jobId: string, m: MachineSnapshot, shell: MachineShell): Promise<boolean> {
    const d = c.store.jobs.get(jobId)?.discard;
    if (!d || d.error !== undefined || removingNow.has(jobId)) return false;
    removingNow.add(jobId);
    const failed = (why: string): false => {
      if (c.stopping()) return false;
      log(`hopper: job ${jobId}'s kept work was not discarded on ${m.id}: ${why}`);
      c.store.tx(() => {
        c.store.jobs.update(jobId, { discard: { ...d, error: why } });
        c.store.events.append({ type: 'job.work_discard_failed', jobId, data: { error: why, ...d.by } });
      });
      return false;
    };
    try {
      let said;
      try { said = await shell.reap(jobId, d.scratch, false, true); } catch (e) { return failed((e as Error).message); }
      if (c.stopping()) return false;
      recordRemoved(jobId, m, said);
      if (said.kept.length > 0) return failed(`the machine ${m.id} kept it: update its client, then discard it again`);
      if (said.left?.length) return failed(`the machine ${m.id} could not remove ${said.left.join(', ')}`);
      log(`hopper: job ${jobId}'s kept work was discarded on ${m.id}, its scratch dir removed`);
      c.store.tx(() => {
        c.store.jobs.update(jobId, { discard: undefined });
        c.store.events.append({ type: 'job.work_removed', jobId, data: { paths: [d.scratch], discarded: true, ...d.by } });
      });
      return true;
    } finally { removingNow.delete(jobId); }
  }

  /** `discards`: the jobs whose discard record is under way (issue #1570), done first on their machine. */
  async function sweepOne(m: MachineSnapshot, shell: MachineShell, roots: string[], jobOf: (id: string) => Job | undefined, keptWork: KeptWork[], discards: readonly Job[]): Promise<void> {
    const discarded = new Set<string>();
    for (const job of discards) {
      if (c.stopping()) return;
      if (machineRanOn(job) === m.id && await removeDiscard(job.id, m, shell)) discarded.add(job.id);
    }
    const kept = new Set(keptWork.filter((k) => !discarded.has(k.jobId)).map((k) => k.jobId));
    // The resource ledger reconciled (issue #2504 parts 3, 6): entries whose thing is gone closed, also kept work's; what it does not name recorded.
    const found = await shell.survey(roots), at = c.clock.now().toISOString(); reconcileLedger(c.store, m, found, jobOf, at);
    for (const g of goneKept(found, keptWork.filter((k) => kept.has(k.jobId)), jobOf, m.id)) {
      if (c.stopping()) return;
      log(`hopper: job ${g.jobId}'s kept work is gone from ${m.id}: its scratch dir ${g.scratch} is no longer there`);
      c.store.events.append({ type: 'job.work_removed', jobId: g.jobId, data: { paths: [g.scratch], gone: true } }); closeLedger(c.store, g.jobId, { kept: [] }, at);
    }
    const budget = budgetNow(m.sweep);
    const pressed = hopperDiskOf(found.usage, '', budget);
    if (m.disk?.low) log(`hopper: disk low on ${m.id} (${gb(m.disk!.freeBytes)} free): the sweep reaps every ended job's scratch dir now, whatever its age`);
    else if (pressed?.over) log(`hopper: the hopper's own disk use on ${m.id} is ${gb(pressed.bytes)}, over its disk budget of ${gb(budget!.bytes)}: the sweep reaps every ended job's scratch dir now, whatever its age`);
    const running = new Set([...found.scopes, ...found.processes]);
    const now = c.clock.now().getTime(), over = (job: Job, ageMs: number): boolean => m.disk?.low === true || pressed?.over === true || retentionOver(m.sweep, job, ageMs, now);
    const plan = planSweep(found, jobOf, kept, over), dry = m.sweep?.dryRun === true; if (dry) dryRun.pass(m, found, plan, kept);
    const tally = passTally(c, m, found), removed = dry ? 0 : await reapPlan(m, shell, plan, jobOf, kept, running, tally);
    if (c.stopping()) return;
    // What the reaps freed, measured again (for the budget, or the trim); a survey that fails then keeps the first measure.
    const after = (pressed?.over || m.sweep?.trimAboveGiB) && removed > 0 ? await shell.survey(roots).catch(() => found) : found;
    measure(m, after, budget);
    if (c.stopping()) return;
    await leftovers.list(m, shell, found.roots ?? [], jobOf); if (c.stopping() || dry) return;
    const pruned = await prune.pass(m, shell, found), cleared = await caches.pass(m, shell, found); tally.add('storage', pruned); tally.add('caches', cleared);
    tally.trimmed(await trim.pass(m, shell, freedBetween(found, after) + pruned.bytes + cleared.bytes)); tally.record();
  }

  /** The reaps of one pass on the machine, each told to the pass's `tally`; how many scratch dirs they removed. */
  async function reapPlan(m: MachineSnapshot, shell: MachineShell, plan: SweepReap[], jobOf: (id: string) => Job | undefined, kept: ReadonlySet<string>, running: ReadonlySet<string>, tally: PassTally): Promise<number> {
    let removed = 0;
    for (const r of plan) {
      if (c.stopping()) return removed;
      const where = `${m.id}/${r.jobId}`;
      // A dir the reap could not remove is tried again only after a wait (issue #1613), unless something of the job still runs.
      if ((stuck.get(where) ?? 0) > c.clock.now().getTime() && !running.has(r.jobId)) continue;
      let reason = r.scratch !== undefined && kept.has(r.jobId) ? discardReason(jobOf(r.jobId), kept) : undefined;
      let said;
      try {
        said = reason !== undefined ? await shell.reap(r.jobId, r.scratch, false, true) : await shell.reap(r.jobId, r.scratch);
        // Work the hopper pushed for the job (issue #2087), whatever its remote branches say: removed as a discard is.
        if (reason === undefined && r.scratch && said.kept.length > 0 && keptPushedOf(said, pushedFor(r.jobId)).length === said.kept.length) {
          reason = 'pushed'; said = await shell.reap(r.jobId, r.scratch, false, true);
        }
      } catch (e) {
        log(`hopper: the sweep could not reap job ${r.jobId} on ${m.id}: ${(e as Error).message}`);
        continue;
      }
      recordRemoved(r.jobId, m, said, r.scratch !== undefined); tally.reaped(r.jobId, r.scratch !== undefined, said, said.left?.length ? stuck.has(where) : kept.has(r.jobId));
      // A dir the reap could not remove is still there (issue #1452): never said removed, and told once while it stays.
      if (said.left?.length) {
        if (!stuck.has(where)) log(`hopper: the sweep could not remove job ${r.jobId}'s scratch dir on ${m.id}: ${said.left.join(', ')} is still there`);
        stuck.set(where, c.clock.now().getTime() + STUCK_RETRY_MS);
        continue;
      }
      stuck.delete(where);
      if (r.scratch && said.kept.length === 0) removed += 1;
      if (reason !== undefined && said.kept.length === 0) {
        // Never kept before (issue #2087: the cleanup at its end saw it pushed): nothing to say.
        if (!kept.has(r.jobId)) continue;
        log(`hopper: the sweep discarded job ${r.jobId}'s kept work on ${m.id}: ${WHY[reason]}`);
        c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch!], discarded: true, reason } });
        continue;
      }
      // Kept again is no news: logged only the first time.
      const again = r.scratch !== undefined && said.kept.length > 0 && kept.has(r.jobId);
      if (!again) log(`hopper: the sweep reaped job ${r.jobId} on ${m.id}${r.scratch ? `, its scratch dir ${said.kept.length ? 'kept: it holds work not pushed' : 'removed'}` : ''}`);
      if (!r.scratch || c.stopping()) continue;
      if (said.kept.length > 0 && !kept.has(r.jobId)) c.store.events.append({ type: 'job.work_kept', jobId: r.jobId, data: keptData(said, said.kept) });
      if (said.kept.length === 0 && kept.has(r.jobId)) c.store.events.append({ type: 'job.work_removed', jobId: r.jobId, data: { paths: [r.scratch] } });
    }
    return removed;
  }

  /** Each executor's sweep of what it started outside any machine (issue #1570): job pods whose job ended. */
  async function sweepPods(): Promise<void> {
    const ended = (j: Job | undefined): boolean => j !== undefined && TERMINAL_STATUSES.includes(j.status) && !j.cleanupDue && !j.cleanupDeferred;
    for (const name of c.executors.names()) {
      const executor = c.executors.get(name);
      if (!executor?.sweep || c.stopping()) continue;
      try {
        for (const jobId of await executor.sweep((id) => ended(c.store.jobs.get(id)))) {
          log(`hopper: the sweep removed the pod of job ${jobId}, which ended (executor ${name})`);
          if (!c.stopping()) c.store.events.append({ type: 'job.pod_removed', jobId, data: { executor: name } });
        }
      } catch (e) {
        log(`hopper: the sweep could not sweep the pods of executor ${name}: ${(e as Error).message}`);
      }
    }
  }

  const refuse = (jobId: string, why: string): EngineError => new EngineError('conflict', `job ${jobId}'s work cannot be discarded: ${why}`);

  return {
    disk(machineId, sweep) {
      const m = measured().get(machineId);
      return m ? hopperDiskOf(m.paths, m.at, budgetNow(sweep), m) : undefined;
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
      if (job.discard && job.discard.error === undefined) return { jobId, paths: [job.discard.scratch] };
      // Recorded before the reap (issue #1570), a round trip to the machine that removes git worktrees, which runs after
      // the answer (issue #1194).
      c.store.jobs.update(jobId, { discard: { at: c.clock.now().toISOString(), scratch, by } });
      const removal = removeDiscard(jobId, m, shell).catch((e: unknown) => {
        log(`hopper: job ${jobId}'s discard on ${m.id} could not be recorded: ${(e as Error).message}`);
        return false;
      });
      removing.add(removal);
      void removal.finally(() => removing.delete(removal));
      return { jobId, paths: [scratch] };
    },
    discarding: (jobId) => discardingOf(c.store.jobs.get(jobId)),
    async removals() { await Promise.allSettled([...removing]); },
    async run(all = false) {
      if (busy || c.stopping()) return;
      busy = true;
      try {
        const now = c.clock.now().getTime();
        if (all || now - podsAt >= SWEEP_EVERY_MINUTES * 60_000) {
          podsAt = now;
          await sweepPods();
        }
        const due = schedule.due(await c.machines.list(), now, all);
        if (due.length === 0) return;
        const recent = c.store.jobs.list({ limit: JOBS_SWEPT });
        const byId = new Map(recent.map((j) => [j.id, j]));
        const jobOf = (id: string): Job | undefined => byId.get(id) ?? c.store.jobs.get(id);
        const roots = [...new Set(recent.map((j) => (j.executorState as { cwd?: unknown } | undefined)?.cwd).filter((p): p is string => typeof p === 'string' && p.startsWith('/')))].sort();
        const kept = keptNow();
        const discards = recent.filter((j) => j.discard && j.discard.error === undefined);
        for (const m of due) {
          if (c.stopping()) return;
          schedule.swept(m, now);
          const shell = shellOf(m);
          if (!shell) continue;
          await sweepOne(m, shell, sweptRoots(c.store, m.id, roots), jobOf, kept, discards).catch((e: unknown) => log(`hopper: the sweep could not survey ${m.id}: ${(e as Error).message}`));
        }
      } catch (e) {
        log(`hopper: the sweep failed: ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    },
  };
}
