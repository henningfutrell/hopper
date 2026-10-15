// The hopper's own disk use's events (issue #1120, design.md "Hopper's own disk use"): the hopper's own disk use on a
// machine is still over the disk budget after the sweep reaped what it could, or is back within it (part 2); a job's reap
// removed the containers and volumes labelled with its id (part 3). Part of EVENT_SCHEMAS (schemas.ts), with their docs
// (docs.ts) and examples (examples.ts).
import { z } from 'zod';

const use = { machineId: z.string(), usedBytes: z.number(), budgetBytes: z.number() };

export const MACHINE_DISK_EVENT_SCHEMAS = {
  'machine.disk_over_budget': z.strictObject({ ...use, paths: z.array(z.strictObject({ path: z.string(), bytes: z.number() })) }),
  'machine.disk_within_budget': z.strictObject(use),
  'job.containers_removed': z.strictObject({ containers: z.array(z.string()), volumes: z.array(z.string()) }),
} as const;

/** Their part of the event reference (docs.ts). */
export const MACHINE_DISK_EVENT_DOCS = {
  'machine.disk_over_budget': 'The hopper\'s own disk use on a machine (`usedBytes`: each work tree\'s `.worktrees`, its job worktrees and scratch dirs, `paths` each) is over the disk budget (`budgetBytes`), after the sweep reaped every ended job\'s scratch dir it could, whatever its age (issue #1120). What is left is work not pushed, live jobs\' work, or more than the budget allows. Once while it stays over.',
  'machine.disk_within_budget': 'A machine told over by `machine.disk_over_budget` has the hopper\'s own disk use back within the disk budget (issue #1120): `usedBytes` of `budgetBytes` now.',
  'job.containers_removed': 'The job\'s reap (issue #1120), at its end or in a later sweep, removed the containers and volumes on its machine labelled with its id (`hopper.job=<job id>`): `containers`, each with its anonymous volumes, and `volumes`, by name. The sweep reaps an ended job that still has one, whatever its age. A timed-out job\'s reap removes none: it may go on there.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DISK_EVENT_EXAMPLES = {
  'machine.disk_over_budget': { machineId: 'desk', usedBytes: 62_000_000_000, budgetBytes: 50_000_000_000, paths: [{ path: '/home/me/work/.worktrees', bytes: 50_000_000_000 }, { path: '/home/me/jobs/.worktrees', bytes: 12_000_000_000 }] },
  'machine.disk_within_budget': { machineId: 'desk', usedBytes: 41_000_000_000, budgetBytes: 50_000_000_000 },
  'job.containers_removed': { containers: ['3f2a9c1b7d4e'], volumes: ['hopper-test-db'] },
} as const;
