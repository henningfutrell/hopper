// Landing batches' events (issue #1073, design.md "Landing batches"): a batch run started on the landing branch's tip, its
// end — promoted to the tested branch, or failed —, a job's pull request moved from the tested branch to the landing
// branch, and an admin's change of the settings. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const strict = z.strictObject;
const settings = strict({ repos: z.record(z.string(), strict({ tested: z.string(), everyMerges: z.number().int().min(1), everyMinutes: z.number().int().min(1) })) });
const ended = { repo: z.string(), tested: z.string(), tip: z.string(), pullRequest: z.number().int(), url: z.string() };

export const LANDING_BATCH_EVENT_SCHEMAS = {
  'landing_batch.started': strict({
    repo: z.string(), landing: z.string(), tested: z.string(), tip: z.string(), branch: z.string(),
    pullRequest: z.number().int(), url: z.string(), merges: z.array(z.number().int()), why: z.string().optional(),
  }),
  'landing_batch.promoted': strict({ ...ended, merge: z.string().optional() }),
  'landing_batch.failed': strict({ ...ended, reason: z.string(), checks: z.array(z.string()) }),
  'landing_batch.retargeted': strict({ repo: z.string(), pullRequest: z.number().int(), url: z.string(), from: z.string(), to: z.string() }),
  'landing_batches.changed': strict({ from: settings, to: settings, by: z.string() }),
} as const;
