// Run again, the sync loop's half (issues #313, #354; a rejected job too, issue #387): an ended job's source gives its item back
// (`JobSource.rerun` — on GitHub a closed issue is reopened and the end labels go) and the new job is
// queued in the same step (`SourceHost.rerun`), so the user sees it at once. The sync loop (sync.ts)
// hands it the job's report chain.

import type { JobSource, RerunBy, RerunResult, SourceHost } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

export interface RerunContext {
  host: SourceHost;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  flagsOf(job: Job): { finalReported?: boolean };
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Sync the source at once, not waiting for the result. */
  syncSoon(source: JobSource): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRerun(c: RerunContext) {
  const store = c.host.store;
  const conflict = (jobId: string, why: string): RerunResult => ({ ok: false, reason: 'conflict', message: `job ${jobId} cannot run again: ${why}` });

  /** Why an ended job's item cannot run again now, or its source. */
  function check(jobId: string): RerunResult | JobSource {
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    if (job.status !== 'failed' && job.status !== 'finished' && job.status !== 'rejected') return conflict(jobId, `it is ${job.status}, not failed, finished or rejected`);
    const source = c.sourceOf(job);
    if (!source) return conflict(jobId, 'its source is not running');
    if (!source.rerun) return conflict(jobId, `its source ${source.name} cannot run an item again`);
    if (store.jobs.getBySourceKey(job.source!.key)?.id !== jobId) return conflict(jobId, 'a newer job of its item exists');
    if (!c.flagsOf(job).finalReported) return conflict(jobId, 'its end is not reported to its source yet');
    return source;
  }

  return {
    async rerun(jobId: string, by: RerunBy = 'user'): Promise<RerunResult> {
      const checked = check(jobId);
      if ('ok' in checked) return checked;
      let result: RerunResult = { ok: false, reason: 'source', message: 'not sent' };
      await c.enqueue(jobId, async () => {
        const source = check(jobId);
        if ('ok' in source) { result = source; return; }
        let item;
        try {
          item = await source.rerun!(store.jobs.get(jobId)!);
        } catch (e) {
          result = { ok: false, reason: 'source', message: `its source could not give the item back: ${message(e)}` };
          return;
        }
        result = { ok: true, job: c.host.rerun(jobId, item, { name: source.name, kind: source.kind }, by) };
      });
      // The new job's claim is reported at once, not at the next poll.
      if (result.ok) c.syncSoon(checked);
      return result;
    },
  };
}
