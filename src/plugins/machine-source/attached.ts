// What the attached-machine plugins share (design.md "Attached machines", issue #74): `ssh`, `container`
// and `client` each make one attached machine of their instance, named after it. Its lanes, executors
// and label are plain options; how it is reached is command-bearing. The hopper
// reaches it through the machine-source context's `target`, never on its own.
import type { z as Z } from 'zod';
import type { AttachedMachine } from '../../domain/types.ts';
import type { DiskThresholds, EndStatus, SweepSettings } from '../../domain/machines.ts'; import type { MemoryFloor } from '../../domain/memory-floor.ts';
import type { UsageLimitPair } from '../../domain/usage.ts';
import type { MachineSource, MachineSourceContext } from '../sdk.ts';

/**
 * A machine's work tree (issues #324, #361): an absolute path or one under `~`, which resolves on that
 * machine. The hopper makes it there and puts each job's repository in it. Command-bearing: it is where
 * its jobs' commands run. Not on a container target, whose command jobs take no work tree.
 */
export const workTreeOption = (z: typeof Z) => z.string().min(1)
  .refine((s) => s.startsWith('/') || s === '~' || s.startsWith('~/'), 'workTree must be an absolute path or start with ~')
  .optional().meta({ commandBearing: true, description: 'where its jobs run, made by the hopper, each job\'s repository fetched or cloned in it; ~ is this machine\'s home. Absent: ~/hopper-jobs' });

/**
 * A work tree per repository (issue #691): a job from a repository named here works in its tree, made there and
 * the repository cloned in it when missing; a job from any other, in the machine's own work tree. Keys are
 * `owner/name`, matched in any case. Command-bearing, as the work tree is.
 */
export const workTreesOption = (z: typeof Z) => z.record(
  z.string(),
  z.string().min(1).refine((s) => s.startsWith('/') || s === '~' || s.startsWith('~/'), 'a workTrees path must be an absolute path or start with ~'),
).superRefine((trees, ctx) => {
  for (const key of Object.keys(trees)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(key)) ctx.addIssue({ code: 'custom', message: `a workTrees key must be a repository, owner/name: ${key} is not` });
  }
}).optional().meta({ commandBearing: true, description: 'a work tree per repository, as {"owner/name": "~/path"}: a job from that repository works there, made and cloned by the hopper; a job from any other works in workTree' });

/**
 * Lanes kept for jobs pinned to the machine (issue #372): jobs with no machine pin use at most its lane
 * cap less these. At or above its lanes, only jobs pinned to it run there.
 */
export const reservedLanesOption = (z: typeof Z) => z.number().int().min(0, 'reservedLanes must not be negative').optional()
  .meta({ description: 'lanes kept for jobs pinned to this machine; jobs that could run anywhere do not take them' });

/**
 * How many lanes specialty and tend jobs may elbow in past the machine's lane cap at once (issues #762, #967). Absent: 1; 0: none.
 */
export const elbowInsOption = (z: typeof Z) => z.number().int().min(0, 'elbowIns must not be negative').optional()
  .meta({ description: 'lanes a job labelled hopper:specialty, or a job that tends a pull request, may start past this machine\'s lane cap at once (default 1); 0: none' });

/**
 * The machine's own usage limits (issue #1860): from `soft` its lane cap is its soft lanes (issue #2091; absent: the user's),
 * and 0 at `hard`, whatever the user's usage limits are. Two machines on one account: give the secondary lower limits, or
 * 0 soft lanes, so its lanes give way first. Absent: the user's.
 */
export const usageLimitsOption = (z: typeof Z) => z.strictObject({
  soft: z.number().min(0).max(1),
  hard: z.number().min(0).max(1),
  softLanes: z.number().int().min(0).optional(),
}).refine((l) => l.soft < l.hard, 'usageLimits: soft must be below hard').optional()
  .meta({ description: 'this machine\'s own usage limits, as {"soft": 0.5, "hard": 0.7, "softLanes": 1} (fractions of the usage; softLanes optional, absent: the soft lanes set on Usage): from soft it keeps only the soft lanes, at hard it stops; absent: the usage limits set on Usage. Two machines on one account: give the one that gives way lower limits' });

/** The `usageLimits` field of a machine that has its own; nothing for one that does not. */
export const usageLimitsOf = (o: { usageLimits?: UsageLimitPair }): { usageLimits?: UsageLimitPair } =>
  (o.usageLimits ? { usageLimits: { soft: o.usageLimits.soft, hard: o.usageLimits.hard, ...(o.usageLimits.softLanes === undefined ? {} : { softLanes: o.usageLimits.softLanes }) } } : {});

/**
 * A Windows machine (issue #1350): the jobs labelled `hopper:win` or `hopper:windows` go only to one, and wait while none
 * can take them. Absent or false: not one.
 */
export const windowsOption = (z: typeof Z) => z.boolean().optional()
  .meta({ description: 'it runs Windows: a job labelled hopper:win or hopper:windows goes only to a Windows machine' });

/** The `windows` field of a machine that is a Windows machine; nothing for one that is not. */
export const windowsOf = (o: { windows?: boolean }): { windows?: true } => (o.windows === true ? { windows: true } : {});

/**
 * When a machine's disk is low (issue #410): below either threshold it takes no new job. Plain options,
 * read at every list, so a change applies at the next Decision. Not on a container target, whose disk is not read.
 */
export const diskLowShape = (z: typeof Z) => ({
  diskLowBelowGiB: z.number().positive().optional()
    .meta({ description: 'its disk is low below this many GiB free (default 5); a machine with a low disk takes no new job' }),
  diskLowBelowPercent: z.number().min(0).max(100).optional()
    .meta({ description: 'its disk is low below this share free, in percent (default 10); a machine with a low disk takes no new job' }),
  diskCriticalBelowGiB: z.number().positive().optional()
    .meta({ description: 'its disk is critical below this many GiB free (default 1); a machine with a critical disk takes no job at all, not even a job back to its pane' }),
  diskCriticalBelowPercent: z.number().min(0).max(100).optional()
    .meta({ description: 'its disk is critical below this share free, in percent (default 2); a machine with a critical disk takes no job at all, not even a job back to its pane' }),
});

/**
 * Its memory floor (issue #2291, design.md "The memory floor"): a new job, or a job back, starts there only while its memory
 * available, less what jobs started lately keep and what the new job needs, stays at or above the floor; below it, the job
 * that started there last is paused. Plain options, read at every list. Not on a container target, whose memory is not read.
 */
export const memoryFloorShape = (z: typeof Z) => ({
  memoryFloorGiB: z.number().min(0).optional()
    .meta({ description: 'its memory floor in GiB (default 10% of its memory, at least 1); below it no job starts there and the newest job is paused; 0 turns it off' }),
  memoryPerJobGiB: z.number().positive().optional()
    .meta({ description: 'the memory in GiB a new job there needs over the floor, kept for each job for its first 10 minutes (default 2)' }),
});

/** The memory floor the options set; undefined when neither is. */
export const memoryFloorOf = (o: { memoryFloorGiB?: number; memoryPerJobGiB?: number }): MemoryFloor | undefined =>
  (o.memoryFloorGiB === undefined && o.memoryPerJobGiB === undefined ? undefined : {
    ...(o.memoryFloorGiB !== undefined ? { floorGiB: o.memoryFloorGiB } : {}),
    ...(o.memoryPerJobGiB !== undefined ? { perJobGiB: o.memoryPerJobGiB } : {}),
  });

/** The disk options (issue #410, critical: issue #2494). */
export type DiskOptions = { diskLowBelowGiB?: number; diskLowBelowPercent?: number; diskCriticalBelowGiB?: number; diskCriticalBelowPercent?: number };

/** The thresholds the disk options set; undefined when none is. */
export function diskLowOf(o: DiskOptions): DiskThresholds | undefined {
  const t: DiskThresholds = {
    ...(o.diskLowBelowGiB !== undefined ? { belowGiB: o.diskLowBelowGiB } : {}),
    ...(o.diskLowBelowPercent !== undefined ? { belowPercent: o.diskLowBelowPercent } : {}),
    ...(o.diskCriticalBelowGiB !== undefined ? { criticalBelowGiB: o.diskCriticalBelowGiB } : {}),
    ...(o.diskCriticalBelowPercent !== undefined ? { criticalBelowPercent: o.diskCriticalBelowPercent } : {}),
  };
  return Object.keys(t).length > 0 ? t : undefined;
}

/** The retention option of each status a job ends in (issue #2494), by the status. */
const RETAIN_OPTIONS = { finished: 'retainFinishedHours', failed: 'retainFailedHours', cancelled: 'retainCancelledHours', rejected: 'retainRejectedHours' } as const;
type RetainOptions = { [K in (typeof RETAIN_OPTIONS)[EndStatus]]?: number };

/** The retention per job status (issue #2494): how long an ended job's work stays here, from its end. */
const retainOption = (z: typeof Z, status: EndStatus) => z.number().min(0).optional()
  .meta({ description: `a job that ended ${status}: the reap at its end keeps its scratch dir and worktrees, and the sweep removes them this many hours after its end (absent: removed at its end, else by the scratch age); work not pushed is never removed` });
const retainShape = (z: typeof Z) => ({
  retainFinishedHours: retainOption(z, 'finished'), retainFailedHours: retainOption(z, 'failed'),
  retainCancelledHours: retainOption(z, 'cancelled'), retainRejectedHours: retainOption(z, 'rejected'),
});

/**
 * How the sweep treats a machine (issue #410): how often it is swept for what ended jobs left, and how old an
 * ended job's scratch dir gets before the sweep reaps it. Plain options, read at every sweep. Not on a
 * container target, which runs no job that leaves any.
 */
export const sweepShape = (z: typeof Z) => ({
  reapEveryMinutes: z.number().int().min(1).optional()
    .meta({ description: 'the sweep: every this many minutes (default 10), what jobs that are no longer live left here is stopped, and their old scratch dirs removed' }),
  scratchMaxAgeHours: z.number().positive().optional()
    .meta({ description: 'the sweep removes an ended job\'s scratch dir here once it is this many hours old (default 24); work not pushed is never removed' }),
  ...retainShape(z),
});

/** The sweep settings the options set; undefined when none is. */
export const sweepOf = (o: { reapEveryMinutes?: number; scratchMaxAgeHours?: number } & RetainOptions): SweepSettings | undefined => {
  const retainHours: Partial<Record<EndStatus, number>> = {};
  for (const [status, key] of Object.entries(RETAIN_OPTIONS) as [EndStatus, keyof RetainOptions][]) if (o[key] !== undefined) retainHours[status] = o[key];
  const retains = Object.keys(retainHours).length > 0;
  return (o.reapEveryMinutes === undefined && o.scratchMaxAgeHours === undefined && !retains ? undefined : {
    ...(o.reapEveryMinutes !== undefined ? { everyMinutes: o.reapEveryMinutes } : {}),
    ...(o.scratchMaxAgeHours !== undefined ? { scratchMaxAgeHours: o.scratchMaxAgeHours } : {}),
    ...(retains ? { retainHours } : {}),
  });
};

/** The options every attached machine has; `executors` defaults to what its connection runs. */
export function attachedShape(z: typeof Z, executors: readonly string[]) {
  return {
    label: z.string().min(1).optional().meta({ description: 'shown instead of the name' }),
    // 0 rests it (issue #365): it stays a machine, online, and takes no job.
    lanes: z.number().int().min(0, 'lanes must not be negative').default(1).meta({ description: 'jobs it runs at once; 0 rests it' }),
    reservedLanes: reservedLanesOption(z),
    elbowIns: elbowInsOption(z),
    windows: windowsOption(z),
    usageLimits: usageLimitsOption(z),
    executors: z.array(z.string().min(1)).default([...executors]).meta({ description: 'executor instances that run there' }),
  };
}

export interface AttachedOptions {
  label?: string; lanes: number; reservedLanes?: number; elbowIns?: number; windows?: boolean; usageLimits?: UsageLimitPair; executors: string[]; workTree?: string; workTrees?: Record<string, string>; diskLowBelowGiB?: number; diskLowBelowPercent?: number; diskCriticalBelowGiB?: number; diskCriticalBelowPercent?: number;
  reapEveryMinutes?: number; scratchMaxAgeHours?: number; memoryFloorGiB?: number; memoryPerJobGiB?: number;
  retainFinishedHours?: number; retainFailedHours?: number; retainCancelledHours?: number; retainRejectedHours?: number;
}

/** The plain fields of an attached machine named `name`. */
export const attachedBase = (name: string, o: AttachedOptions) => {
  const diskLow = diskLowOf(o);
  const sweep = sweepOf(o); const memoryFloor = memoryFloorOf(o);
  return {
    name, ...(o.label !== undefined ? { label: o.label } : {}), lanes: o.lanes, ...(o.reservedLanes !== undefined ? { reservedLanes: o.reservedLanes } : {}),
    ...(o.elbowIns !== undefined ? { elbowIns: o.elbowIns } : {}), ...windowsOf(o), ...usageLimitsOf(o), executors: [...o.executors],
    ...(o.workTree !== undefined ? { workTree: o.workTree } : {}), ...(o.workTrees !== undefined ? { workTrees: { ...o.workTrees } } : {}), ...(diskLow ? { diskLow } : {}), ...(sweep ? { sweep } : {}),
    ...(memoryFloor ? { memoryFloor } : {}),
  };
};

/** An attached machine's source: the host reaches it. */
export const reach = (ctx: MachineSourceContext, machine: AttachedMachine): MachineSource => ctx.target(machine);
