// Parking a job (issue #501, design.md "Parked jobs"): a person takes a running job, or one on a question, out of
// its lane for an open-ended time. The lane frees in the transaction that parks it; the executor then ends its pane
// and agent and stops its processes, keeping its work tree and agent session. Re-queued, it waits pinned to its
// machine (`resumeOn`) with an answer pending — the one given while it was parked, else PARKED_RESUME — so its claim
// resumes the agent session there; with its question still open, it waits on the question again. A job whose executor
// recorded no agent session (one started before #510) parks the same way; its re-queue, confirmed by the person, starts a
// fresh session in its kept work tree, told the task, its question and the answer (issue #530). A job with a checkpoint
// that holds its agent session may instead be picked up to resume elsewhere (issue #921): not pinned to its machine,
// its claim rebuilds its work tree from the checkpoint wherever it runs, and the agent is told so (`elsewhereBrief`). Issue
// #2335: once the checkpoint taken after its park is marked, every re-queue of it does so, a person's or the hopper's.
// Issue #2415: a job auto-park parked on a person is not re-queued: it would only park again; the answer picks it up.
import { REVIEW_SECTIONS, type Job, type LaneId } from '../domain/types.ts';
import { HUMAN } from '../questions/service.ts';
import type { JobCheckpoint, ParkedMove } from '../domain/checkpoints.ts';
import { parkAskOf, type ParkAsk } from '../domain/park-ask.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { releaseLane } from './outcome.ts';
import { openItemOf } from './reviews.ts';
import { jobSpend } from './token-budget.ts';

/** What the resumed agent session is told when no answer waits for it: it was parked, and goes on. */
export const PARKED_RESUME = 'This job was parked and is resumed now, in the same session and work tree. Go on with it where you left off.';

const PARKABLE = new Set<Job['status']>(['running', 'waiting_answer']);

/**
 * What a parked job waits on a person for (issue #2415), or undefined: its open question with a person, or its proposal
 * or research report at the human stage. Picked up, such a job waits on it again, and auto-park parks it again.
 */
export function personWaitOf(c: EngineContext, job: Job): string | undefined {
  const q = job.questionId ? c.store.questions.get(job.questionId) : undefined;
  if (q?.status === 'open') return q.tier === HUMAN ? 'question' : undefined;
  const item = openItemOf(c, job);
  return item?.stage === HUMAN ? REVIEW_SECTIONS[item.kind].noun : undefined;
}

/** Why the job cannot be parked, or undefined: running or on a question, its executor able to park. With or without an agent session (issue #530). */
export function parkRefusal(c: Pick<EngineContext, 'executors'>, job: Job): string | undefined {
  if (!PARKABLE.has(job.status)) return `job ${job.id} is ${job.status}: only a running job or one on a question can be parked`;
  if (!c.executors.get(job.spec.executor)?.park) return `job ${job.id}: executor ${job.spec.executor} cannot park a job`;
  return undefined;
}

/** A parked job with no agent session to resume (issue #530): its re-queue starts a fresh one, and only once the person confirms it. */
export const startsFresh = (job: Job): boolean => job.parked !== undefined && job.agentSession === undefined;

/**
 * What a parked job starting a fresh agent session is told after its task (issue #530): it has none of the earlier
 * session's history, its work tree is as that session left it, and — when it was parked on a question — the question
 * and the answer it got. `answer` is the answer pending, PARKED_RESUME when none was given.
 */
export function freshStartBrief(c: Pick<EngineContext, 'store'>, job: Job, answer: string): string {
  const q = job.questionId && job.parked?.from === 'waiting_answer' ? c.store.questions.get(job.questionId) : undefined;
  const lines = [
    'This job was parked and is re-queued now. Its earlier agent session was not recorded, so this is a fresh session: you have none of its history.',
    'You are in the job\'s kept work tree, with its branch and the work the earlier session left there. Look at what is there first (git status, git log, the files changed) and go on from it; do not start over.',
  ];
  if (q) lines.push('', 'Before it was parked, the job asked:', q.text, '', answer === PARKED_RESUME ? 'It got no answer.' : 'The answer:', ...(answer === PARKED_RESUME ? [] : [answer]));
  else lines.push('', 'It was parked in the middle of its work.');
  return lines.join('\n');
}

/**
 * Inside a tx: the job parked from `from`, its lane (if any) freed. Its question, if open, stays open. `why`: auto-park
 * parked it (issue #650), and this says why. `ask` (issue #2167): who parked it and why; a running job's comes from its
 * `parkAsk`, kept when the person asked. `move` (issue #1892): the hopper parks it to move it off its machine, kept on the
 * job until its pick up and named on `job.parked`, so its item goes back to the queue, not to a person.
 */
export function recordPark(c: EngineContext, job: Job, from: 'running' | 'waiting_answer', laneId?: LaneId, why?: string, ask?: ParkAsk, move?: ParkedMove): Job {
  const { store } = c;
  const at = nowIso(c);
  const lane = laneId ? store.lanes.list().find((l) => l.id === laneId) : undefined;
  const machineId = lane?.machineId ?? job.resumeOn ?? job.spec.machineId;
  const by = why ? {} : parkAskOf(ask ?? store.jobs.get(job.id)?.parkAsk);
  const parked = store.jobs.update(job.id, {
    status: 'parked', laneId: undefined, parked: { at, from, ...(why ? { auto: true as const, why } : {}), ...by, ...(move ? { move } : {}) }, ...(machineId ? { resumeOn: machineId } : {}),
    holdReason: undefined, waitReason: undefined, parkAsk: undefined,
  });
  store.events.append({ type: 'job.parked', jobId: job.id, ...(laneId ? { laneId } : {}), data: { from, ...(machineId ? { machineId } : {}), ...(why ? { auto: true, why } : {}), ...by, ...(move ? { move: move.kind } : {}) } });
  releaseLane(c, lane, at);
  return parked;
}

/**
 * After the commit: the executor ends the job's pane and agent, then its checkpoint is taken (issue #921), its agent
 * session whole now. A checkpoint with the session is marked on the park (`parked.checkpointAt`, issue #2335): its re-queue
 * then resumes it on any machine. `paneless`: its pane ended at an earlier park, and its id may name another job's pane
 * by now, so the executor is not asked. Never throws; what it cannot reach, the sweep stops, and the last checkpoint stands.
 */
export async function releaseParked(c: Pick<EngineContext, 'executors' | 'stopping' | 'checkpoints' | 'store'>, job: Job, paneless = false): Promise<void> {
  try {
    if (!paneless) await c.executors.get(job.spec.executor)?.park?.(job);
  } catch (e) {
    if (!c.stopping()) console.warn(`hopper: job ${job.id} parked, but its machine could not be reached to end its agent: ${(e as Error).message}; the sweep stops it`);
    return;
  }
  // Not waited on: the runner that parked the job ends now; the checkpoint lands when it is read.
  if (c.checkpoints && !c.stopping()) void c.checkpoints.take(job.id).then((k) => markParked(c, job, k), () => undefined);
}

/** The checkpoint taken after the park, marked on it while the job is still parked from that park. */
function markParked(c: Pick<EngineContext, 'store'>, job: Job, k: JobCheckpoint | string): void {
  if (typeof k === 'string' || !k.session) return;
  c.store.tx(() => {
    const now = c.store.jobs.get(job.id);
    if (now?.status === 'parked' && now.parked?.at === job.parked?.at) c.store.jobs.update(job.id, { parked: { ...now.parked!, checkpointAt: k.at } });
  });
}

/**
 * Whether the parked job resumes on any machine (issue #2335): the checkpoint taken after its park, with its agent session,
 * is still its checkpoint, and its spec pins it to no machine.
 */
const unpinned = (job: Job): boolean => job.parked?.checkpointAt !== undefined && job.checkpoint?.at === job.parked.checkpointAt
  && job.checkpoint.session && job.agentSession !== undefined && job.spec.machineId === undefined;

/** Why the job cannot resume elsewhere (issue #921), or undefined: parked, with a checkpoint that holds its agent session. */
export function elsewhereRefusal(job: Job): string | undefined {
  if (job.status !== 'parked') return `job ${job.id} is ${job.status}: only a parked job can resume elsewhere`;
  if (!job.checkpoint) return `job ${job.id} has no checkpoint to resume elsewhere from`;
  if (!job.checkpoint.session || !job.agentSession) return `job ${job.id}'s checkpoint holds no agent session to resume`;
  return undefined;
}

/**
 * What a job resuming elsewhere is told (issue #921): it moved, its work tree was rebuilt from its checkpoint, the
 * commits not pushed then are uncommitted changes now, and work after the checkpoint is lost; then the answer, if any.
 */
export function elsewhereBrief(job: Job, answer: string): string {
  const k = job.checkpoint;
  if (!k) return answer;
  const lines = [
    `This job was parked on machine ${k.machineId} and resumes now on another machine, from its checkpoint of ${k.at}. Its agent session is this one.`,
    k.pushedTo
      ? `Its work tree is new: commit ${k.head.slice(0, 12)} on branch ${k.pushedTo}, which the remote holds, with the work not committed then applied as uncommitted changes. Paths and files of the other machine are not here.`
      : `Its work tree is new: commit ${k.base.slice(0, 12)}${k.branch ? ` on branch ${k.branch}` : ''}, with the checkpoint's patch applied as uncommitted changes. Paths and files of the other machine are not here.`,
  ];
  if (k.commits.length && !k.pushedTo) lines.push('', 'These commits were not pushed then. They are uncommitted changes now: commit them again before you push.', ...k.commits.map((s) => `- ${s}`));
  lines.push('', 'Work done after the checkpoint is lost. Look at git status and git diff first, then go on where the checkpoint left off.');
  if (answer !== PARKED_RESUME) lines.push('', answer);
  return lines.join('\n');
}

/**
 * Re-queue a parked job: back to the queue pinned to its machine, an answer pending; or, with its question still
 * open, back to waiting on it (the caller re-arms the question after the commit). One with no agent session only with
 * `freshSession`, the person's confirmation that it starts a fresh one (issue #530).
 */
export function recordUnpark(c: EngineContext, id: string, freshSession = false, elsewhere = false, who?: ParkAsk): Job {
  const { store } = c;
  // Who picked it up (issue #2167), on its `job.unparked`: a person, or a running job through the park skill.
  const by = parkAskOf({ ...(who?.by ? { by: who.by } : {}), ...(who?.via ? { via: who.via } : {}) });
  const job = store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (job.status !== 'parked') throw new EngineError('conflict', `job ${id} is ${job.status}: only a parked job can be re-queued`);
  // Auto-parked on a person (issue #2415): picked up, it would park again at once. The answer, or the decision, picks it up.
  const wait = job.parked?.auto && job.pendingAnswer === undefined ? personWaitOf(c, job) : undefined;
  if (wait) throw new EngineError('conflict', `job ${id} waits on its ${wait} with a person: picked up, it would park again at once; ${wait === 'question' ? 'the answer' : 'a decision on it'} picks it up`);
  // Picked up: a move it was parked for ends here (issue #1892), whoever picked it up.
  if (job.parked?.move) { const { move: _ended, ...parked } = job.parked; store.jobs.update(id, { parked }); }
  // Picked up past its token budget (issue #2302): it goes on, its budget counted again from what it had spent.
  if (job.budgetPaused) store.jobs.update(id, { budgetPaused: undefined, budgetFrom: jobSpend(store, id) });
  if (elsewhere) return recordElsewhere(c, store.jobs.get(id)!, by);
  // Never a fresh start the person did not agree to (issue #530).
  if (startsFresh(job) && !freshSession) {
    throw new EngineError('conflict', `job ${id} has no agent session to resume: re-queued, it starts a fresh session in its kept work tree, told its question and answer; confirm with freshSession`);
  }
  const q = job.questionId ? store.questions.get(job.questionId) : undefined;
  if (q?.status === 'open' && job.pendingAnswer === undefined) {
    const next = store.jobs.update(id, { status: 'waiting_answer' });
    store.events.append({ type: 'job.unparked', jobId: id, questionId: q.id, data: { to: 'waiting_answer', ...by } });
    return next;
  }
  // Its proposal or research report still in review (issues #537, #543): it waits on it again.
  if (openItemOf(c, job) && job.pendingAnswer === undefined) {
    const next = store.jobs.update(id, { status: 'waiting_answer' });
    store.events.append({ type: 'job.unparked', jobId: id, data: { to: 'waiting_answer', ...by } });
    return next;
  }
  // Its checkpoint marked after its park (issue #2335): on any machine with room, not only its own.
  if (unpinned(job)) return recordElsewhere(c, store.jobs.get(id)!, by);
  const next = store.jobs.update(id, { status: 'queued', pendingAnswer: job.pendingAnswer ?? PARKED_RESUME, holdReason: undefined, waitReason: undefined });
  store.events.append({ type: 'job.unparked', jobId: id, data: { to: 'queued', ...by } });
  return next;
}

/**
 * Pick a parked job up to resume elsewhere (issue #921): queued, its pin to its machine gone (a pin of its spec stays),
 * an answer pending. Its question, or its proposal or research report, must be answered first: the claim resumes the
 * agent with the answer, never to wait on it again on another machine.
 */
function recordElsewhere(c: EngineContext, job: Job, by: ParkAsk): Job {
  const { store } = c;
  const refused = elsewhereRefusal(job);
  if (refused) throw new EngineError('conflict', refused);
  const q = job.questionId ? store.questions.get(job.questionId) : undefined;
  if ((q?.status === 'open' || openItemOf(c, job)) && job.pendingAnswer === undefined) {
    throw new EngineError('conflict', `job ${job.id} waits on an answer: answer it first, then pick it up elsewhere`);
  }
  const next = store.jobs.update(job.id, {
    status: 'queued', pendingAnswer: job.pendingAnswer ?? PARKED_RESUME, holdReason: undefined, waitReason: undefined, resumeOn: undefined,
    parked: { ...job.parked!, elsewhere: { at: nowIso(c), checkpointAt: job.checkpoint!.at, ...(job.resumeOn ? { from: job.resumeOn } : {}) } },
  });
  store.events.append({ type: 'job.unparked', jobId: job.id, data: { to: 'queued', elsewhere: true, ...by } });
  return next;
}
