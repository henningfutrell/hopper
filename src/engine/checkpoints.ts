// Job checkpoints (issue #921, design.md "Checkpoints and resume elsewhere"): while a job is at work, every
// CHECKPOINT_EVERY_MS its executor reads its agent session and its work not pushed on its machine, through the machine's
// own connection; the hopper scrubs both of secrets — by pattern, and the vault secrets delivered to the job by value
// (issue #1957) — and keeps the latest, so the job can resume on another machine when
// its own is lost. One more is taken when a job is parked, once its agent has ended. A checkpoint of a job that ended
// goes after CHECKPOINT_KEEP_MS. One more at a missed heartbeat of its machine (issue #1569, `soon`): before its link
// drops, while the machine may still answer, so a move elsewhere loses less than ten minutes of work. The scrub runs in a worker thread (checkpoint-scrub.ts, issue #1154), off the event loop.
// A checkpoint the same as the last one kept (issue #1975: a job that waits changes nothing) is not kept again: no event.
// Each read of the session keeps its token use in the token ledger (issue #2302), counts only; `tokens` reads it once more
// as a run ends, so the ledger holds the run's last turns, and keeps nothing else.
import type { JobCheckpoint } from '../domain/checkpoints.ts';
import { withTurnUse, type SessionTokenUse } from '../domain/token-usage.ts';
import { CHECKPOINT_COMMITS } from '../domain/checkpoints.ts';
import { PROXY_PUSH_EVENTS, PUSHES_READ, pushedBranchOf } from '../domain/kept-work.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import { scrubCheckpoint } from './checkpoint-scrub.ts';
import { nowIso, type EngineContext } from './context.ts';

/** How often a job at work is checkpointed. */
export const CHECKPOINT_EVERY_MS = 10 * 60000;
/** How often the engine looks for jobs due a checkpoint. */
export const CHECKPOINT_CHECK_MS = 60000;
/** How long a checkpoint is kept after its job ended. */
export const CHECKPOINT_KEEP_MS = 7 * 24 * 3600000;
/** The least time between two checkpoints taken at missed heartbeats: a flaky link is not read over and over. */
export const CHECKPOINT_SOON_GAP_MS = 60000;
/** A job at work: its agent and work tree are live on its machine. */
const AT_WORK: readonly Job['status'][] = ['running', 'waiting_answer', 'waiting_on'];

export interface Checkpoints {
  /** One pass: each job at work whose last checkpoint (or try) is CHECKPOINT_EVERY_MS old is checkpointed; old ones go. */
  run(): Promise<void>;
  /** Take the job's checkpoint now: the one taken, or why none was. Never throws. */
  take(jobId: string): Promise<JobCheckpoint | string>;
  /**
   * A missed heartbeat of the job's machine (issue #1569): take its checkpoint now, unless one is being taken or was tried
   * less than CHECKPOINT_SOON_GAP_MS ago. Does not wait for it; never throws.
   */
  soon(jobId: string): void;
  /** The job's token use read on its machine now, as its run ends, and kept in the token ledger: no checkpoint. Never throws. */
  tokens(jobId: string): Promise<void>;
}

const machineOf = (c: Pick<EngineContext, 'store'>, job: Job): string =>
  (job.laneId ? c.store.lanes.list().find((l) => l.id === job.laneId)?.machineId : undefined) ?? job.resumeOn ?? job.spec.machineId ?? 'local';

/** The checkpoint taken is the one kept: the same commits, patch and agent session (both gzip, which is deterministic). */
const unchanged = (k: JobCheckpoint, kept: { patch: Buffer; session?: Buffer }, taken: Omit<JobCheckpoint, 'at' | 'machineId' | 'bytes' | 'session'>, patch: Buffer, session: Buffer | undefined): boolean =>
  k.branch === taken.branch && k.pushedTo === taken.pushedTo && k.base === taken.base && k.head === taken.head && k.commits.join('\n') === taken.commits.slice(0, CHECKPOINT_COMMITS).join('\n')
  && kept.patch.equals(patch) && (kept.session && session ? kept.session.equals(session) : kept.session === session);

/**
 * A session's token use kept in the ledger: where it was read, and who that machine's Claude was signed in as then. `turn`:
 * a print-mode turn's own use (part 6), added to what the ledger holds of the session, since its answer counts that turn only.
 */
export function keepTokenUse(c: Pick<EngineContext, 'store' | 'clock'>, job: Job, session: string, use: SessionTokenUse, turn = false): void {
  const machineId = machineOf(c, job);
  const account = c.store.lastAccounts.get(machineId, 'claude')?.identity;
  const whole = turn ? withTurnUse(c.store.tokenLedger.list({ jobId: job.id }).filter((e) => e.session === session), use) : use;
  c.store.tokenLedger.put(job.id, session, whole, { readAt: nowIso(c), machineId, ...(job.laneId ? { laneId: job.laneId } : {}), ...(account ? { account } : {}) });
}

/**
 * `spent`: told after a checkpoint kept a job's token use, while the job may still run (issue #2302, part 3: the budget
 * pause looks at it there). True: the job is near its budget (issue #2848 part 3), and is checkpointed every
 * CHECKPOINT_SOON_GAP_MS until a checkpoint says it is not, so it goes over its budget by a minute's spend at most.
 */
export function createCheckpoints(c: Pick<EngineContext, 'store' | 'executors' | 'clock' | 'stopping' | 'deliveredSecrets'>, everyMs = CHECKPOINT_EVERY_MS, spent?: (jobId: string) => boolean): Checkpoints {
  const { store } = c;
  const inFlight = new Set<string>();
  /** When each job's checkpoint was last tried, taken or not: a machine that cannot be reached is not asked every pass. */
  const tried = new Map<string, number>();
  /** The jobs near their budget. */
  const near = new Set<string>();

  const keepUse = (job: Job, use: SessionTokenUse | undefined): void => { if (use && job.agentSession) keepTokenUse(c, job, job.agentSession, use); };

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
      // The vault secrets delivered to the job, masked by value: no pattern knows one (issue #1957).
      const held = await c.deliveredSecrets(jobId);
      const { patch, session, use } = await scrubCheckpoint({ patch: got.taken.patch, ...(got.taken.session ? { session: got.taken.session } : {}), ...(got.taken.subagents ? { subagents: got.taken.subagents } : {}), held });
      if (c.stopping()) return 'the hopper stops';
      const kept = store.tx(() => {
        const now = store.jobs.get(jobId);
        // What it spent is kept even when it ended meanwhile.
        if (now) keepUse(now, use);
        // Ended meanwhile: nothing to resume.
        if (!now || TERMINAL_STATUSES.includes(now.status)) return `job ${jobId} ended meanwhile`;
        const last = store.checkpoints.get(jobId);
        // Issue #2459: commits the hopper pushed for the job are pushed, whatever the worktree's remote branches say.
        const pushedTo = got.taken.head !== got.taken.base ? pushedBranchOf(store.events.recent(PUSHES_READ, [...PROXY_PUSH_EVENTS], jobId), got.taken.head, got.taken.branch) : undefined;
        const taken = { ...got.taken, ...(pushedTo ? { pushedTo } : {}) };
        if (now.checkpoint && last && now.checkpoint.machineId === machineOf(c, now) && unchanged(now.checkpoint, last, taken, patch, session)) return now.checkpoint;
        const at = nowIso(c);
        const k: JobCheckpoint = {
          at, machineId: machineOf(c, now), ...(got.taken.branch ? { branch: got.taken.branch } : {}), base: got.taken.base, head: got.taken.head,
          ...(pushedTo ? { pushedTo } : {}), commits: got.taken.commits.slice(0, CHECKPOINT_COMMITS), bytes: patch.length + (session?.length ?? 0), session: session !== undefined,
        };
        store.checkpoints.put({ jobId, at, patch, ...(session ? { session } : {}) });
        store.jobs.update(jobId, { checkpoint: k });
        store.events.append({ type: 'job.checkpointed', jobId, data: { machineId: k.machineId, bytes: k.bytes, session: k.session, commits: k.commits.length } });
        return k;
      });
      if (use && spent) { if (spent(jobId)) near.add(jobId); else near.delete(jobId); }
      return kept;
    } catch (e) {
      // The error says where it failed: a machine not reached, or a script that ran there and refused (issue #1353).
      return `it could not be taken: ${(e as Error).message}`;
    } finally {
      inFlight.delete(jobId);
    }
  }

  return {
    take,
    async tokens(jobId) {
      const job = store.jobs.get(jobId);
      const executor = job ? c.executors.get(job.spec.executor) : undefined;
      if (!job?.agentSession || !executor?.checkpoint || inFlight.has(jobId)) return;
      inFlight.add(jobId);
      try {
        const got = await executor.checkpoint(job);
        if (!got || 'none' in got || !got.taken.session || c.stopping()) return;
        const { use } = await scrubCheckpoint({ patch: Buffer.alloc(0), session: got.taken.session, ...(got.taken.subagents ? { subagents: got.taken.subagents } : {}), countOnly: true });
        if (!c.stopping()) store.tx(() => { const now = store.jobs.get(jobId); if (now) keepUse(now, use); });
      } catch (e) {
        console.warn(`hopper: no token use read for job ${jobId} as its run ends: ${(e as Error).message}`);
      } finally {
        inFlight.delete(jobId);
      }
    },
    soon(jobId) {
      const job = store.jobs.get(jobId);
      if (!job || !AT_WORK.includes(job.status) || inFlight.has(jobId) || c.stopping()) return;
      const last = Math.max(job.checkpoint ? Date.parse(job.checkpoint.at) : 0, tried.get(jobId) ?? 0);
      if (c.clock.now().getTime() - last < CHECKPOINT_SOON_GAP_MS) return;
      void take(jobId).then((said) => {
        if (typeof said === 'string' && !c.stopping()) console.warn(`hopper: no checkpoint of job ${jobId} at a missed heartbeat: ${said}`);
      });
    },
    async run() {
      const now = c.clock.now().getTime();
      for (const job of store.jobs.list({ status: [...AT_WORK] })) {
        if (c.stopping()) return;
        if (!c.executors.get(job.spec.executor)?.checkpoint) continue;
        const last = Math.max(job.checkpoint ? Date.parse(job.checkpoint.at) : 0, tried.get(job.id) ?? 0);
        if (now - last < (near.has(job.id) ? Math.min(everyMs, CHECKPOINT_SOON_GAP_MS) : everyMs)) continue;
        const said = await take(job.id);
        if (typeof said === 'string' && !c.stopping()) console.warn(`hopper: no checkpoint of job ${job.id}: ${said}`);
      }
      for (const id of store.checkpoints.jobIds()) {
        const job = store.jobs.get(id);
        const ended = job && TERMINAL_STATUSES.includes(job.status) ? Date.parse(job.finishedAt ?? job.updatedAt) : undefined;
        if (!job || (ended !== undefined && now - ended >= CHECKPOINT_KEEP_MS)) store.checkpoints.remove(id);
      }
      for (const id of tried.keys()) if (!store.jobs.get(id) || !AT_WORK.includes(store.jobs.get(id)!.status)) { tried.delete(id); near.delete(id); }
    },
  };
}
