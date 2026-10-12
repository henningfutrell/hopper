// Job checkpoints (issue #921, design.md "Checkpoints and resume elsewhere"): while a job is at work, every
// CHECKPOINT_EVERY_MS its executor reads its agent session and its work not pushed on its machine, through the machine's
// own connection; the hopper scrubs both of secrets and keeps the latest, so the job can resume on another machine when
// its own is lost. One more is taken when a job is parked, once its agent has ended. A checkpoint of a job that ended
// goes after CHECKPOINT_KEEP_MS.
import { gunzipSync, gzipSync } from 'node:zlib';
import type { JobCheckpoint } from '../domain/checkpoints.ts';
import { CHECKPOINT_COMMITS } from '../domain/checkpoints.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import { scrubPatch, scrubSessionLog } from '../secrets/mask.ts';
import { nowIso, type EngineContext } from './context.ts';

/** How often a job at work is checkpointed. */
export const CHECKPOINT_EVERY_MS = 10 * 60000;
/** How often the engine looks for jobs due a checkpoint. */
export const CHECKPOINT_CHECK_MS = 60000;
/** How long a checkpoint is kept after its job ended. */
export const CHECKPOINT_KEEP_MS = 7 * 24 * 3600000;
/** The most a scrubbed part may grow to once unpacked: a checkpoint is at most 10 MiB compressed. */
const MAX_UNPACKED = 512 * 1024 * 1024;

/** A job at work: its agent and work tree are live on its machine. */
const AT_WORK: readonly Job['status'][] = ['running', 'waiting_answer', 'waiting_on'];

export interface Checkpoints {
  /** One pass: each job at work whose last checkpoint (or try) is CHECKPOINT_EVERY_MS old is checkpointed; old ones go. */
  run(): Promise<void>;
  /** Take the job's checkpoint now: the one taken, or why none was. Never throws. */
  take(jobId: string): Promise<JobCheckpoint | string>;
}

const machineOf = (c: Pick<EngineContext, 'store'>, job: Job): string =>
  (job.laneId ? c.store.lanes.list().find((l) => l.id === job.laneId)?.machineId : undefined) ?? job.resumeOn ?? job.spec.machineId ?? 'local';

/** A part scrubbed of secrets (`scrub`), compressed again. `latin1` keeps a patch's bytes as they were. */
const scrubbed = (gz: Buffer, scrub: (text: string) => string, encoding: BufferEncoding): Buffer =>
  gzipSync(Buffer.from(scrub(gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }).toString(encoding)), encoding));

export function createCheckpoints(c: Pick<EngineContext, 'store' | 'executors' | 'clock' | 'stopping'>, everyMs = CHECKPOINT_EVERY_MS): Checkpoints {
  const { store } = c;
  const inFlight = new Set<string>();
  /** When each job's checkpoint was last tried, taken or not: a machine that cannot be reached is not asked every pass. */
  const tried = new Map<string, number>();

  async function take(jobId: string): Promise<JobCheckpoint | string> {
    const job = store.jobs.get(jobId);
    if (!job) return `job ${jobId} not found`;
    const executor = c.executors.get(job.spec.executor);
    if (!executor?.checkpoint) return `its executor ${job.spec.executor} takes no checkpoint`;
    if (inFlight.has(jobId)) return 'a checkpoint of it is being taken';
    inFlight.add(jobId);
    tried.set(jobId, c.clock.now().getTime());
    try {
      const got = await executor.checkpoint(job);
      if (!got) return 'it has no agent session or worktree of its own to checkpoint';
      if ('none' in got) return got.none;
      const patch = scrubbed(got.taken.patch, scrubPatch, 'latin1');
      const session = got.taken.session ? scrubbed(got.taken.session, scrubSessionLog, 'utf8') : undefined;
      if (c.stopping()) return 'the hopper stops';
      return store.tx(() => {
        const now = store.jobs.get(jobId);
        // Ended meanwhile: nothing to resume.
        if (!now || TERMINAL_STATUSES.includes(now.status)) return `job ${jobId} ended meanwhile`;
        const at = nowIso(c);
        const k: JobCheckpoint = {
          at, machineId: machineOf(c, now), ...(got.taken.branch ? { branch: got.taken.branch } : {}), base: got.taken.base, head: got.taken.head,
          commits: got.taken.commits.slice(0, CHECKPOINT_COMMITS), bytes: patch.length + (session?.length ?? 0), session: session !== undefined,
        };
        store.checkpoints.put({ jobId, at, patch, ...(session ? { session } : {}) });
        store.jobs.update(jobId, { checkpoint: k });
        store.events.append({ type: 'job.checkpointed', jobId, data: { machineId: k.machineId, bytes: k.bytes, session: k.session, commits: k.commits.length } });
        return k;
      });
    } catch (e) {
      return `its machine could not be reached: ${(e as Error).message}`;
    } finally {
      inFlight.delete(jobId);
    }
  }

  return {
    take,
    async run() {
      const now = c.clock.now().getTime();
      for (const job of store.jobs.list({ status: [...AT_WORK] })) {
        if (c.stopping()) return;
        if (!c.executors.get(job.spec.executor)?.checkpoint) continue;
        const last = Math.max(job.checkpoint ? Date.parse(job.checkpoint.at) : 0, tried.get(job.id) ?? 0);
        if (now - last < everyMs) continue;
        const said = await take(job.id);
        if (typeof said === 'string' && !c.stopping()) console.warn(`hopper: no checkpoint of job ${job.id}: ${said}`);
      }
      for (const id of store.checkpoints.jobIds()) {
        const job = store.jobs.get(id);
        const ended = job && TERMINAL_STATUSES.includes(job.status) ? Date.parse(job.finishedAt ?? job.updatedAt) : undefined;
        if (!job || (ended !== undefined && now - ended >= CHECKPOINT_KEEP_MS)) store.checkpoints.remove(id);
      }
      for (const id of tried.keys()) if (!store.jobs.get(id) || !AT_WORK.includes(store.jobs.get(id)!.status)) tried.delete(id);
    },
  };
}
