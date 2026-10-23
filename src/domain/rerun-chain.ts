// The reruns of a job (issue #2639 part 2, design.md "One approval per sandbox run", "Approvals a rerun keeps"): an
// item's jobs, each the `rerunOf` of the next. What a person approved for one of them — its sandbox runs of a template,
// a template approved for its runs only — carries to the jobs that run it again, so a rerun (the assessor's, or a
// person's Run again) does not wait on the same cards again. A vault grant needs none of this: it is kept for the item.
// Pure.
import type { Job } from './types.ts';

/** How many jobs a chain is walked: the approvals of an item run again more often than this stay with the older jobs. */
export const RERUN_DEPTH = 20;

type JobOf = (id: string) => Pick<Job, 'id' | 'rerunOf' | 'source'> | undefined;

/** The jobs `jobId` runs again, newest first: its `rerunOf`, then that job's, and on. */
export function earlierRuns(jobId: string, jobOf: JobOf): string[] {
  const out: string[] = [];
  for (let id = jobOf(jobId)?.rerunOf; id !== undefined && id !== jobId && !out.includes(id) && out.length < RERUN_DEPTH; id = jobOf(id)?.rerunOf) out.push(id);
  return out;
}

/** The jobs that run `jobId` again, oldest first: its item's newest job, walked back to it. Empty when none does. */
export function laterRuns(jobId: string, jobOf: JobOf, newestOf: (key: string) => Pick<Job, 'id' | 'rerunOf'> | undefined): string[] {
  const key = jobOf(jobId)?.source?.key;
  const newest = key === undefined ? undefined : newestOf(key);
  if (!newest || newest.id === jobId) return [];
  const chain = [newest.id, ...earlierRuns(newest.id, jobOf)];
  const at = chain.indexOf(jobId);
  return at < 0 ? [] : chain.slice(0, at).reverse();
}
