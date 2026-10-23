// The hopper's own disk use's events (issue #1120, design.md "Hopper's own disk use"): the hopper's own disk use on a
// machine is still over the disk budget after the sweep reaped what it could, or is back within it (part 2); a job's reap
// removed the containers and volumes labelled with its id (part 3); the sweep removed an ended job's pod (issue #1570); a
// person kept or removed a leftover (issue #1116); a machine's disk turned low or critical, or is no longer low (issue #2494); what a job's scope used, read by its reap (issue #2498); a job's cleanup left something after the grace period (issue #2504). Part of EVENT_SCHEMAS (schemas.ts), with their docs
// (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';
import { LEDGER_KINDS } from '../domain/resource-ledger.ts';

const use = { machineId: z.string(), usedBytes: z.number(), budgetBytes: z.number() };
/** A machine's disk as read (issue #2494). */
const reading = { machineId: z.string(), label: z.string(), freeBytes: z.number(), totalBytes: z.number() };
/** A leftover (issue #1116): its machine and path, and who decided, and the way. */
const leftover = { machineId: z.string(), path: z.string(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() };

export const MACHINE_DISK_EVENT_SCHEMAS = {
  'machine.disk_over_budget': z.strictObject({ ...use, paths: z.array(z.strictObject({ path: z.string(), bytes: z.number() })) }),
  'machine.disk_within_budget': z.strictObject(use),
  'machine.disk_low': z.strictObject({ ...reading, critical: z.boolean() }),
  'machine.disk_ok': z.strictObject(reading),
  'job.containers_removed': z.strictObject({
    containers: z.array(z.string()), volumes: z.array(z.string()),
    details: z.array(z.strictObject({ id: z.string(), name: z.string(), image: z.string(), startedAt: z.string().optional(), stoppedAt: z.string().optional() })).optional(),
  }),
  'job.pod_removed': z.strictObject({ executor: z.string() }),
  'job.resources_used': z.strictObject({ memoryPeakBytes: z.number().optional(), cpuSeconds: z.number().optional(), oomKills: z.number().optional() }),
  'job.cleanup_leftover': z.strictObject({
    endedAt: z.string(), graceMinutes: z.number(),
    entries: z.array(z.strictObject({ machineId: z.string(), kind: z.enum(LEDGER_KINDS), locator: z.string(), state: z.enum(['live', 'failed']), reason: z.string().optional() })),
  }),
  'machine.leftover_kept': z.strictObject(leftover),
  'machine.leftover_removed': z.strictObject({ ...leftover, unpushed: z.boolean(), bytes: z.number().optional(), gone: z.literal(true).optional() }),
} as const;

/** Their part of the event reference (docs.ts). */
export const MACHINE_DISK_EVENT_DOCS = {
  'machine.disk_over_budget': 'The hopper\'s own disk use on a machine (`usedBytes`: each work tree\'s `.worktrees`, its job worktrees and scratch dirs, and the repository checkouts in its workspace, `paths` each) is over the disk budget (`budgetBytes`), after the sweep reaped every ended job\'s scratch dir it could, whatever its age (issue #1120). What is left is work not pushed, live jobs\' work, the repository checkouts (the sweep never removes one), or more than the budget allows. Once while it stays over.',
  'machine.disk_within_budget': 'A machine told over by `machine.disk_over_budget` has the hopper\'s own disk use back within the disk budget (issue #1120): `usedBytes` of `budgetBytes` now.',
  'machine.disk_low': 'A machine\'s disk (the filesystem its home is on) turned low by its thresholds (issue #2494, `diskLowBelowGiB` / `diskLowBelowPercent`, default 5 GiB / 10%): `freeBytes` of `totalBytes` free. It takes no new job, and the sweep reaps every ended job\'s scratch dir there at once, whatever its age. `critical`: below its critical thresholds (`diskCriticalBelowGiB` / `diskCriticalBelowPercent`, default 1 GiB / 2%), where it takes no job at all, a job back to its pane included. Once when it turns low, and once more when it turns critical; after a restart of the hopper, not again. `label` is its name on the Machines view. Webhooks and notifiers take it.',
  'machine.disk_ok': 'A machine told by `machine.disk_low` has its disk no longer low (issue #2494): `freeBytes` of `totalBytes` free now. It takes jobs again.',
  'job.containers_removed': 'The job\'s reap (issue #1120), at its end or in a later sweep, removed the containers and volumes on its machine labelled with its id (`hopper.job=<job id>`): `containers`, each with its anonymous volumes, and `volumes`, by name. The sweep reaps an ended job that still has one, whatever its age. A timed-out job\'s reap removes none: it may go on there. `details` (issue #975): what the reap said of each container before it removed it — its `name`, `image`, and when it started (`startedAt`) and stopped (`stoppedAt`), each absent when it never did —, which the job\'s parts list shows; absent from a client older than this.',
  'job.pod_removed': 'The sweep (issue #1570), at startup and then every 10 minutes, deleted the job\'s pod and removed its machine: the job ended, no cleanup was still owed, and its pod was still there with this hopper\'s instance label (a delete that failed, or a hopper older than the cleanup record). `executor` is the executor that started it.',
  'job.resources_used': 'What the job\'s scope used on its machine (`machineId`), read by the job\'s reap at its end from the scope\'s cgroup before it stopped the scope (issue #2498): `memoryPeakBytes`, the most memory the scope held at once (cgroup `memory.peak`); `cpuSeconds`, the CPU time of every process in it (`cpu.stat` `usage_usec`); `oomKills`, the processes in it the kernel killed for want of memory (`memory.events` `oom_kill`). Each is absent where the cgroup has none (`memory.peak` needs Linux 5.19). None where the job has no scope there: no systemd user manager, or its scope ended before the reap (a parked job\'s, a print-mode agent\'s after its turn), or a client older than this. The job\'s parts list shows it.',
  'job.cleanup_leftover': 'The job ended at `endedAt`, and more than `graceMinutes` later its resource ledger still holds `entries` (issue #2504, design.md "The resource ledger"): each thing the hopper made for it — on `machineId`, its `kind` and `locator` — that no reap removed (`state` `live`: no reap reached it; `failed`: a reap could not remove it, `reason` says why). The sweep\'s leftover check records it once per job; Failures lists the job as stuck work (`cleanup_leftover`) while an entry stays.',
  'machine.leftover_kept': 'A person keeps a leftover on Machines (issue #1116): a dir in a work tree\'s `.hopper-scratch` (the layout before issue #1188) whose job the hopper does not know, or a repository mirror there, at `path` on `machineId`. Nothing is removed; the listing shows it kept. `person` and `via` say who and the way.',
  'machine.leftover_removed': 'A person removes a leftover on Machines (issue #1116): the dir at `path` on `machineId` is removed whatever it holds. `unpushed`: it held work not pushed, which is lost; `bytes`: its size when listed. `gone`: it was no longer there. `person` and `via` say who and the way.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DISK_EVENT_EXAMPLES = {
  'machine.disk_over_budget': { machineId: 'desk', usedBytes: 62_000_000_000, budgetBytes: 50_000_000_000, paths: [{ path: '/home/me/work/.worktrees', bytes: 50_000_000_000 }, { path: '/home/me/jobs/.worktrees', bytes: 12_000_000_000 }] },
  'machine.disk_within_budget': { machineId: 'desk', usedBytes: 41_000_000_000, budgetBytes: 50_000_000_000 },
  'machine.disk_low': { machineId: 'seat-l1', label: 'seat l1', freeBytes: 4_000_000_000, totalBytes: 250_000_000_000, critical: false },
  'machine.disk_ok': { machineId: 'seat-l1', label: 'seat l1', freeBytes: 40_000_000_000, totalBytes: 250_000_000_000 },
  'job.containers_removed': { containers: ['3f2a9c1b7d4e'], volumes: ['hopper-test-db'], details: [{ id: '3f2a9c1b7d4e', name: 'hopper-test-db', image: 'docker.io/library/postgres:16', startedAt: '2026-10-08T00:02:00.000Z', stoppedAt: '2026-10-08T00:09:00.000Z' }] },
  'job.pod_removed': { executor: 'kubernetes' },
  'job.resources_used': { memoryPeakBytes: 3_221_225_472, cpuSeconds: 754.5, oomKills: 1 },
  'job.cleanup_leftover': { endedAt: '2026-10-22T09:00:00.000Z', graceMinutes: 60, entries: [{ machineId: 'desk', kind: 'scratch_dir', locator: '/home/me/work/.worktrees/@scratch/f3b1c2d4', state: 'failed', reason: '/home/me/work/.worktrees/@scratch/f3b1c2d4/containers is still there' }] },
  'machine.leftover_kept': { machineId: 'desk', path: '/home/me/work/.hopper-scratch/test-job', person: 'Pat', via: 'ui' },
  'machine.leftover_removed': { machineId: 'desk', path: '/home/me/work/.hopper-scratch/repos/acme/app.git', unpushed: false, bytes: 1_200_000_000, person: 'Pat', via: 'ui' },
} as const;
