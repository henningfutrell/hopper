// Not-signed-in questions answered by a sign-in (issue #1128, design.md "Tool sign-in"): a job's Claude with no credential
// asks a question that starts `NOT_SIGNED_IN` (issue #533). When a tool sign-in from the hopper completes on that question's
// machine, the hopper answers it, so the job goes on with no answer from a person. At Claude's prompt the answer types
// nothing (the executor sends the job's text once Claude shows it is signed in, else asks again). A question of Claude's
// login screen stays the person's: an answer there is typed into its options.
import type { QuestionService, UserStore } from '../domain/ports.ts';
import { LOGIN_SCREEN_MARK, NOT_SIGNED_IN, SIGNED_IN_ANSWER, SIGNED_IN_BY, type Question } from '../domain/types.ts';

/** A sign-in that completed: the machine, the tool, and its login. */
export interface SignedIn { machineId: string; tool: string; loginId: string }

/** Whether `q` is an open not-signed-in question of Claude's prompt asked on `machineId`. */
export const signedOutAt = (q: Question, machineId: string): boolean =>
  q.status === 'open' && q.raisedBy?.machineId === machineId && q.text.startsWith(NOT_SIGNED_IN) && !q.text.includes(LOGIN_SCREEN_MARK);

/** Answer each open not-signed-in question on the machine `s` signed Claude in on; the questions answered. */
export function answerSignedOut(o: { store: Pick<UserStore, 'questions'>; questions: Pick<QuestionService, 'settleWith'> }, s: SignedIn): Question[] {
  if (s.tool !== 'claude') return [];
  const reason = `the ${s.tool} sign-in from the hopper completed on ${s.machineId} (login ${s.loginId})`;
  return o.store.questions.list({ status: ['open'] }).filter((q) => signedOutAt(q, s.machineId))
    .flatMap((q) => o.questions.settleWith(q.id, SIGNED_IN_ANSWER, SIGNED_IN_BY, reason) ?? []);
}
