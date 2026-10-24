// The hopper's own disk use's events (issue #1120, design.md "Hopper's own disk use"): the hopper's own disk use on a
// machine is still over the disk budget after the sweep reaped what it could, or is back within it (part 2); a job's reap
// removed the containers and volumes labelled with its id (part 3); the sweep removed an ended job's pod (issue #1570), or stopped the processes of a job not ended (issue #2707); a
// person kept or removed a leftover (issue #1116); a machine's disk turned low or critical, or is no longer low (issue #2494); the sweep pruned a machine's container storage, ran fstrim there, cleared its caches, said in dry run what it would remove, or recorded what one pass did (issue #2494); what a job's scope used, read by its reap (issue #2498); a job's cleanup left something after the grace period (issue #2504). Part of EVENT_SCHEMAS (schemas.ts), with their docs
// (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS, KEPT_REASONS } from '../domain/types.ts';
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
  'machine.storage_pruned': z.strictObject({
    machineId: z.string(), olderThanDays: z.number(), bytes: z.number(),
    removed: z.array(z.strictObject({ runtime: z.enum(['docker', 'podman']), kind: z.enum(['container', 'volume', 'image']), id: z.string(), bytes: z.number().optional() })),
  }),
  'machine.disk_trim_ran': z.strictObject({
    machineId: z.string(), freedBytes: z.number(), mount: z.string(), outcome: z.enum(['trimmed', 'refused', 'unsupported', 'failed']),
    trimmedBytes: z.number().optional(), said: z.string().optional(), hostCompaction: z.literal(true).optional(),
  }),
  'machine.caches_cleared': z.strictObject({
    machineId: z.string(), bytes: z.number(), low: z.literal(true).optional(),
    removed: z.array(z.strictObject({ kind: z.enum(['nuget', 'gradle', 'go', 'npm', 'pnpm', 'yarn', 'pip']), path: z.string(), bytes: z.number() })),
  }),
  'machine.sweep_dry_run': z.strictObject({
    machineId: z.string(),
    reaps: z.array(z.strictObject({ jobId: z.string(), scratch: z.string(), bytes: z.number().optional(), kept: z.literal(true).optional() })), reapBytes: z.number(), stops: z.array(z.string()),
    prune: z.strictObject({ olderThanDays: z.number(), containers: z.array(z.string()), reclaimableBytes: z.number() }).optional(),
    caches: z.array(z.strictObject({ kind: z.enum(['nuget', 'gradle', 'go', 'npm', 'pnpm', 'yarn', 'pip', 'cache']), path: z.string(), bytes: z.number() })).optional(), cacheBytes: z.number(),
    trim: z.strictObject({ aboveGiB: z.number(), due: z.boolean() }).optional(),
  }),
  'machine.sweep_passed': z.strictObject({
    machineId: z.string(), freedBytes: z.number(),
    removed: z.array(z.strictObject({ kind: z.enum(['scratch', 'job-storage', 'storage', 'caches']), count: z.number(), bytes: z.number().optional() })),
    kept: z.array(z.strictObject({ jobId: z.string(), paths: z.array(z.string()), reasons: z.record(z.string(), z.array(z.enum(KEPT_REASONS))).optional(), again: z.literal(true).optional() })),
    left: z.array(z.strictObject({ jobId: z.string(), paths: z.array(z.string()) })).optional(),
    trim: z.strictObject({ mount: z.string(), outcome: z.enum(['trimmed', 'refused', 'unsupported', 'failed']), trimmedBytes: z.number().optional(), said: z.string().optional(), hostCompaction: z.literal(true).optional() }).optional(),
  }),
  'job.containers_removed': z.strictObject({
    containers: z.array(z.string()), volumes: z.array(z.string()),
    details: z.array(z.strictObject({ id: z.string(), name: z.string(), image: z.string(), startedAt: z.string().optional(), stoppedAt: z.string().optional() })).optional(),
  }),
  'job.pod_removed': z.strictObject({ executor: z.string() }),
  'job.processes_stopped': z.strictObject({ machineId: z.string(), status: z.string() }),
  'job.resources_used': z.strictObject({ memoryPeakBytes: z.number().optional(), cpuSeconds: z.number().optional(), oomKills: z.number().optional(), diskBytes: z.number().optional() }),
  'job.heap_aborted': z.strictObject({ command: z.string(), heapLimitBytes: z.number().optional(), rssPeakBytes: z.number().optional(), abortedAt: z.string().optional() }),
  'job.heap_retry': z.strictObject({
    command: z.string(), rerunOf: z.string(), memoryMaxGiB: z.number().optional(), heapMiB: z.number().optional(),
    fromMemoryMaxGiB: z.number().optional(), fromHeapMiB: z.number().optional(), skipped: z.string().optional(),
  }),
  'job.core_dumped': z.strictObject({ command: z.string(), signal: z.string(), dumpedAt: z.string().optional() }),
  'job.oom_killed': z.strictObject({ command: z.string(), killedAt: z.string().optional() }),
  'job.scope_not_stopped': z.strictObject({ state: z.string(), processes: z.number().optional() }),
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
  'machine.storage_pruned': 'The sweep pruned the container storage of a machine (`machineId`) whose `pruneAfterDays` option is set (issue #2494, design.md "Hopper\'s own disk use" → "Part 8"), once a day, or once an hour while its disk is low: `removed`, each by its container `runtime`, `kind` and full `id`, with its size in `bytes` when the runtime said it — the exited containers stopped more than `olderThanDays` days ago with no label the prune keeps (the stack\'s, the hopper\'s boxes\', a kind node\'s, a job\'s), each with its anonymous volumes; the anonymous volumes no container uses; and the images no container uses built more than `olderThanDays` days ago, never one titled `hopper`. `bytes`: the sum of the sizes said. Nothing is forced, and a named volume (a seat\'s home, the stack\'s) is never removed. Only when it removed something.',
  'machine.disk_trim_ran': 'The sweep ran fstrim on a machine (`machineId`) whose `trimAboveGiB` option is set (issue #2494, design.md "Hopper\'s own disk use" → "Part 9"), on the filesystem its home is on (`mount`), once its cleanups there had freed that many GiB since the last trim: `freedBytes`, what the storage prune said it removed and the drop of the hopper\'s own disk use its reaps made. `outcome`: `trimmed`, with the bytes fstrim said it trimmed in `trimmedBytes`; `refused`, only root may and sudo did not let it with no password; `unsupported`, no fstrim there or a filesystem with no discard; `failed`, anything else; `said`, what fstrim said when it did not trim. `hostCompaction`: the machine is a WSL distro, whose virtual disk on the host shrinks only once it is compacted there (design.md says how), which the hopper cannot do from inside.',
  'machine.caches_cleared': 'The sweep cleared caches on a machine (`machineId`) that sets a cap for them (issue #2494, `cacheCap<Kind>GiB`, design.md "Hopper\'s own disk use" → "Part 10"): each kind whose places took more than its cap, or, while the disk there is `low`, each kind with a cap. `removed`: each place it removed, by its `kind` and `path` under the home, with its size in `bytes` as the survey before measured it; `bytes`, their sum. Only while no job there had not ended and the survey found no job\'s scope or process there; at most once an hour; only when it removed something. Never `~/.claude`, the rest of `~/.cache`, or a place that is a link.',
  'machine.sweep_dry_run': 'The sweep ran in dry run on a machine (`machineId`) whose `sweepDryRun` option, or the disk defaults\' dry run, is on (issue #2494, design.md "Hopper\'s own disk use" → "Part 14"): it removed nothing there, and this is what the pass would remove. `reaps`: each ended job whose scratch dir (`scratch`) and job worktrees it would reap — by age, by its retention, or at once while the disk is low or over its budget —, with what they take in `bytes` when the survey measured it; `kept`, its work was kept before, and the reap keeps it while it is not pushed. `reapBytes`: the bytes of the reaps not `kept`. `stops`: the jobs no longer live whose processes, scope and labelled containers it would stop and remove. `prune` (`pruneAfterDays`): the exited containers (`<runtime>:<id>`) it would remove, and what the runtimes say they could reclaim of images, containers and volumes, at most (`reclaimableBytes`). `caches` (`cacheCap<Kind>GiB`): each cache place it would clear, with its bytes; `cacheBytes`, their sum. `trim` (`trimAboveGiB`): `due` when those bytes reach it. Once, then again only once what it would remove changes; after a restart of the hopper, once more.',
  'machine.sweep_passed': 'One real pass of the sweep on a machine (`machineId`) removed something, kept work or could not remove a dir for the first time, or ran fstrim (issue #2494, design.md "Hopper\'s own disk use" → "Part 15"). `removed`: what it removed by `kind` — `scratch`, ended jobs\' scratch dirs with their job worktrees; `job-storage`, containers and volumes labelled with a job; `storage`, the storage prune\'s containers, volumes and images; `caches`, the cache places cleared —, each with its `count` and its `bytes` where they were measured; `freedBytes`, the sum of those bytes. `kept`: each ended job whose work the reap kept, its repositories (`paths`) and why (`reasons`: `dirty`, `stash`, `unpushed`); `again`, an earlier pass kept it too. `left`: the dirs the reap could not remove. `trim`: the fstrim result, as `machine.disk_trim_ran` has it. A pass that only keeps the same work again records none; a dry run records `machine.sweep_dry_run` in its place.',
  'job.containers_removed': 'The job\'s reap (issue #1120), at its end or in a later sweep, removed the containers and volumes on its machine labelled with its id (`hopper.job=<job id>`): `containers`, each with its anonymous volumes, and `volumes`, by name. The sweep reaps an ended job that still has one, whatever its age. A timed-out job\'s reap removes none: it may go on there. `details` (issue #975): what the reap said of each container before it removed it — its `name`, `image`, and when it started (`startedAt`) and stopped (`stoppedAt`), each absent when it never did —, which the job\'s parts list shows; absent from a client older than this.',
  'job.pod_removed': 'The sweep (issue #1570), at startup and then every 10 minutes, deleted the job\'s pod and removed its machine: the job ended, no cleanup was still owed, and its pod was still there with this hopper\'s instance label (a delete that failed, or a hopper older than the cleanup record). `executor` is the executor that started it.',
  'job.processes_stopped': 'The sweep (issue #2707) stopped the scope and processes of a job that has not ended, on machine `machineId`: the job was `status` (queued or held with no answer pending, or parked), as the hopper read it just before the reap, so nothing of it could run there. A failure of the job\'s agent after it names the sweep, not the agent.',
  'job.resources_used': 'What the job\'s scope used on its machine (`machineId`), read by the job\'s reap at its end from the scope\'s cgroup before it stopped the scope (issue #2498): `memoryPeakBytes`, the most memory the scope held at once (cgroup `memory.peak`); `cpuSeconds`, the CPU time of every process in it (`cpu.stat` `usage_usec`); `oomKills`, the processes in it the kernel killed for want of memory (`memory.events` `oom_kill`). Each is absent where the cgroup has none (`memory.peak` needs Linux 5.19). Part 4: `diskBytes`, what the job\'s scratch dir and worktrees held on its machine (`du -skx` of each), read by the same reap before it removed or kept them; absent where the job had neither there. None where the job has no scope there (no systemd user manager, or its scope ended before the reap: a parked job\'s, a print-mode agent\'s after its turn) and no scratch dir or worktree, or a client older than this. The job\'s parts list shows it.',
  'job.heap_aborted': 'A Node process of the job ran out of heap on its machine (`machineId`, issue #2722, design.md "Heap aborts"): V8 ended it with "JavaScript heap out of memory", and the report it wrote to the job\'s temp dir (every job\'s `NODE_OPTIONS` asks for one on a fatal error) was read by the job\'s reap at its end, then removed. `command`: what ran, the script node ran by its file\'s name with its arguments (`tsc --noEmit -p .`), never a path, at most 120 characters; `node` when it ran no script. `heapLimitBytes`: V8\'s heap limit for it (its `memoryLimit`); `rssPeakBytes`: the most memory the process held (its `maxRss`); `abortedAt`: when it aborted. Each is absent where the report did not say it. One for each report, at most 20 for each reap. The job\'s parts list shows each as failed.',
  'job.heap_retry': 'The job runs again a job whose Node process ran out of heap (`rerunOf`, its `job.heap_aborted`), and starts with a larger memory limit, so a larger Node heap (issue #2722 part 4, design.md "Heap retry"): once in a chain of runs, at its first start. `command`: the command that ran out of heap, as `job.heap_aborted` said it. With a larger limit: `memoryMaxGiB` and `heapMiB`, the job scope\'s `MemoryMax` and the `--max-old-space-size` its Node processes get, and `fromMemoryMaxGiB` and `fromHeapMiB`, the ones it had: 1.5 times its machine\'s job memory limit, at most the memory available above the machine\'s memory floor. Else `skipped`, why not (no memory limit, no memory reading, or less than 0.5 GiB more room), and it runs with its own limits. Its parts list shows it under machines.',
  'job.core_dumped': 'A process of the job ended with a core dump on its machine (`machineId`, issue #2722 part 3, design.md "Core dumps and OOM kills"): a signal ended it and systemd-coredump took its core, which the job\'s reap read at its end from the journal entries of the job\'s scope. `command`: what ran, as for `job.heap_aborted` (the script node ran by its file\'s name, each path by its file\'s name, at most 120 characters), from the journal\'s command line; `a process` when it gave none. `signal`: the signal by its name (`SIGSEGV`, `SIGABRT`), `signal <n>` for another. `dumpedAt`: when. A core dump of a heap abort is the heap abort\'s (`job.heap_aborted`), and so is its parent\'s of the same signal at most 10 s after it. A failed part of the job; the job itself does not fail for it.',
  'job.oom_killed': 'The kernel\'s OOM killer ended a process of the job on its machine (`machineId`, issue #2722 part 3, design.md "Core dumps and OOM kills"): the job\'s reap read the kernel\'s `oom-kill:` line that names the job\'s scope, only when the scope counted OOM kills (`job.resources_used` `oomKills`). `command`: the killed process\'s name as the kernel gives it (its `task`, at most 15 characters); `a process` when it gave none. `killedAt`: when. None where the reap\'s user cannot read the kernel log. A failed part of the job; the job itself does not fail for it.',
  'job.scope_not_stopped': 'The job\'s reap could not stop the job\'s scope on its machine (`machineId`, issue #2722 part 6, design.md "No misleading state after a failed process"): `systemctl --user stop` of `hopper-job-<id>.scope` did not go through — a process that writes its core dump cannot be killed until it is written, so the stop times out. `state`: the scope\'s state then (`failed`, `deactivating`); `processes`: the processes still in its cgroup, absent where the reap could not read it. A failed scope is reset, so it does not stay listed. The sweep reaps it again while the machine still has it. A failed part of the job; the job itself does not fail for it.',
  'job.cleanup_leftover': 'The job ended at `endedAt`, and more than `graceMinutes` later its resource ledger still holds `entries` (issue #2504, design.md "The resource ledger"): each thing the hopper made for it — on `machineId`, its `kind` and `locator` — that no reap removed (`state` `live`: no reap reached it; `failed`: a reap could not remove it, `reason` says why). The sweep\'s leftover check records it once per job; Machines counts it while an entry stays, and the cleanup worker tries again (it is no stuck work on Failures, issue #2684). An entry on a retired machine (no machine source lists it, the plugins config does not name it) is then closed `retired` in the ledger (part 12), and the leftover ends.',
  'machine.leftover_kept': 'A person keeps a leftover on Machines (issue #1116): a dir in a work tree\'s `.hopper-scratch` (the layout before issue #1188) whose job the hopper does not know, or a repository mirror there, at `path` on `machineId`. Nothing is removed; the listing shows it kept. `person` and `via` say who and the way.',
  'machine.leftover_removed': 'A person removes a leftover on Machines (issue #1116): the dir at `path` on `machineId` is removed whatever it holds. `unpushed`: it held work not pushed, which is lost; `bytes`: its size when listed. `gone`: it was no longer there. `person` and `via` say who and the way.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DISK_EVENT_EXAMPLES = {
  'machine.disk_over_budget': { machineId: 'desk', usedBytes: 62_000_000_000, budgetBytes: 50_000_000_000, paths: [{ path: '/home/me/work/.worktrees', bytes: 50_000_000_000 }, { path: '/home/me/jobs/.worktrees', bytes: 12_000_000_000 }] },
  'machine.disk_within_budget': { machineId: 'desk', usedBytes: 41_000_000_000, budgetBytes: 50_000_000_000 },
  'machine.disk_low': { machineId: 'seat-l1', label: 'seat l1', freeBytes: 4_000_000_000, totalBytes: 250_000_000_000, critical: false },
  'machine.disk_ok': { machineId: 'seat-l1', label: 'seat l1', freeBytes: 40_000_000_000, totalBytes: 250_000_000_000 },
  'machine.storage_pruned': { machineId: 'seat-l1', olderThanDays: 30, bytes: 1_500_004_096, removed: [{ runtime: 'podman', kind: 'container', id: 'a'.repeat(64), bytes: 4096 }, { runtime: 'podman', kind: 'volume', id: 'c'.repeat(64) }, { runtime: 'podman', kind: 'image', id: 'd'.repeat(64), bytes: 1_500_000_000 }] },
  'machine.disk_trim_ran': { machineId: 'seat-l1', freedBytes: 12_000_000_000, mount: '/', outcome: 'trimmed', trimmedBytes: 14_500_000_000, hostCompaction: true },
  'machine.caches_cleared': { machineId: 'seat-l1', bytes: 9_000_000_000, removed: [{ kind: 'gradle', path: '/home/seat/.gradle/caches', bytes: 8_000_000_000 }, { kind: 'npm', path: '/home/seat/.npm', bytes: 1_000_000_000 }] },
  'machine.sweep_dry_run': {
    machineId: 'seat-l1', reaps: [{ jobId: 'f3b1c2d4', scratch: '/home/seat/work/.worktrees/@scratch/f3b1c2d4', bytes: 2_400_000_000 }, { jobId: 'a7e90b12', scratch: '/home/seat/work/.worktrees/@scratch/a7e90b12', bytes: 800_000_000, kept: true }],
    reapBytes: 2_400_000_000, stops: [], prune: { olderThanDays: 30, containers: [`podman:${'a'.repeat(64)}`], reclaimableBytes: 6_000_000_000 },
    caches: [{ kind: 'gradle', path: '/home/seat/.gradle/caches', bytes: 8_000_000_000 }], cacheBytes: 8_000_000_000, trim: { aboveGiB: 10, due: true },
  },
  'machine.sweep_passed': {
    machineId: 'seat-l1', freedBytes: 11_400_000_000,
    removed: [{ kind: 'scratch', count: 3, bytes: 2_400_000_000 }, { kind: 'job-storage', count: 2 }, { kind: 'caches', count: 1, bytes: 9_000_000_000 }],
    kept: [{ jobId: 'a7e90b12', paths: ['/home/seat/work/.worktrees/@scratch/a7e90b12/app'], reasons: { '/home/seat/work/.worktrees/@scratch/a7e90b12/app': ['stash', 'unpushed'] } }],
    trim: { mount: '/', outcome: 'trimmed', trimmedBytes: 14_500_000_000, hostCompaction: true },
  },
  'job.containers_removed': { containers: ['3f2a9c1b7d4e'], volumes: ['hopper-test-db'], details: [{ id: '3f2a9c1b7d4e', name: 'hopper-test-db', image: 'docker.io/library/postgres:16', startedAt: '2026-10-08T00:02:00.000Z', stoppedAt: '2026-10-08T00:09:00.000Z' }] },
  'job.pod_removed': { executor: 'kubernetes' },
  'job.processes_stopped': { machineId: 'm1', status: 'queued' },
  'job.resources_used': { memoryPeakBytes: 3_221_225_472, cpuSeconds: 754.5, oomKills: 1, diskBytes: 1_073_741_824 },
  'job.heap_aborted': { command: 'tsc --noEmit -p .', heapLimitBytes: 2_248_146_944, rssPeakBytes: 2_405_000_000, abortedAt: '2026-10-24T10:41:00.000Z' },
  'job.heap_retry': { command: 'tsc --noEmit -p .', rerunOf: 'a1b2c3d4', memoryMaxGiB: 13.5, heapMiB: 10368, fromMemoryMaxGiB: 9, fromHeapMiB: 6912 },
  'job.core_dumped': { command: 'cc1plus -O2 big.cpp', signal: 'SIGSEGV', dumpedAt: '2026-10-24T10:41:00.000Z' },
  'job.oom_killed': { command: 'tsc', killedAt: '2026-10-24T10:41:00.000Z' },
  'job.scope_not_stopped': { state: 'failed', processes: 1 },
  'job.cleanup_leftover': { endedAt: '2026-10-22T09:00:00.000Z', graceMinutes: 60, entries: [{ machineId: 'desk', kind: 'scratch_dir', locator: '/home/me/work/.worktrees/@scratch/f3b1c2d4', state: 'failed', reason: '/home/me/work/.worktrees/@scratch/f3b1c2d4/containers is still there' }] },
  'machine.leftover_kept': { machineId: 'desk', path: '/home/me/work/.hopper-scratch/test-job', person: 'Pat', via: 'ui' },
  'machine.leftover_removed': { machineId: 'desk', path: '/home/me/work/.hopper-scratch/repos/acme/app.git', unpushed: false, bytes: 1_200_000_000, person: 'Pat', via: 'ui' },
} as const;
