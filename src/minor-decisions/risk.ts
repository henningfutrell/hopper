// The Decider's risk call (issue #679, design.md "Question pipeline"): for every answer an escalation level gives without
// escalating, Jev makes one typed decision over the question, the answer and the job's goal — how risky (none, low,
// real), of which kinds, and how sure. One TypeSafe call: a choice for the risk, and a yes-or-no choice for each kind.
// The point's settings say what is done with it: off, Jev is not asked; in shadow it is only recorded; active, the
// question pipeline uses it in place of the keyword risk rules (src/questions/auto-answer.ts). Each is a pick on the
// Decider page, compared at once with what the keyword rules said — `real` when a rule matched, else `none`; a `low` risk
// agrees with `none` —, so a person sees where the two disagree before they flip the point to active.
import { randomUUID } from 'node:crypto';
import type { UserStore } from '../domain/ports.ts';
import {
  RISK_CATEGORIES, RISK_LEVELS, type DecisionPointSettings, type JevChoices, type JevChoicesAsk, type JevChooser, type QuestionRiskInput,
  type QuestionRiskOutcome, type RiskCategory, type RiskDecision, type RiskLevel,
} from '../domain/types.ts';
import { withDeadline } from './deadline.ts';

const INSTRUCTIONS = 'A coding agent running a job unattended asked this question, and an escalation level answered it. Its answer is typed into the agent unless a person must decide. Judge the risk of the agent acting on this answer. Read what the words mean, not single words: "this step uses no secrets" carries no credentials risk; "rotate the token" does.';
const RISK_TEXT: Readonly<Record<RiskLevel, string>> = {
  none: 'no risk: nothing irreversible, and nothing outside the job\'s own work',
  low: 'a low risk: reversible, and within the job\'s own work',
  real: 'a real risk: irreversible, outside the job\'s own work, or a call for the owner to make',
};
const KIND_TEXT: Readonly<Record<RiskCategory, string>> = {
  credentials: 'credentials, secrets, keys or tokens: reading, changing, rotating or exposing them',
  destructive: 'deleting, overwriting or wiping files, data, history or resources',
  publish: 'publishing, deploying or releasing, or sending a message to people',
  pay: 'spending money',
  permissions: 'changing permissions, access or roles',
  ci: 'changing CI: its workflows, its checks or its settings',
  data: 'personal or customer data',
  other: 'another risk that a person should look at',
};
const YES_NO = [{ id: 'no', label: 'no' }, { id: 'yes', label: 'yes' }] as const;

/** The risk choice's options, as a pick on the Decider page shows them. */
export const RISK_OPTIONS = RISK_LEVELS.map((id) => ({ id, label: RISK_TEXT[id] }));

/** What Jev is asked: the question, the answer, the level and the job's goal. Never what the keyword rules matched. */
export function riskAsk(input: QuestionRiskInput): JevChoicesAsk {
  return {
    instructions: INSTRUCTIONS,
    state: { question: input.question, answer: input.answer, level: input.level, goal: input.goal },
    choices: {
      risk: { instructions: 'How risky is it for the agent to act on this answer?', options: RISK_OPTIONS },
      ...Object.fromEntries(RISK_CATEGORIES.map((c) => [c, { instructions: `Does acting on this answer involve ${KIND_TEXT[c]}?`, options: YES_NO }])),
    },
  };
}

/** Jev's picks as a risk decision: the risk and its confidence, and every kind it said yes to. */
export function decisionOf(picks: Extract<JevChoices, { ok: true }>['picks']): RiskDecision {
  const risk = picks.risk!;
  return { risk: risk.pick as RiskLevel, categories: RISK_CATEGORIES.filter((c) => picks[c]?.pick === 'yes'), confidence: risk.confidence };
}

export interface RiskCallDeps {
  store: UserStore;
  jev: JevChooser;
  /** The `question-risk` point's settings now. */
  settings(): DecisionPointSettings;
  timeoutMs: number;
  stopped(): boolean;
}

/** Ask Jev the risk call for a level's answer, and record it as a pick, compared with the keyword rules. Never throws on Jev. */
export async function askRisk(d: RiskCallDeps, input: QuestionRiskInput): Promise<QuestionRiskOutcome> {
  const s = d.settings();
  if (s.mode === 'off') return { asked: false, why: 'the risk call is off' };
  const available = d.jev.available();
  if (!available.available) return { asked: false, why: available.why ?? 'Jev is off' };
  const r = await withDeadline(d.timeoutMs, (signal) => d.jev.choose(riskAsk(input), signal), { ok: false, why: `no pick within ${d.timeoutMs} ms` });
  if (d.stopped()) return { asked: false, why: 'stopped' };
  const decision = r.ok ? decisionOf(r.picks) : undefined;
  const notApplied = !decision ? 'no_pick' : s.mode === 'shadow' ? 'shadow' : decision.confidence < s.threshold ? 'below_threshold' : undefined;
  const pickId = randomUUID();
  const tags = { jobId: input.jobId, questionId: input.questionId };
  d.store.tx(() => {
    d.store.events.append({
      type: 'minor_decision.picked', ...tags,
      data: {
        pickId, point: 'question-risk', by: 'jev', options: RISK_OPTIONS,
        ...(decision ? { pick: decision.risk, categories: decision.categories, confidence: decision.confidence } : { error: r.ok ? 'no pick' : r.why }),
        mode: s.mode, threshold: s.threshold, applied: notApplied === undefined, ...(notApplied ? { notApplied } : {}), questionId: input.questionId,
      },
    });
    if (!decision) return;
    const actual = input.rules.length > 0 ? 'real' : 'none';
    d.store.events.append({
      type: 'minor_decision.compared', ...tags,
      data: { pickId, point: 'question-risk', pick: decision.risk, actual, agreed: (decision.risk === 'real') === (actual === 'real'), decidedBy: 'rules' },
    });
  });
  return { asked: true, mode: s.mode, threshold: s.threshold, ...(decision ? { decision } : { error: r.ok ? 'no pick' : r.why }) };
}
