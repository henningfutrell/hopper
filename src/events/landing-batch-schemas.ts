// Landing batches' events (issue #1073, design.md "Landing batches"): a batch run started on the landing branch's tip, its
// end — promoted to the tested branch, or failed —, a job's pull request moved from the tested branch to the landing
// branch, and an admin's change of the settings; a red batch's bisect, its runs and results, the culprit, its revert and
// its fix issue (part 2); a back-merge of the tested branch into the landing branch after merge conflicts, and its issue (part 4);
// the canary of a stable candidate: started, held with its issue, or promoted to stable (part 5). Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const strict = z.strictObject;
const settings = strict({ repos: z.record(z.string(), strict({ tested: z.string(), landing: z.string().optional(), everyMerges: z.number().int().min(1), everyMinutes: z.number().int().min(1), canaryHours: z.number().int().min(1).optional() })) });
const ended = { repo: z.string(), tested: z.string(), tip: z.string(), pullRequest: z.number().int(), url: z.string() };
const check = strict({ name: z.string(), id: z.number().int().optional() });
const point = strict({ sha: z.string(), pullRequest: z.number().int().optional() });
const result = strict({ index: z.number().int(), sha: z.string(), outcome: z.enum(['good', 'bad', 'unknown']) });
const culpritAt = { repo: z.string(), tip: z.string(), sha: z.string() };
const canaryAt = { repo: z.string(), canary: z.string(), stable: z.string(), tip: z.string() };

export const LANDING_BATCH_EVENT_SCHEMAS = {
  'landing_batch.due': strict({
    repo: z.string(), landing: z.string(), tested: z.string(), tip: z.string(), branch: z.string(), merges: z.array(z.number().int()), closes: z.array(z.string()), why: z.string(),
  }),
  'landing_batch.started': strict({
    repo: z.string(), landing: z.string(), tested: z.string(), tip: z.string(), branch: z.string(),
    pullRequest: z.number().int(), url: z.string(), merges: z.array(z.number().int()), why: z.string().optional(),
  }),
  'landing_batch.pending': strict({ repo: z.string(), landing: z.string(), tested: z.string(), tip: z.string(), merges: z.array(z.number().int()) }),
  'landing_batch.promoted': strict({ ...ended, merge: z.string().optional() }),
  'landing_batch.failed': strict({ ...ended, reason: z.string(), checks: z.array(z.string()), checkRuns: z.array(check).optional(), conflicts: z.boolean().optional(), cutOff: z.literal(true).optional() }),
  'landing_batch.retargeted': strict({ repo: z.string(), pullRequest: z.number().int(), url: z.string(), from: z.string(), to: z.string() }),
  'landing_batches.changed': strict({ from: settings, to: settings, by: z.string() }),
  'landing_batch.bisect_started': strict({ ...ended, points: z.array(point), checks: z.array(check), reason: z.string() }),
  'landing_batch.bisect_run': strict({ repo: z.string(), tested: z.string(), tip: z.string(), index: z.number().int(), sha: z.string(), branch: z.string(), pullRequest: z.number().int(), url: z.string() }),
  'landing_batch.bisect_tested': strict({
    repo: z.string(), tested: z.string(), tip: z.string(), index: z.number().int(), sha: z.string(), pullRequest: z.number().int(), url: z.string(),
    outcome: z.enum(['good', 'bad', 'unknown']), reason: z.string().optional(), checks: z.array(check).optional(), cutOff: z.literal(true).optional(),
  }),
  'landing_batch.culprit': strict({
    repo: z.string(), tested: z.string(), tip: z.string(), index: z.number().int(), sha: z.string(), pullRequest: z.number().int().optional(),
    checks: z.array(check), reason: z.string(), results: z.array(result), batch: z.number().int().optional(),
  }),
  'landing_batch.revert_opened': strict({ ...culpritAt, culpritPullRequest: z.number().int(), pullRequest: z.number().int(), url: z.string() }),
  'landing_batch.reverted': strict({ ...culpritAt, pullRequest: z.number().int(), url: z.string(), merge: z.string().optional() }),
  'landing_batch.revert_failed': strict({ ...culpritAt, reason: z.string(), pullRequest: z.number().int().optional(), url: z.string().optional() }),
  'landing_batch.fix_filed': strict({ ...culpritAt, issue: z.number().int(), url: z.string() }),
  'landing_batch.back_merge_opened': strict({
    repo: z.string(), landing: z.string(), tested: z.string(), tip: z.string(), batch: z.number().int(), branch: z.string(), merge: z.string(), pullRequest: z.number().int(), url: z.string(),
  }),
  'landing_batch.back_merged': strict({ repo: z.string(), tip: z.string(), pullRequest: z.number().int(), url: z.string(), merge: z.string().optional() }),
  'landing_batch.back_merge_failed': strict({
    repo: z.string(), tip: z.string(), batch: z.number().int().optional(), conflict: z.boolean(), reason: z.string(), pullRequest: z.number().int().optional(), url: z.string().optional(),
  }),
  'landing_batch.back_merge_issue_filed': strict({ repo: z.string(), tip: z.string(), issue: z.number().int(), url: z.string() }),
  'landing_batch.canary_started': strict({ ...canaryAt, hours: z.number().int().min(1), mergeCommits: z.array(z.string()).optional() }),
  'landing_batch.canary_held': strict({ ...canaryAt, reports: z.array(z.number().int()), reason: z.string() }),
  'landing_batch.canary_issue_filed': strict({ repo: z.string(), tip: z.string(), issue: z.number().int(), url: z.string() }),
  'landing_batch.canary_promoted': strict({ ...canaryAt, why: z.string() }),
  'landing_batch.stuck': strict({ repo: z.string(), error: z.string(), since: z.iso.datetime(), passes: z.number().int() }),
  'landing_batch.restarted': strict({ repo: z.string(), tip: z.string().optional(), by: z.string(), closed: z.array(z.number().int()) }),
} as const;
