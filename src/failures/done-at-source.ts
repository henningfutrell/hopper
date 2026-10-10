// Finished work is never run again (issue #637): before any run again of a failed job — a retry, a redirect, a release,
// a person's Retry — its source is asked whether its work is done there (its issue closed as completed, a pull request
// that closes it ready or merged). Done: the job ends finished, its source told again, and its record `resolved`. And a
// done-check miss is looked at once more before it is assessed (`lookedAgain`): GitHub may show the work some seconds late.
import type { UserStore } from '../domain/ports.ts';
import type { FailureRecord, Job } from '../domain/types.ts';
import { BUILTIN_CAUSES } from './causes.ts';
import { PR_LOOKUP_MS } from './timeouts.ts';

const NOT_COMPLETE = BUILTIN_CAUSES.find((c) => c.id === 'not-complete')!.pattern;

/** A done-check miss not assessed yet, its source asked once more, at most `PR_LOOKUP_MS`: true, done. Not known is not done. */
export async function lookedAgain(store: Pick<UserStore, 'jobs'>, doneAtSource: ((job: Job) => Promise<boolean>) | undefined, jobId: string): Promise<boolean> {
  const job = store.jobs.get(jobId);
  if (!doneAtSource || job?.status !== 'failed' || job.assessment || !NOT_COMPLETE.test(job.error ?? '')) return false;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PR_LOOKUP_MS); });
  return Promise.race([doneAtSource(job), late]).catch(() => false).finally(() => clearTimeout(timer));
}

export const DONE_NOTE = 'done at its source: its issue is closed as completed, or a pull request that closes it is ready or merged';

export interface DoneAtSourceOptions {
  store: Pick<UserStore, 'jobs' | 'failures'>;
  /** Whether the job's work is done at its source. False: not done, or its source does not judge. Throws: not known. */
  doneAtSource?(job: Job): Promise<boolean>;
  /** Finish a failed job whose work shipped, its end told to its source again. False: it is no longer failed. */
  finishShipped(jobId: string, result: { summary: string }): boolean;
  now(): Date;
  live(): boolean;
}

export interface DoneAtSource {
  /** Before a pending run again: true when it must not run — finished, or put off `laterMs` while its source cannot tell. */
  beforeRun(r: FailureRecord, laterMs: number): Promise<boolean>;
  /** A person's Retry: `go`, unless refused — finished, or its source cannot tell. */
  unlessDone<T>(recordId: string, go: () => Promise<T>): Promise<T | { ok: false; reason: 'conflict'; message: string }>;
}

export function createDoneAtSource(o: DoneAtSourceOptions): DoneAtSource {
  /** Finish the record's job when its work is done at its source. True: finished. A throw: not known. */
  const finishedIfDone = async (r: FailureRecord): Promise<boolean> => {
    const job = o.store.jobs.get(r.jobId);
    if (!o.doneAtSource || job?.status !== 'failed' || !await o.doneAtSource(job) || !o.live()) return false;
    if (!o.finishShipped(job.id, { summary: DONE_NOTE })) return false;
    o.store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: 'resolved', outcomeAt: o.now().toISOString(), note: DONE_NOTE });
    return true;
  };
  const notKnown = (e: unknown): string => `could not tell whether its work is done: ${e instanceof Error ? e.message : String(e)}`;
  return {
    async beforeRun(r, laterMs) {
      try {
        return await finishedIfDone(r);
      } catch (e) {
        o.store.failures.update(r.id, { pendingAt: new Date(o.now().getTime() + laterMs).toISOString(), note: notKnown(e) });
        return true;
      }
    },
    async unlessDone(recordId, go) {
      const r = o.store.failures.get(recordId);
      const done = r ? await finishedIfDone(r).catch((e: unknown) => notKnown(e)) : false;
      if (done === false) return go();
      return { ok: false, reason: 'conflict', message: `failure ${recordId} needs no run again: ${done === true ? `its job is ${DONE_NOTE}` : done}` };
    },
  };
}
