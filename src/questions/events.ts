// A question's events: the raising machine (issue #485) rides on every one, subject and data, from the question's
// snapshot.
import type { UserStore } from '../domain/ports.ts';
import type { Question } from '../domain/types.ts';

export type QuestionEventType = 'question.escalated' | 'question.escalated_to_human' | 'question.answered' | 'question.closed' | 'question.dismissed' | 'question.expired' | 'question.lapsed' | 'question.corrected';

export function emitQuestionEvent(store: UserStore, q: Question, type: QuestionEventType, data: Record<string, unknown>): void {
  const r = q.raisedBy;
  store.events.append({
    type, jobId: q.jobId, questionId: q.id, ...(r ? { machineId: r.machineId, ...(r.laneId ? { laneId: r.laneId } : {}) } : {}),
    data: { questionId: q.id, ...data, ...(r ? { raisedBy: r } : {}) },
  });
}
