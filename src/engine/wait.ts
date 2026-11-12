// A job's own wait (issue #483, design.md "A job's own wait"): the job ended its turn with HOPPER_WAITING and is
// `waiting_on` what it named (outcome.ts). A person ends the wait here; its agent going on by itself ends it in
// pane-answers.ts. Issue #998: the hopper ends it here too, when an answer the job asked it for is ready (src/skills/waits.ts).
// Issue #1245: and when the event that settles what it waits on comes (`wakeOn`: a pull request merged or closed, a job
// ended, an item's issue closed, a question answered, a grant or an approval given or not), on that event, never a poll.
// Issue #1210: and a wait on its own command that only polls hopper state, an hour after it began (`recordPollSeen`).
import { polledWait } from '../domain/own-command.ts';
import type { DomainEvent, Job, JobWait } from '../domain/types.ts';
import { SETTLING_EVENT_TYPES, settledBy, waitOnLabel, waitsFor, type Settled, type WaitOn } from '../domain/wait-on.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** What a job whose agent ended on its wait is told first when it resumes from its checkpoint (issue #2326). */
export const WAIT_RELEASED_NOTE = '[hopper] The hopper ended this session\'s agent while you waited, so a waiting job holds no memory. A background command you started then stopped with it.';

/**
 * A released job's wake (issue #2326): with a checkpoint of its whole session kept after its agent ended, it is not pinned to
 * its machine; picked up to resume elsewhere, as a parked job (issue #921), its claim restores the checkpoint on any machine
 * with room. Undefined: it resumes on its own machine.
 */
function wakeElsewhere(c: Pick<EngineContext, 'clock'>, job: Job): Pick<Job, 'parked'> | undefined {
  const r = job.waitReleased;
  if (!r?.checkpointAt || !job.checkpoint?.session || job.checkpoint.at !== r.checkpointAt || !job.agentSession || job.spec.machineId !== undefined) return undefined;
  const elsewhere = { at: nowIso(c), checkpointAt: job.checkpoint.at, from: r.machineId };
  return { parked: { at: r.at, from: 'waiting_answer', auto: true, why: 'its agent ended on its own wait', elsewhere } };
}

/** Who ends a job's wait: a person, or the hopper with an answer the job asked it for (issue #998). */
export type WaitEnder = 'person' | 'hopper';

/** What the job is told in its pane when a person, or the hopper, ends its wait. */
export function waitEndedNote(wait: Pick<JobWait, 'for' | 'strandedAt'> | undefined, note?: string, by: WaitEnder = 'person'): string {
  const waited = wait ? ` (${wait.for})` : '';
  if (by === 'hopper') {
    return `[hopper] The hopper ended your wait${waited}: the answer to a request you made is ready.${note ? ` The answer: ${note}` : ''} Check it, then go on with the job.`;
  }
  const said = note ? ` The person's note: ${note}` : '';
  // Its agent session ended while it waited (issue #1779): it is resumed in a new pane, and what it waited for may not have happened.
  if (wait?.strandedAt) {
    return `[hopper] A person ended your wait${waited}. Your agent session ended while you waited, so nothing could wake you.${said} Check what you waited for. If you still wait, end your turn with HOPPER_WAITING again. If it cannot happen, ask for something that can, or go on with the job.`;
  }
  return `[hopper] A person ended your wait: what you waited for${waited} has happened.${said} Check it, then go on with the job.`;
}

/**
 * In the tx: a person, or the hopper, ends the job's wait. It is queued again with the note pending, pinned to its machine (a pending
 * answer pins it, as for an answered question) — a released one with its checkpoint kept to any machine (issue #2326) —, and its claim types the note into its pane. `job.wait_ended`; `ended.check`: the key
 * of the wait check's condition that ended it (issue #1694); `ended.comment`: the link of the comment that woke it (issue #2159);
 * `ended.conflicting`: the pull request whose merge conflicts woke it (issue #1143).
 */
export function recordEndWait(c: Pick<EngineContext, 'store' | 'clock'>, id: string, note?: string, by: WaitEnder = 'person', told?: (wait: JobWait | undefined) => string, ended: { check?: string; comment?: string; conflicting?: string } = {}): Job {
  const { store } = c;
  const job = store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (job.status !== 'waiting_on') throw new EngineError('conflict', `job ${id} is ${job.status}: only a job on its own wait can have its wait ended`);
  const said = told ? told(job.wait) : waitEndedNote(job.wait, note, by);
  const moved = wakeElsewhere(c, job);
  const pendingAnswer = moved ? `${WAIT_RELEASED_NOTE}\n\n${said}` : said;
  const next = store.jobs.update(id, {
    status: 'queued', pendingAnswer, wait: undefined, holdReason: undefined, waitReason: undefined,
    ...(moved ? { ...moved, resumeOn: undefined, waitReleased: undefined } : {}),
  });
  store.events.append({ type: 'job.wait_ended', jobId: id, data: { by, ...(note ? { note } : {}), ...(ended.check ? { check: ended.check } : {}), ...(ended.comment ? { comment: ended.comment } : {}), ...(ended.conflicting ? { conflicting: ended.conflicting } : {}) } });
  return next;
}

/**
 * In the tx (issue #1245): `s` settled what some jobs wait on. Each job on its own wait on it is woken by the hopper,
 * told what happened. The woken jobs.
 */
export function wakeOn(c: EngineContext, s: Settled): string[] {
  const woken = c.store.jobs.list({ status: ['waiting_on'] }).filter((j) => waitsFor(j, s));
  for (const j of woken) wake(c, j.id, s);
  return woken.map((j) => j.id);
}

function wake(c: EngineContext, id: string, s: Settled): void {
  recordEndWait(c, id, s.note, 'hopper', (w) => `[hopper] The hopper ended your wait (${w?.on ? waitOnLabel(w.on) : w?.for ?? 'what you waited on'}): ${s.note}. Check it, then go on with the job.`);
}

/**
 * Issue #1571: the wakes `wakeOn` missed. It runs in memory after the settling event commits, so a stop between the two
 * left the job on its wait with nothing to wake it. `run`, in the tx: each job on its own wait that an event since its wait
 * began settles is woken, as `wakeOn` would. The first run reads every settling event since the oldest wait began; each
 * later run only the events since the run before. The woken jobs.
 */
export function createMissedWakes(c: EngineContext): { run(): string[] } {
  let after: number | undefined;
  const settling = new Set<string>(SETTLING_EVENT_TYPES);
  return {
    run() {
      const { events, jobs } = c.store;
      const waiting = jobs.list({ status: ['waiting_on'] }).filter((j) => j.wait);
      let read: DomainEvent[];
      if (after === undefined) {
        after = events.recent(1)[0]?.seq ?? 0;
        const oldest = waiting.map((j) => j.wait!.since).sort()[0];
        read = oldest ? events.between(SETTLING_EVENT_TYPES, oldest) : [];
      } else {
        const fresh = events.since(after);
        after = fresh.at(-1)?.seq ?? after;
        read = fresh.filter((e) => settling.has(e.type));
      }
      const woken: string[] = [];
      for (const j of waiting) {
        for (const e of read) {
          const s = e.at >= j.wait!.since ? settledBy(e) : undefined;
          if (s && waitsFor(j, s)) { wake(c, j.id, s); woken.push(j.id); break; }
        }
      }
      return woken;
    },
  };
}

/** What a job whose own command polled for an hour is told when the hopper ends its wait (issue #1210). */
export const polledWaitNote = (on: WaitOn, answer: string): string =>
  `[hopper] The hopper ended your wait (${waitOnLabel(on)}): your background command only polls the hopper, and you waited an hour. What the hopper knows now: ${answer}. Stop the poll. To wait on a pull request, run sh "$HOPPER_GH" pr wait once, or end your turn with HOPPER_WAITING and on: what you wait on. The hopper tends, rebases and merges pull requests by itself. Go on with the job.`;

/**
 * In the tx (issue #1210): the proxy saw the job's own command poll `on`, and answered `answer`. A job on a wait for its own
 * command has its wait typed as what it polls (`job.wait_polled`, once); an hour after the wait began, the hopper ends it with
 * the answer. Nothing for any other job. The job as it is now.
 */
export function recordPollSeen(c: EngineContext, id: string, on: WaitOn, answer: string): Job | undefined {
  const job = c.store.jobs.get(id);
  if (!job) return undefined;
  const next = polledWait(job, on, c.clock.now().getTime());
  if (!next) return job;
  if (next.kind === 'end') return recordEndWait(c, id, `${waitOnLabel(job.wait?.on ?? on)} polled for an hour`, 'hopper', (w) => polledWaitNote(w?.on ?? on, answer));
  const typed = c.store.jobs.update(id, { wait: next.wait });
  c.store.events.append({ type: 'job.wait_polled', jobId: id, data: { on } });
  return typed;
}

/**
 * In the tx (issue #2159): a trusted account's comment on the job's issue or pull request ends its own wait, while it is
 * still the wait that began at `since`. The job is told the comment (`told`). The job as it is now; undefined when it is
 * no longer on that wait.
 */
export function recordCommentWake(c: Pick<EngineContext, 'store' | 'clock'>, id: string, since: string, comment: { url: string; author: string }, told: string): Job | undefined {
  const job = c.store.jobs.get(id);
  if (job?.status !== 'waiting_on' || job.wait?.since !== since) return undefined;
  return recordEndWait(c, id, `${comment.author} commented`, 'hopper', () => told, { comment: comment.url });
}

/**
 * In the tx (issue #1143 reopened): a pull request a job of the item opened has merge conflicts, and the job is still on the
 * wait that began at `since`: the hopper ends it, the job told `told`. Undefined: it is no longer on that wait.
 */
export function recordConflictWake(c: Pick<EngineContext, 'store' | 'clock'>, id: string, since: string, pullRequest: string, told: string): Job | undefined {
  const job = c.store.jobs.get(id);
  if (job?.status !== 'waiting_on' || job.wait?.since !== since) return undefined;
  return recordEndWait(c, id, `${pullRequest} has merge conflicts`, 'hopper', () => told, { conflicting: pullRequest });
}
