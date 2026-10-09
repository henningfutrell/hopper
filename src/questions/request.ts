// What an escalation level is asked (design.md "Question pipeline"): the question with its job's prompt, goal and
// machine, the standing rules, the trail so far and the level's place; read when the level takes the question.
import type { AnswerRequest, ConfigRecords, UserStore } from '../domain/ports.ts';
import type { Logins } from '../logins/index.ts';
import type { Question } from '../domain/types.ts';
import { readRules } from './rules.ts';

/** `live`: false once the service stopped, so a login the run waits on is dropped. */
export function levelRequest(o: { store: UserStore; config: ConfigRecords; logins?: Logins }, q: Question, number: number, of: number, level: string, live: () => boolean): { req: AnswerRequest; rulesNote: string } {
  const rules = readRules(o.config);
  const job = o.store.jobs.get(q.jobId);
  const jobMachine = job?.resumeOn ?? job?.spec.machineId;
  return {
    req: {
      question: q,
      jobPrompt: typeof job?.spec.payload.prompt === 'string' ? job.spec.payload.prompt : '',
      jobGoal: job?.spec.goal,
      rules: rules.text,
      previous: q.attempts,
      level: { number, of },
      ...(jobMachine ? { jobMachine } : {}),
      // A login the level's run waits on (issue #476) names the question and the level, never the job: it waits on the answer.
      ...(o.logins ? { logins: o.logins.forRun({ questionId: q.id, run: level }, live) } : {}),
    },
    rulesNote: rules.missing ? ' (no rules yet)' : '',
  };
}
