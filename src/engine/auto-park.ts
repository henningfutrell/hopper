// Auto-park (issue #650, design.md "Parked jobs"): on each tick, a job whose question has waited on a person past the
// park timeout is parked as the Park button parks it (`recordPark`, then `releaseParked`): its pane and agent end, its
// work tree, agent session and open question are kept. The wait counts from when the question reached a person. Only a
// job on a question (`waiting_answer`) parks by itself: a job waiting on a login is running (issue #476). Never parked
// by it: a question a risk rule or the consequential guard sent to a person (`keptBy`), a job with no agent session to
// resume (its pick up needs a person's confirmation, issue #530), and one a fork of its question still works for. The
// answer to its question re-queues it (`src/engine/answers.ts`).
import { DEFAULT_AUTO_PARK, autoParkMinutes, autoParkWhy, type AutoParkSettings, type Job, type Question } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';
import { HUMAN } from '../questions/service.ts';
import { forkRuns } from '../questions/stale.ts';
import { priorityTagOf, type EngineContext } from './context.ts';
import { parkRefusal, recordPark, releaseParked } from './park.ts';

export const autoParkSettings = (store: Pick<UserStore, 'settings'>): AutoParkSettings => store.settings.getAutoPark() ?? DEFAULT_AUTO_PARK;

const MINUTE_MS = 60_000;

/** The minutes after which the job's question parks it, or undefined: it does not park by itself. */
function dueAfter(c: EngineContext, job: Job, settings: AutoParkSettings): { minutes: number; q: Question } | undefined {
  const { store } = c;
  const q = job.questionId ? store.questions.get(job.questionId) : undefined;
  if (!q || q.status !== 'open' || q.tier !== HUMAN || !q.escalatedToHumanAt || q.keptBy) return undefined;
  if (job.agentSession === undefined || parkRefusal(c, job) || forkRuns(store, q)) return undefined;
  const minutes = autoParkMinutes(settings, priorityTagOf(c, job.id).high === true);
  return minutes > 0 ? { minutes, q } : undefined;
}

/** Park every job whose question waited on a person past its timeout. Run on each tick. */
export async function autoPark(c: EngineContext): Promise<void> {
  const { store } = c;
  const settings = autoParkSettings(store);
  const now = c.clock.now().getTime();
  for (const waiting of store.jobs.list({ status: ['waiting_answer'] })) {
    if (c.stopping()) return;
    const parked = store.tx(() => {
      // Read again in the tx: an answer may have re-queued it meanwhile.
      const job = store.jobs.get(waiting.id);
      if (job?.status !== 'waiting_answer') return undefined;
      const due = dueAfter(c, job, settings);
      if (!due || now - new Date(due.q.escalatedToHumanAt!).getTime() < due.minutes * MINUTE_MS) return undefined;
      return recordPark(c, job, 'waiting_answer', undefined, autoParkWhy(due.minutes));
    });
    if (parked) await releaseParked(c, parked);
  }
}
