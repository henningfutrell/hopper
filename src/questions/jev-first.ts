// The Jev tier of the question pipeline (issue #550, design.md "Minor decisions"): a question that lists its options
// is a minor decision, and Jev is asked before any escalation level. Its pick goes on the question's trail; it is the
// answer only when the decision point is active, Jev is sure enough, and nothing makes it consequential — the risk
// rules, permissions, a machine the blast-radius gate keeps. Anything else goes on to the levels, as before.
import type { UserStore } from '../domain/ports.ts';
import type { MinorDecisionTier, Question, QuestionAttempt } from '../domain/types.ts';
import { consequentialOf } from '../minor-decisions/guard.ts';
import { questionOptions } from '../minor-decisions/options.ts';

/** The Jev tier's name on a question's trail and as `answeredBy`. */
export const JEV = 'jev';
const INSTRUCTIONS = 'A coding agent running a job unattended asks this question and lists its options. Pick the option a careful engineer on the job would choose; when unsure, the safest, most reversible one.';
const OUTPUT_TAIL = 2000;
const WHY_NOT: Readonly<Record<string, string>> = {
  shadow: 'shadow: recorded only', below_threshold: 'below the threshold', consequential: 'consequential: never decided by Jev', no_pick: 'no pick',
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface JevFirstDeps {
  store: UserStore;
  tier: MinorDecisionTier;
  iso(): string;
  stopped(): boolean;
  gated(machineId: string): boolean;
  /** Inside the tx that answered it: announce the answer and resume the job. */
  answered(q: Question): void;
}

/** Ask Jev about an open question. True when nothing is left for the levels: answered by Jev, or no longer open. */
export async function askJevFirst(d: JevFirstDeps, id: string): Promise<boolean> {
  const { store } = d;
  const q = store.questions.get(id);
  const options = q ? questionOptions(q.text) : [];
  if (!q || q.status !== 'open' || options.length < 2) return false;
  const job = store.jobs.get(q.jobId);
  const machine = job?.resumeOn ?? job?.spec.machineId ?? q.raisedBy?.machineId;
  const gatedMachine = machine !== undefined && d.gated(machine) ? machine : undefined;
  const startedAt = d.iso();
  const out = await d.tier.decide({
    point: 'question-answer', jobId: q.jobId, questionId: q.id, instructions: INSTRUCTIONS, options,
    state: { question: q.text, goal: job?.spec.goal ?? '', recentOutput: q.recentOutput.slice(-OUTPUT_TAIL) },
    consequential: consequentialOf([q.text], gatedMachine ? { gatedMachine } : {}),
  });
  if (d.stopped()) return true;
  if (!out.asked) return false;
  return store.tx((): boolean => {
    const cur = store.questions.get(id);
    if (!cur || cur.status !== 'open') return true;
    const label = options.find((x) => x.id === out.pick)?.label;
    const reason = out.pick === undefined ? WHY_NOT.no_pick!
      : `picked ${out.pick}${label ? ` (${label})` : ''} at ${pct(out.confidence ?? 0)}${out.applied ? '' : `; ${WHY_NOT[out.notApplied ?? 'no_pick']}`}`;
    const attempt: QuestionAttempt = {
      tier: JEV, role: 'jev', startedAt, finishedAt: d.iso(), outcome: out.applied ? 'accepted' : 'escalated', reason,
      ...(out.pick !== undefined ? { answer: out.pick } : {}),
    };
    store.questions.addAttempt(id, attempt);
    if (!out.applied || out.pick === undefined) return false;
    d.answered(store.questions.update(id, { status: 'answered', answer: out.pick, answeredBy: JEV }));
    return true;
  });
}
