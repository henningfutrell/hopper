// How a job is named: its goal, and the issue it came from as `repo#n`.
import type { Job } from './wire.ts';

export const goalOf = (job: Job): string => job.spec.goal || job.source?.title || job.spec.executor;

export function issueRef(job: Job): string | null {
  const s = job.source;
  if (!s) return null;
  return s.repo && s.number != null ? `${s.repo.split('/').pop()}#${s.number}` : (s.title ?? s.key);
}
