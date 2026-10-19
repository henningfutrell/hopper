// Finished work is never run again (issue #637): before any run again of a failed job — a retry, a redirect, a release,
// a person's Retry — its source is asked whether its work is done there (its issue closed as completed, a pull request
// that closes it ready or merged). Done: the job ends finished, its source told again, and its record `resolved`. And a
// failed job is looked at once more before it is assessed (`lookedAgain`): GitHub may show the work some seconds late, and
// a job may end failed after it delivered, on a check its machine could not make (issue #2040); a done-check miss's work too (`workCause`, issue #1522): the job's own pull request unfinished or red is the hopper's to finish.
import type { UserStore } from '../domain/ports.ts';
import type { FailureRecord, Job, KnownCause, WorkState } from '../domain/types.ts';
import { BUILTIN_CAUSES, builtinCause, OWN_PR_UNFINISHED, ownPullRequestCause } from './causes.ts';
import { PR_LOOKUP_MS } from './timeouts.ts';

const NOT_COMPLETE = BUILTIN_CAUSES.find((c) => c.id === 'not-complete')!.pattern;

/**
 * A failed job not assessed yet, whatever its failure says (issue #2040), its source asked once more, at most
 * `PR_LOOKUP_MS`: true, done. Not known is not done.
 */
export async function lookedAgain(store: Pick<UserStore, 'jobs'>, doneAtSource: ((job: Job) => Promise<boolean>) | undefined, jobId: string): Promise<boolean> {
  const job = store.jobs.get(jobId);
  if (!doneAtSource || job?.status !== 'failed' || job.assessment) return false;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PR_LOOKUP_MS); });
  return Promise.race([doneAtSource(job), late]).catch(() => false).finally(() => clearTimeout(timer));
}

/**
 * A done-check miss not assessed yet, its work asked at its source, at most `PR_LOOKUP_MS` (issue #1522): the cause its work
 * shows — the job's own pull request unfinished or with red checks —, whatever the miss's text says. Not known: undefined.
 */
export async function workCause(store: Pick<UserStore, 'jobs'>, workState: WorkReads, jobId: string): Promise<ReturnType<typeof ownPullRequestCause>> {
  const job = store.jobs.get(jobId);
  if (job?.status !== 'failed' || job.assessment || !NOT_COMPLETE.test(job.error ?? '')) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), PR_LOOKUP_MS); });
  const work = await Promise.race([workState(job), late]).catch(() => undefined).finally(() => clearTimeout(timer));
  return work ? ownPullRequestCause(work) : undefined;
}

type WorkReads = (job: Job) => Promise<Omit<WorkState, 'checkedAt'> | undefined>;

/**
 * The work look before an assessment (issue #1522): `look` asks a done-check miss's work (`workCause`) unless `skip`;
 * `causeOf` takes what it showed, once, and puts it in place of a Not complete, with the reason it adds.
 */
export function createWorkLook(o: { store: Pick<UserStore, 'jobs'>; workState: WorkReads; skip(jobId: string): boolean; live(): boolean }) {
  const shown = new Map<string, NonNullable<ReturnType<typeof ownPullRequestCause>>>();
  return {
    async look(jobId: string): Promise<void> {
      if (!o.live() || o.skip(jobId)) return;
      const c = await workCause(o.store, o.workState, jobId);
      if (c && o.live()) shown.set(jobId, c);
    },
    causeOf(jobId: string, matched: KnownCause | undefined): { cause: KnownCause | undefined; reason?: string } {
      const c = shown.get(jobId);
      shown.delete(jobId);
      if (!c || matched?.id !== 'not-complete') return { cause: matched };
      const what = c === OWN_PR_UNFINISHED ? 'with merge conflicts or as a draft' : 'with red checks';
      return { cause: builtinCause(c), reason: `its work shows its own pull request ${what}, whatever the failure text says` };
    },
  };
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
  /** A person's Retry: `go`, unless refused — finished. A source that cannot tell does not hold it: the person decides (issue #855). */
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
      if (!r || !await finishedIfDone(r).catch(() => false)) return go();
      return { ok: false, reason: 'conflict', message: `failure ${recordId} needs no run again: its job is ${DONE_NOTE}` };
    },
  };
}
