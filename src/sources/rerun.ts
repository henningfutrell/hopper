// Run again, the sync loop's half (issues #313, #348, #362): give a failed job's item back to its
// source, and keep on each failed job Run again may be asked of whether its item is closed
// (`sourceState.sync.itemClosed`), so the UI offers Run again only where it is taken. The sync loop
// (sync.ts) hands it the job's report chain and its own sync-flag writes.

import { SourceRefused } from '../domain/ports.ts';
import type { JobSource, RerunResult, SourceHost } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

type Flags = { finalReported?: boolean; itemClosed?: boolean };

export interface RerunContext {
  host: SourceHost;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  flagsOf(job: Job): Flags;
  /** Write the job's sync flags, keeping its source state. */
  writeFlags(jobId: string, flags: Flags): void;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Sync the source at once, not waiting for the result. */
  syncSoon(source: JobSource): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRerun(c: RerunContext) {
  const store = c.host.store;
  const conflict = (jobId: string, why: string): RerunResult => ({ ok: false, reason: 'conflict', message: `job ${jobId} cannot run again: ${why}` });
  const newest = (j: Job) => store.jobs.getBySourceKey(j.source!.key)?.id === j.id;

  function setItemClosed(jobId: string, closed: boolean) {
    const job = store.jobs.get(jobId);
    if (job && c.flagsOf(job).itemClosed !== closed) c.writeFlags(jobId, { ...c.flagsOf(job), itemClosed: closed });
  }

  /** Why a failed job's item cannot run again now, or its source. */
  function check(jobId: string): RerunResult | JobSource {
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    if (job.status !== 'failed') return conflict(jobId, `it is ${job.status}, not failed`);
    const source = c.sourceOf(job);
    if (!source) return conflict(jobId, 'its source is not running');
    if (!newest(job)) return conflict(jobId, 'a newer job of its item exists');
    if (!c.flagsOf(job).finalReported) return conflict(jobId, 'its failure is not reported to its source yet');
    return source;
  }

  return {
    async rerun(jobId: string): Promise<RerunResult> {
      const checked = check(jobId);
      if ('ok' in checked) return checked;
      let result: RerunResult = { ok: false, reason: 'source', message: 'not sent' };
      await c.enqueue(jobId, async () => {
        const source = check(jobId);
        if ('ok' in source) { result = source; return; }
        try {
          await source.report({ kind: 'rerun', job: store.jobs.get(jobId)! });
          result = { ok: true, job: c.host.rerun(jobId) };
        } catch (e) {
          if (e instanceof SourceRefused) { setItemClosed(jobId, true); result = conflict(jobId, e.message); return; }
          result = { ok: false, reason: 'source', message: `its source could not take the re-run: ${message(e)}` };
        }
      });
      if (result.ok) c.syncSoon(checked);
      return result;
    },

    /** Of the source's jobs, the newest failed job of each item, its failure reported: whether its item is closed, as the source tells it. */
    async markClosedItems(source: JobSource, jobs: Job[]): Promise<void> {
      if (!source.closedItems) return;
      const candidates = jobs.filter((j) => j.status === 'failed' && c.flagsOf(j).finalReported && newest(j));
      if (candidates.length === 0) return;
      const answers = await source.closedItems(candidates, new Set(candidates.filter((j) => c.flagsOf(j).itemClosed).map((j) => j.id)));
      for (const [jobId, closed] of answers) setItemClosed(jobId, closed);
    },
  };
}
