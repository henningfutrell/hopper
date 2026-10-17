// The hopper's own disk use's events (issue #1120, design.md "Hopper's own disk use"): the hopper's own disk use on a
// machine is still over the disk budget after the sweep reaped what it could, or is back within it (part 2); a job's reap
// removed the containers and volumes labelled with its id (part 3); a person kept or removed a leftover (issue #1116). Part of EVENT_SCHEMAS (schemas.ts), with their docs
// (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

const use = { machineId: z.string(), usedBytes: z.number(), budgetBytes: z.number() };
/** A leftover (issue #1116): its machine and path, and who decided, and the way. */
const leftover = { machineId: z.string(), path: z.string(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() };

export const MACHINE_DISK_EVENT_SCHEMAS = {
  'machine.disk_over_budget': z.strictObject({ ...use, paths: z.array(z.strictObject({ path: z.string(), bytes: z.number() })) }),
  'machine.disk_within_budget': z.strictObject(use),
  'job.containers_removed': z.strictObject({
    containers: z.array(z.string()), volumes: z.array(z.string()),
    details: z.array(z.strictObject({ id: z.string(), name: z.string(), image: z.string(), startedAt: z.string().optional(), stoppedAt: z.string().optional() })).optional(),
  }),
  'machine.leftover_kept': z.strictObject(leftover),
  'machine.leftover_removed': z.strictObject({ ...leftover, unpushed: z.boolean(), bytes: z.number().optional(), gone: z.literal(true).optional() }),
} as const;

/** Their part of the event reference (docs.ts). */
export const MACHINE_DISK_EVENT_DOCS = {
  'machine.disk_over_budget': 'The hopper\'s own disk use on a machine (`usedBytes`: each work tree\'s `.worktrees`, its job worktrees and scratch dirs, and the repository checkouts in its workspace, `paths` each) is over the disk budget (`budgetBytes`), after the sweep reaped every ended job\'s scratch dir it could, whatever its age (issue #1120). What is left is work not pushed, live jobs\' work, the repository checkouts (the sweep never removes one), or more than the budget allows. Once while it stays over.',
  'machine.disk_within_budget': 'A machine told over by `machine.disk_over_budget` has the hopper\'s own disk use back within the disk budget (issue #1120): `usedBytes` of `budgetBytes` now.',
  'job.containers_removed': 'The job\'s reap (issue #1120), at its end or in a later sweep, removed the containers and volumes on its machine labelled with its id (`hopper.job=<job id>`): `containers`, each with its anonymous volumes, and `volumes`, by name. The sweep reaps an ended job that still has one, whatever its age. A timed-out job\'s reap removes none: it may go on there. `details` (issue #975): what the reap said of each container before it removed it — its `name`, `image`, and when it started (`startedAt`) and stopped (`stoppedAt`), each absent when it never did —, which the job\'s parts list shows; absent from a client older than this.',
  'machine.leftover_kept': 'A person keeps a leftover on Machines (issue #1116): a dir in a work tree\'s `.hopper-scratch` (the layout before issue #1188) whose job the hopper does not know, or a repository mirror there, at `path` on `machineId`. Nothing is removed; the listing shows it kept. `person` and `via` say who and the way.',
  'machine.leftover_removed': 'A person removes a leftover on Machines (issue #1116): the dir at `path` on `machineId` is removed whatever it holds. `unpushed`: it held work not pushed, which is lost; `bytes`: its size when listed. `gone`: it was no longer there. `person` and `via` say who and the way.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DISK_EVENT_EXAMPLES = {
  'machine.disk_over_budget': { machineId: 'desk', usedBytes: 62_000_000_000, budgetBytes: 50_000_000_000, paths: [{ path: '/home/me/work/.worktrees', bytes: 50_000_000_000 }, { path: '/home/me/jobs/.worktrees', bytes: 12_000_000_000 }] },
  'machine.disk_within_budget': { machineId: 'desk', usedBytes: 41_000_000_000, budgetBytes: 50_000_000_000 },
  'job.containers_removed': { containers: ['3f2a9c1b7d4e'], volumes: ['hopper-test-db'], details: [{ id: '3f2a9c1b7d4e', name: 'hopper-test-db', image: 'docker.io/library/postgres:16', startedAt: '2026-10-08T00:02:00.000Z', stoppedAt: '2026-10-08T00:09:00.000Z' }] },
  'machine.leftover_kept': { machineId: 'desk', path: '/home/me/work/.hopper-scratch/test-job', person: 'Pat', via: 'ui' },
  'machine.leftover_removed': { machineId: 'desk', path: '/home/me/work/.hopper-scratch/repos/acme/app.git', unpushed: false, bytes: 1_200_000_000, person: 'Pat', via: 'ui' },
} as const;
