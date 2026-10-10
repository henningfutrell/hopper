// An artifact's changes on its job's stream (issue #624, issue #613): the job, and a person waiting with it, hear at
// once that an artifact was made, shared, a share revoked, or it was removed. The payload is the event's data.
import type { DomainEvent, EventType, JobStatus } from '../domain/types.ts';

/** The stream types the artifacts emit, each with its phase: none ends a request. */
export const ARTIFACT_STREAM_TYPES = {
  'artifact.created': 'progress',
  'artifact.shared': 'progress',
  'artifact.share_revoked': 'progress',
  'artifact.removed': 'progress',
} as const;

const STREAMED = Object.keys(ARTIFACT_STREAM_TYPES) as EventType[];
const AT_WORK: readonly JobStatus[] = ['claimed', 'running', 'waiting_answer'];

/** Puts each artifact event of a job at work on its stream; the unsubscribe. */
export function streamArtifactEvents(o: {
  subscribe(l: (e: DomainEvent) => void): () => void;
  status(jobId: string): JobStatus | undefined;
  emit(jobId: string, type: string, payload: unknown): unknown;
  log(line: string): void;
}): () => void {
  return o.subscribe((e) => {
    if (!STREAMED.includes(e.type) || e.jobId === undefined) return;
    const status = o.status(e.jobId);
    if (status === undefined || !AT_WORK.includes(status)) return;
    try { o.emit(e.jobId, e.type, e.data); } catch (err) { o.log(`hopper: artifacts: ${e.type} not put on job ${e.jobId}'s stream: ${(err as Error).message}`); }
  });
}
