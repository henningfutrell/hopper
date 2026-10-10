// What a failed job looked like when it failed (issue #509): the machine it ran on and the evidence its failure
// record keeps. Pure.
import type { FailureEvidence, Job } from '../domain/types.ts';

/** The machine a job ran on: its lane's, else the one it resumes on or is pinned to. */
export function machineOf(job: Job): string | undefined {
  const lane = job.laneId;
  const at = lane?.lastIndexOf('/lane-') ?? -1;
  return lane && at > 0 ? lane.slice(0, at) : job.resumeOn ?? job.spec.machineId;
}

const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function evidenceOf(job: Job, f: { error: string; attempt: number; sameSignature: number; machineId?: string; ranMs?: number }): FailureEvidence {
  const model = textOf(job.spec.payload.model);
  return {
    error: f.error, executor: job.spec.executor, attempt: f.attempt, sameSignature: f.sameSignature,
    ...(job.errorTail ? { tail: job.errorTail } : {}), ...(job.progressMessage ? { lastProgress: job.progressMessage } : {}),
    ...(f.machineId ? { machineId: f.machineId } : {}), ...(model ? { model } : {}),
    ...(job.source?.repo ? { repo: job.source.repo } : {}), ...(job.source ? { source: job.source.source } : {}),
    ...(f.ranMs !== undefined ? { ranMs: f.ranMs } : {}), ...(job.liveness ? { liveness: job.liveness } : {}),
  };
}
