// Running a failure record's job again — a person's Retry, or Jev's pick (issue #550) —, if it may run again now:
// through the sync loop's Run again, the record then `retried` with the new job and a note of who ran it.
import type { RerunBy, RerunResult, UserStore } from '../domain/ports.ts';
import type { ActingPerson, Job } from '../domain/types.ts';
import { recordRetry } from './view.ts';

export type RerunRecordResult = { ok: true; value: Job } | { ok: false; reason: 'not_found' | 'conflict'; message: string };

export async function rerunRecordOf(
  d: { store: UserStore; rerun(jobId: string, by: RerunBy, brief?: string, acting?: ActingPerson): Promise<RerunResult>; now(): Date }, recordId: string, by: RerunBy, note: string, acting?: ActingPerson,
): Promise<RerunRecordResult> {
  const r = d.store.failures.get(recordId);
  if (!r) return { ok: false, reason: 'not_found', message: `failure ${recordId} not found` };
  const allowed = recordRetry(d.store, r);
  if (!allowed.ok) return { ok: false, reason: 'conflict', message: `failure ${recordId} cannot run again: ${allowed.why}` };
  const result = await d.rerun(r.jobId, by, undefined, acting);
  if (!result.ok) return { ok: false, reason: result.reason === 'not_found' ? 'not_found' : 'conflict', message: result.message };
  d.store.failures.update(r.id, { outcome: 'retried', outcomeAt: d.now().toISOString(), nextJobId: result.job.id, note });
  return { ok: true, value: result.job };
}
