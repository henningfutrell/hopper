// Auto-park (issues #650, #2335, design.md "Parked jobs"): on each tick, a job on a question with a person, or on its
// proposal or research report at the human stage, is parked as the Park button parks it (`recordPark`, then
// `releaseParked`): its pane and agent end, its work tree, agent session and open question or item are kept, and its
// checkpoint is taken and marked, so it resumes on any machine. It parks `WAIT_RELEASE_AFTER_MS` after its question reached a
// person, or began to wait on one again (`waitRestartedAt`: its job re-queued from parked, issue #692), or after its item
// reached the human stage, so an answer that comes at once pays no park and restore. Never parked by it: a job with no
// agent session to resume (its pick up needs a person's confirmation, issue #530). A job a fork of its question works for
// parks too (issue #2335): the fork's result answers the question. The answer to its question, or the decision on its item, re-queues it (`src/engine/answers.ts`,
// `src/engine/reviews.ts`). A question asked on its issue thread (issue #435: it has a `thread` record, posted or held for
// review) parks its job at once, with its own `why`. A job picked up with its question or item still open has no pane: it
// parks again with no executor call.
import { AUTO_PARK_WHY, THREAD_PARK_WHY, WAIT_RELEASE_AFTER_MS, type Job } from '../domain/types.ts';
import { HUMAN } from '../questions/service.ts';
import type { EngineContext } from './context.ts';
import { parkRefusal, recordPark, releaseParked } from './park.ts';
import { openItemOf } from './reviews.ts';

/** When the job's wait on a person began and why it parks, or undefined: it does not park by itself. */
function dueAt(c: EngineContext, job: Job): { since: number; why: string } | undefined {
  const { store } = c;
  if (job.agentSession === undefined || parkRefusal(c, job)) return undefined;
  const q = job.questionId ? store.questions.get(job.questionId) : undefined;
  if (q) {
    if (q.status !== 'open' || q.tier !== HUMAN || !q.escalatedToHumanAt) return undefined;
    if (q.thread && !q.waitRestartedAt) return { since: 0, why: THREAD_PARK_WHY };
    return { since: new Date(q.waitRestartedAt ?? q.escalatedToHumanAt).getTime() + WAIT_RELEASE_AFTER_MS, why: AUTO_PARK_WHY };
  }
  // Its item reached a person when its newest version was written or a level last reviewed it.
  const item = openItemOf(c, job);
  if (item?.stage !== HUMAN) return undefined;
  const reached = [item.versions.at(-1)?.at, ...item.reviews.map((r) => r.finishedAt)].filter((t): t is string => t !== undefined).sort().at(-1);
  return { since: (reached ? new Date(reached).getTime() : 0) + WAIT_RELEASE_AFTER_MS, why: AUTO_PARK_WHY };
}

/** Park every job on a question or an item that waits on a person. Run on each tick. */
export async function autoPark(c: EngineContext): Promise<void> {
  const { store } = c;
  const now = c.clock.now().getTime();
  for (const waiting of store.jobs.list({ status: ['waiting_answer'] })) {
    if (c.stopping()) return;
    const parked = store.tx(() => {
      // Read again in the tx: an answer may have re-queued it meanwhile.
      const job = store.jobs.get(waiting.id);
      if (job?.status !== 'waiting_answer') return undefined;
      const due = dueAt(c, job);
      if (!due || now < due.since) return undefined;
      // Picked up with its question open (issue #692): its pane ended at its last park.
      const paneless = job.parked !== undefined;
      return { job: recordPark(c, job, 'waiting_answer', undefined, due.why), paneless };
    });
    if (parked) await releaseParked(c, parked.job, parked.paneless);
  }
}
