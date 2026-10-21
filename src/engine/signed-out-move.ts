// The signed-out move (issue #1211, design.md "The signed-out move"): on each tick, a job held on a not-signed-in question
// (`NOT_SIGNED_IN`) on a machine whose tool reads signed out goes on at another machine that reads the tool signed in, with
// no person. The hopper parks it as the Park button does (`recordPark`, its pane and agent ended), answers its question as
// `SIGNED_OUT_MOVE_BY`, and picks it up to resume elsewhere from its checkpoint (`recordUnpark`, elsewhere): the decider
// then places it on a signed-in machine. A job whose agent never got its task (no agent session, or a checkpoint with no
// session, no commit and no change) has no work to keep: it is queued to start again, not pinned. A job the move cannot
// checkpoint stays on its question for the sign-in, and is tried again after a while.
import { gunzipSync } from 'node:zlib';
import { signedInOf, signedOutMove, signedOutOf } from '../decider/signed-out.ts';
import { NOT_SIGNED_IN, SIGNED_OUT_MOVE_BY, signedOutMoveAnswer, type Job, type JobCheckpoint, type Question } from '../domain/types.ts';
import type { EngineContext } from './context.ts';
import { finishLeftMoves, finishMove } from './move-finish.ts';
import { parkRefusal, recordPark } from './park.ts';

/** A job the move could not checkpoint is tried again after this long. */
export const MOVE_RETRY_MS = 10 * 60_000;

/** The not-signed-in question the job waits on, open, and the machine that raised it; undefined: none. */
function heldOn(c: Pick<EngineContext, 'store'>, job: Job): { q: Question; from: string } | undefined {
  const q = job.questionId ? c.store.questions.get(job.questionId) : undefined;
  const from = q?.raisedBy?.machineId;
  if (q?.status !== 'open' || !from || !q.text.startsWith(NOT_SIGNED_IN)) return undefined;
  return { q, from };
}

/** A checkpoint of a job whose agent never got its task: no session, no commit, no change. */
function untouched(c: Pick<EngineContext, 'store'>, job: Job, k: JobCheckpoint): boolean {
  if (k.session || k.commits.length > 0 || k.head !== k.base) return false;
  const kept = c.store.checkpoints.get(job.id);
  return kept !== undefined && gunzipSync(kept.patch).length === 0;
}

/**
 * How the job moves: from its checkpoint, or as a new start; undefined: it cannot move now. `waits`: what it waits on, for
 * the log. The busy-machine move (issue #1977) asks it too.
 */
export async function howToMove(c: EngineContext, job: Job, waits = 'waits on a sign-in'): Promise<'checkpoint' | 'fresh' | undefined> {
  if (job.agentSession === undefined) return 'fresh';
  const k = await c.checkpoints?.take(job.id);
  if (k === undefined || typeof k === 'string') {
    if (!c.stopping()) console.warn(`hopper: job ${job.id} ${waits}, and could not move: its checkpoint ${k ?? 'is not kept by this hopper'}`);
    return undefined;
  }
  if (k.session) return 'checkpoint';
  if (untouched(c, job, k)) return 'fresh';
  console.warn(`hopper: job ${job.id} ${waits}, and could not move: its checkpoint holds work but no agent session`);
  return undefined;
}

/** The signed-out move: one pass over the jobs on a question. `tried`: when each job last failed to move. */
export function createSignedOutMove(c: EngineContext): () => Promise<void> {
  const tried = new Map<string, number>();
  return async function move(): Promise<void> {
    const { store } = c;
    // A move a stop cut short first (issue #1892), whatever the sign-ins read now.
    if (await finishLeftMoves(c, 'signed_out')) c.trigger('signed_out.move');
    const states = c.usage().map((u) => ({ name: u.name, state: u.state?.() }));
    const out = signedOutOf(states);
    if (out.length === 0) return;
    const signedIn = signedInOf(states);
    const machines = await c.machines.list();
    const now = c.clock.now().getTime();
    for (const [id, at] of tried) if (now - at >= MOVE_RETRY_MS) tried.delete(id);
    for (const waiting of store.jobs.list({ status: ['waiting_answer'] })) {
      if (c.stopping()) return;
      if (tried.has(waiting.id)) continue;
      const held = heldOn(c, waiting);
      const moving = held && !parkRefusal(c, waiting) ? signedOutMove(waiting, held.from, machines, out, signedIn) : undefined;
      if (!held || !moving) continue;
      const how = await howToMove(c, waiting);
      if (!how) {
        tried.set(waiting.id, now);
        continue;
      }
      const answer = signedOutMoveAnswer(held.from, moving.tool.service);
      const reason = `${moving.tool.service} reads signed out on ${held.from} (usage source ${moving.tool.source}); signed in on ${moving.to.join(', ')}`;
      const parked = store.tx(() => {
        // Read again in the tx: a sign-in or a person may have answered it meanwhile.
        const job = store.jobs.get(waiting.id);
        if (job?.status !== 'waiting_answer' || job.questionId !== held.q.id || store.questions.get(held.q.id)?.status !== 'open') return undefined;
        recordPark(c, job, 'waiting_answer', undefined, undefined, undefined, { kind: 'signed_out', how, live: true });
        // A job on a question holds no lane: the machine it leaves is the question's, which its pick up names.
        const p = store.jobs.update(job.id, { resumeOn: held.from });
        // Parked, so the answer is kept for its pick up (`onAnswered`), not sent to the pane.
        c.questions.settleWith(held.q.id, answer, SIGNED_OUT_MOVE_BY, reason);
        return p;
      });
      if (!parked || !await finishMove(c, parked)) continue;
      c.trigger('signed_out.move');
    }
  };
}
