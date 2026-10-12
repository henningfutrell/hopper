// Auto-answer (issue #632, design.md "Question pipeline"): whether a level's answer goes into the job with no person.
// It does when auto-answer is on and the level's confidence meets the threshold, and nothing holds it for a person: a
// risk — the Decider's risk call when it is active, else a risk rule (issue #679) —, a guard (src/minor-decisions/guard.ts),
// or a high-priority job when the user holds those (issue #679). Every hold is recorded, not only the first (issue #679).
// A hold below the threshold at a lower level climbs to the next level; every other hold goes to a person. The
// settings, the agreement stats, the confidence spread and a person's correction of an auto-answer are here too.
import type { Clock, UserStore } from '../domain/ports.ts';
import {
  AUTO_ANSWER_WINDOW_DAYS, CONFIDENCES, DEFAULT_AUTO_ANSWER_SETTINGS, jobPriorityTag, meetsThreshold, TERMINAL_STATUSES,
  type AnswerHold, type AutoAnswerSettings, type AutoAnswerView, type Confidence, type EscalationReason, type Question,
  type QuestionRisk, type QuestionRiskOutcome, type RiskCheck,
} from '../domain/types.ts';
import { consequentialOf, guardsOf } from '../minor-decisions/guard.ts';
import { confidenceSpread } from './calibration.ts';
import { emitQuestionEvent } from './events.ts';
import { riskRules as riskRulesOf } from './risk.ts';

/** The human stage's name, as the question service has it. */
const HUMAN = 'human';

/** Why a level's answer does not go into the job: to a person, or (below the threshold, not the top level) to the next level. */
export interface Hold {
  to: 'human' | 'next';
  why: string;
  /** A risk rule or the consequential guard holds it (issue #650): its job never parks by itself. The strongest: risk. */
  kept?: 'risk' | 'guard';
  /** What a person is told (issue #679): the strongest hold's reason, the guards that matched, and every hold. */
  reason: EscalationReason;
  guards?: string[];
  holds: AnswerHold[];
}

export const autoAnswerSettings = (store: Pick<UserStore, 'settings'>): Required<AutoAnswerSettings> => ({ ...DEFAULT_AUTO_ANSWER_SETTINGS, ...store.settings.getAutoAnswer() });

/** The Decider's risk call on a level's answer to `q` (issue #679); undefined with no Decider. Called outside a tx. */
export function riskCall(risk: QuestionRisk | undefined, store: UserStore, q: Question, level: string, answer: string): Promise<QuestionRiskOutcome | undefined> {
  if (!risk) return Promise.resolve(undefined);
  const goal = store.jobs.get(q.jobId)?.spec.goal ?? '';
  return risk.risk({ jobId: q.jobId, questionId: q.id, question: q.text, answer, level, goal, rules: riskRulesOf(`${q.text}\n${answer}`) });
}

/**
 * How the answer is checked for risk (issue #679): by the keyword risk rules when the Decider was not asked or is in
 * shadow (its decision only recorded), by the Decider when it is active — its decision, or the error it failed with.
 */
export function riskCheckOf(call: QuestionRiskOutcome | undefined): RiskCheck {
  if (!call?.asked) return { by: 'rules' };
  const got = call.decision ? { decision: call.decision } : { error: call.error ?? 'no pick' };
  return call.mode === 'active' ? { by: 'decider', ...got } : { by: 'rules', shadow: true, ...got };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Inside the tx recording a level's answer to `q`: the risk rules that match the question and the answer to be typed, how
 * the answer was checked for risk, and why it does not go into the job — every hold, strongest first — or no hold.
 */
export function answerHold(o: {
  store: UserStore; q: Question; answer: string; level: string; top: boolean; confidence: Confidence | undefined; gated?: (machineId: string) => boolean;
  /** The Decider's risk call (issue #679); undefined: none was made, and the risk rules decide. */
  risk?: QuestionRiskOutcome;
}): { riskRules: string[]; riskCheck: RiskCheck; hold?: Hold } {
  const riskRules = riskRulesOf(`${o.q.text}\n${o.answer}`);
  const riskCheck = riskCheckOf(o.risk);
  const found = holdsOf(o, riskRules, riskCheck, o.risk?.asked ? o.risk.threshold : 1);
  if (found.length === 0) return { riskRules, riskCheck };
  const holds = found.map((f) => f.hold);
  const guards = holds.flatMap((h) => h.guards ?? []);
  const kept = holds.find((h) => h.by)?.by;
  return {
    riskRules, riskCheck,
    hold: {
      to: holds.some((h) => h.reason !== 'low_confidence') || o.top ? 'human' : 'next', why: found.map((f) => f.why).join('; '), reason: holds[0]!.reason,
      holds, ...(guards.length > 0 ? { guards } : {}), ...(kept ? { kept } : {}),
    },
  };
}

/** The risk hold, if any: the risk rules', or the Decider's (issue #679) — a real risk, too little confidence, or an error. */
function riskHold(riskRules: string[], check: RiskCheck, threshold: number): { hold: AnswerHold; why: string } | undefined {
  if (check.by === 'rules') return riskRules.length > 0 ? { hold: { reason: 'guard', by: 'risk', guards: riskRules }, why: `risk rules: ${riskRules.join(', ')}` } : undefined;
  const d = check.decision;
  if (!d) return { hold: { reason: 'guard', by: 'risk', decider: { threshold, error: check.error! } }, why: `the Decider's risk check failed: ${check.error}; held to be safe` };
  if (d.risk !== 'real' && d.confidence >= threshold) return undefined;
  const kinds = d.categories.length > 0 ? ` (${d.categories.join(', ')})` : '';
  return {
    hold: { reason: 'guard', by: 'risk', decider: { risk: d.risk, categories: d.categories, confidence: d.confidence, threshold } },
    why: `Decider: ${d.risk} risk${kinds}, ${pct(d.confidence)} sure${d.confidence < threshold ? `, below its threshold (${pct(threshold)})` : ''}`,
  };
}

/** Every hold on the answer, strongest first, each with the text the trail and the events show. */
function holdsOf(o: Parameters<typeof answerHold>[0], riskRules: string[], check: RiskCheck, threshold: number): { hold: AnswerHold; why: string }[] {
  const { store, q } = o;
  const found: { hold: AnswerHold; why: string }[] = [];
  const risk = riskHold(riskRules, check, threshold);
  if (risk) found.push(risk);
  const job = store.jobs.get(q.jobId);
  const machine = job?.resumeOn ?? job?.spec.machineId ?? q.raisedBy?.machineId;
  const gated = machine !== undefined && o.gated?.(machine) ? { gatedMachine: machine } : {};
  // With the risk rules, the guard names them too: those are held already. With the Decider, only the guards hold.
  const consequential = check.by === 'rules' ? consequentialOf([q.text, o.answer], gated).filter((g) => !riskRules.includes(g)) : guardsOf([q.text, o.answer], gated);
  if (consequential.length > 0) found.push({ hold: { reason: 'guard', by: 'guard', guards: consequential }, why: `consequential: ${consequential.join(', ')}; a person answers` });
  const settings = autoAnswerSettings(store);
  if (settings.holdHighPriority && jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId)?.high) {
    found.push({ hold: { reason: 'high_priority' }, why: 'high priority: a person answers' });
  }
  if (!settings.enabled) found.push({ hold: { reason: 'auto_answer_off' }, why: `auto-answer is off: ${o.level}'s answer is a recommendation` });
  else if (!meetsThreshold(o.confidence, settings.threshold)) {
    found.push({
      hold: { reason: 'low_confidence', ...(o.confidence ? { confidence: o.confidence } : {}), threshold: settings.threshold },
      why: `${o.level}: ${o.confidence ?? 'no'} confidence, below the auto-answer threshold (${settings.threshold})`,
    });
  }
  return found;
}

export type CorrectResult = { ok: true; question: Question } | { ok: false; reason: 'not_found' | 'not_auto' | 'job_ended' };

/**
 * A person corrects a level's auto-answer: the question keeps what it replaced (`corrected`), its answer is the person's
 * now, `question.corrected`, then `onCorrected` gives the job the correction, all in one tx. `not_auto`: no level's answer
 * went into the job, or it was corrected already; `job_ended`: its job ended, so nothing can reach it.
 */
export function correctAutoAnswer(d: { store: UserStore; at: string; onCorrected(q: Question): void }, id: string, answer: string, by: string): CorrectResult {
  const { store, at } = d;
  return store.tx((): CorrectResult => {
    const q = store.questions.get(id);
    if (!q) return { ok: false, reason: 'not_found' };
    const last = q.attempts.at(-1);
    if (q.status !== 'answered' || q.corrected || last?.role !== 'level' || last.outcome !== 'accepted' || last.tier !== q.answeredBy) return { ok: false, reason: 'not_auto' };
    const job = store.jobs.get(q.jobId);
    if (!job || TERMINAL_STATUSES.includes(job.status)) return { ok: false, reason: 'job_ended' };
    const was = q.answer ?? '';
    store.questions.addAttempt(id, { tier: HUMAN, role: 'human', startedAt: at, finishedAt: at, answer, reason: `corrected the auto-answer of ${last.tier}`, outcome: 'accepted' });
    const updated = store.questions.update(id, { answer, answeredBy: HUMAN, corrected: { level: last.tier, was, at, by } });
    emitQuestionEvent(store, updated, 'question.corrected', { level: last.tier, was, answer, by });
    d.onCorrected(updated);
    return { ok: true, question: updated };
  });
}

/** What the job is told when a person corrects the auto-answer it got. */
export function correctionBrief(q: Question): string {
  return [
    'A person corrected an answer you got earlier. You asked:', q.text, '',
    'The answer you got:', q.corrected?.was ?? '', '',
    'That answer was wrong. Use this answer in its place, and undo what you did only because of the earlier answer:', q.answer ?? '',
  ].join('\n');
}

export type AutoAnswerPatch = Partial<AutoAnswerSettings>;
export type AutoAnswerEdit = { ok: true; view: AutoAnswerView } | { ok: false; error: string };

const DAY_MS = 86_400_000;

/**
 * The settings and the stats over the window: the answers levels typed into jobs, the ones a person corrected, and each
 * level's confidence spread (issue #679).
 */
export function autoAnswerView(store: Pick<UserStore, 'settings' | 'events' | 'questions'>, clock: Clock): AutoAnswerView {
  const since = new Date(clock.now().getTime() - AUTO_ANSWER_WINDOW_DAYS * DAY_MS).toISOString();
  const events = store.events.between(['question.answered', 'question.corrected'], since);
  const answered = events.filter((e) => e.type === 'question.answered' && (e.data as { auto?: boolean }).auto === true).length;
  const corrected = events.filter((e) => e.type === 'question.corrected').length;
  const settings = autoAnswerSettings(store);
  return {
    ...settings,
    stats: { windowDays: AUTO_ANSWER_WINDOW_DAYS, answered, corrected, ...(answered > 0 ? { agreement: Math.max(0, answered - corrected) / answered } : {}) },
    calibration: confidenceSpread(store.questions, since, settings.threshold),
  };
}

/** An admin changes the settings; a change is an event, from the next question on. */
export function editAutoAnswer(store: Pick<UserStore, 'settings' | 'events' | 'questions' | 'tx'>, clock: Clock, patch: AutoAnswerPatch, by: string): AutoAnswerEdit {
  if (patch.threshold !== undefined && !(CONFIDENCES as readonly string[]).includes(patch.threshold)) return { ok: false, error: `threshold is one of ${CONFIDENCES.join(', ')}` };
  store.tx(() => {
    const was = autoAnswerSettings(store);
    const next: Required<AutoAnswerSettings> = {
      enabled: patch.enabled ?? was.enabled, threshold: patch.threshold ?? was.threshold, holdHighPriority: patch.holdHighPriority ?? was.holdHighPriority,
    };
    if (was.enabled === next.enabled && was.threshold === next.threshold && was.holdHighPriority === next.holdHighPriority) return;
    store.settings.setAutoAnswer(next);
    store.events.append({ type: 'auto_answer.settings_changed', data: { from: was, to: next, by } });
  });
  return { ok: true, view: autoAnswerView(store, clock) };
}
