// The disk budget's events (issue #1120, design.md "Hopper's own disk use" → "Part 2"): the hopper's own disk use on a
// machine is still over the disk budget after the sweep reaped what it could, or is back within it. Part of EVENT_SCHEMAS (schemas.ts), with
// their docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';

const use = { machineId: z.string(), usedBytes: z.number(), budgetBytes: z.number() };

export const MACHINE_DISK_EVENT_SCHEMAS = {
  'machine.disk_over_budget': z.strictObject({ ...use, paths: z.array(z.strictObject({ path: z.string(), bytes: z.number() })) }),
  'machine.disk_within_budget': z.strictObject(use),
} as const;

/** Their part of the event reference (docs.ts). */
export const MACHINE_DISK_EVENT_DOCS = {
  'machine.disk_over_budget': 'The hopper\'s own disk use on a machine (`usedBytes`: its scratch areas and job worktrees, `paths` each) is over the disk budget (`budgetBytes`), after the sweep reaped every ended job\'s scratch dir it could, whatever its age (issue #1120). What is left is work not pushed, live jobs\' work, or more than the budget allows. Once while it stays over.',
  'machine.disk_within_budget': 'A machine told over by `machine.disk_over_budget` has the hopper\'s own disk use back within the disk budget (issue #1120): `usedBytes` of `budgetBytes` now.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DISK_EVENT_EXAMPLES = {
  'machine.disk_over_budget': { machineId: 'desk', usedBytes: 62_000_000_000, budgetBytes: 50_000_000_000, paths: [{ path: '/home/me/work/.hopper-scratch', bytes: 12_000_000_000 }, { path: '/home/me/work/workspace/worktrees', bytes: 50_000_000_000 }] },
  'machine.disk_within_budget': { machineId: 'desk', usedBytes: 41_000_000_000, budgetBytes: 50_000_000_000 },
} as const;
