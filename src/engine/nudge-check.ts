// The check before a nudge (issue #627, design.md "The check before a nudge"): asked by an executor before it nudges a
// job after a status note. The job's source first — its work is over there: end the job done —, then what the job
// waits on in the hopper — a person is asked for something: no nudge —, else the nudge.
import type { NudgeCheck } from '../domain/ports.ts';
import type { Watch } from '../domain/job-stream.ts';
import type { Job } from '../domain/types.ts';
import type { CredentialRequest } from '../domain/vault.ts';
import type { EngineContext } from './context.ts';

export async function nudgeCheck(c: Pick<EngineContext, 'overAtSource' | 'credentialRequests' | 'store'>, job: Job): Promise<NudgeCheck> {
  const done = await c.overAtSource(job);
  if (done !== undefined) return { done };
  const waiting = personAwaited(job.id, c.store.jobStream.openWatches(job.id), c.credentialRequests());
  return waiting === undefined ? { nudge: true } : { waiting };
}

/**
 * What the job waits on a person for, or undefined: an open watch on its job stream (a skill request a person must
 * give something for first, issue #613), or a credential request that names it (issue #583). Pure.
 */
export function personAwaited(jobId: string, watches: readonly Watch[], requests: readonly CredentialRequest[]): string | undefined {
  const watch = watches.find((w) => w.jobId === jobId);
  if (watch) return `a skill request for ${watch.body.name ?? watch.id}`;
  const request = requests.find((r) => r.asked.some((a) => a.job === jobId));
  return request ? `a credential request for ${request.title}` : undefined;
}
