// One daemon-log line per failed job (stderr → journald). A failure never goes to the job's
// source; the log, the UI event feed and /api/jobs `error` are where it shows.
import type { UserStore } from '../domain/ports.ts';

export function logFailures(store: Pick<UserStore, 'events' | 'jobs'>): () => void {
  return store.events.subscribe((e) => {
    if (e.type !== 'job.failed' || !e.jobId) return;
    const where = store.jobs.get(e.jobId)?.source?.url;
    console.error(`hopper: job ${e.jobId} failed${where ? ` (${where})` : ''}: ${String(e.data.error)}`);
  });
}
