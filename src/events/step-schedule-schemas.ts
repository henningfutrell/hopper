// The step schedules' events (issue #2716, design.md "Step schedules"): a schedule saved, removed, granted the vault or its
// grant taken back, and each run's start and end. No job: a run has none. Never a run's output or a secret's value. Part of
// EVENT_SCHEMAS (schemas.ts), with their docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';

const strict = z.strictObject;
const ended = { schedule: z.string(), run: z.string(), exit: z.number().int(), seconds: z.number().int().min(0), problem: z.string().optional() };

export const STEP_SCHEDULE_EVENT_SCHEMAS = {
  'step_schedule.saved': strict({
    name: z.string(), template: z.string(), repo: z.string(), input: z.string(), script: z.string(), daily: z.string(),
    timeoutSeconds: z.number().int().min(1), by: z.string(), granted: z.boolean(),
  }),
  'step_schedule.removed': strict({ name: z.string(), by: z.string() }),
  'step_schedule.granted': strict({ name: z.string(), by: z.string(), template: z.string() }),
  'step_schedule.revoked': strict({ name: z.string(), by: z.string() }),
  'step_schedule.run_started': strict({
    schedule: z.string(), run: z.string(), due: z.string(), trigger: z.enum(['due', 'now']), box: z.string(), template: z.string(),
    repo: z.string(), commit: z.string(), script: z.string(), secrets: z.array(z.string()).optional(),
  }),
  'step_schedule.run_finished': strict(ended),
  'step_schedule.run_failed': strict({ ...ended, outcome: z.enum(['failed', 'interrupted']) }),
} as const;

/** Their part of the event reference (docs.ts). */
export const STEP_SCHEDULE_EVENT_DOCS = {
  'step_schedule.saved': 'A person saved a step schedule (issue #2716): the hopper runs `script`, a file in the folder `input` of `repo` at its default branch, in a new sandbox of `template` each day at `daily` (UTC), for at most `timeoutSeconds`. `granted`: it keeps its vault grant; a save that changes the template, the repository, the folder or the script takes the grant back. `by` who saved it.',
  'step_schedule.removed': 'A person removed a step schedule and its runs (issue #2716).',
  'step_schedule.granted': 'A person granted a step schedule the vault (issue #2716), after Access allowed it (OpenFGA `vault_grant#can_grant`, the key `schedule:<name>`): its runs get the vault secrets its `template` gives, copied into their sandbox, never more.',
  'step_schedule.revoked': 'A person took a step schedule\'s vault grant back (issue #2716): its runs of a template that gives vault secrets fail until a person grants it again.',
  'step_schedule.run_started': 'A run of a step schedule started (issue #2716): its due time came (`trigger` `due`, `due` that time) or a person ran it now (`now`). Its sandbox `box` of `template` runs `script` of `repo` at `commit`, the default branch\'s head when the run read it; `secrets` the names of the vault secrets copied in, never a value.',
  'step_schedule.run_finished': 'A run of a step schedule ended with exit code 0 (issue #2716): `seconds` how long it took.',
  'step_schedule.run_failed': 'A run of a step schedule failed (issue #2716): its script exited non-zero, it timed out, or the hopper could not start it (`exit` 125 and `problem`: the template not ready, no vault grant, the files not read). `outcome` `interrupted`: a hopper stopped while it ran, and it is not run again. The notifiers send it; Needs you lists its schedule until a run of it succeeds.',
} as const;

const RUN = '7d3c1e2a-0000-4000-8000-000000002716';

/** Their examples (examples.ts). */
export const STEP_SCHEDULE_EVENT_EXAMPLES = {
  'step_schedule.saved': { name: 'nightly-backup', template: 'backup', repo: 'acme/ops', input: 'backup', script: 'backup/step.sh', daily: '02:00', timeoutSeconds: 1800, by: 'Pat', granted: false },
  'step_schedule.removed': { name: 'nightly-backup', by: 'Pat' },
  'step_schedule.granted': { name: 'nightly-backup', by: 'Pat', template: 'backup' },
  'step_schedule.revoked': { name: 'nightly-backup', by: 'Pat' },
  'step_schedule.run_started': { schedule: 'nightly-backup', run: RUN, due: '2026-10-25T02:00:00.000Z', trigger: 'due', box: 'hopper-need-backup-7d3c1e2a', template: 'backup', repo: 'acme/ops', commit: '3f2a9c0d1e4b5a6c7d8e9f001122334455667788', script: 'backup/step.sh', secrets: ['BACKUP_BUCKET_KEY'] },
  'step_schedule.run_finished': { schedule: 'nightly-backup', run: RUN, exit: 0, seconds: 412 },
  'step_schedule.run_failed': { schedule: 'nightly-backup', run: RUN, exit: 1, seconds: 37, outcome: 'failed' },
} as const;

