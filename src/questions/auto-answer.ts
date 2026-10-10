// Auto-answer (issue #632, design.md "Question pipeline"): whether a level's answer goes into the job with no person.
// It does when auto-answer is on and the level's confidence meets the threshold, and nothing holds it for a person: a
// risk rule, the consequential guard (src/minor-decisions/guard.ts) or a high-priority job.
// A hold below the threshold at a lower level climbs to the next level; every other hold goes to a person. The
// settings, the agreement stats and a person's correction of an auto-answer are here too.
import type { Clock, UserStore } from '../domain/ports.ts';
import {
  AUTO_ANSWER_WINDOW_DAYS, CONFIDENCES, DEFAULT_AUTO_ANSWER_SETTINGS, jobPriorityTag, meetsThreshold, TERMINAL_STATUSES,
  type AutoAnswerSettings, type AutoAnswerView, type Confidence, type Question,
} from '../domain/types.ts';
import { consequentialOf } from '../minor-decisions/guard.ts';
import { emitQuestionEvent } from './events.ts';
import { riskRules as riskRulesOf } from './risk.ts';

/** The human stage's name, as the question service has it. */
const HUMAN = 'human';

/** Why a level's answer does not go into the job: to a person, or (below the threshold, not the top level) to the next level. */
export interface Hold {
  to: 'human' | 'next';
  why: string;
  /** A risk rule or the consequential guard holds it (issue #650): its job never parks by itself. */
  kept?: 'risk' | 'guard';
}

export const autoAnswerSettings = (store: Pick<UserStore, 'settings'>): AutoAnswerSettings => store.settings.getAutoAnswer() ?? DEFAULT_AUTO_ANSWER_SETTINGS;

/**
 * Inside the tx recording a level's answer to `q`: the risk rules that match the question and the answer to be typed, and
 * why the answer does not go into the job — a risk rule hit first — or no hold.
 */
export function answerHold(o: {
  store: UserStore; q: Question; answer: string; level: string; top: boolean; confidence: Confidence | undefined; gated?: (machineId: string) => boolean;
}): { riskRules: string[]; hold?: Hold } {
  const riskRules = riskRulesOf(`${o.q.text}\n${o.answer}`);
  if (riskRules.length > 0) return { riskRules, hold: { to: 'human', why: `risk rules: ${riskRules.join(', ')}`, kept: 'risk' } };
  const hold = autoAnswerHold(o);
  return hold ? { riskRules, hold } : { riskRules };
}

function autoAnswerHold(o: Parameters<typeof answerHold>[0]): Hold | undefined {
  const { store, q } = o;
  const job = store.jobs.get(q.jobId);
  const machine = job?.resumeOn ?? job?.spec.machineId ?? q.raisedBy?.machineId;
  const consequential = consequentialOf([q.text, o.answer], machine !== undefined && o.gated?.(machine) ? { gatedMachine: machine } : {});
  if (consequential.length > 0) return { to: 'human', why: `consequential: ${consequential.join(', ')}; a person answers`, kept: 'guard' };
  if (jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId)?.high) return { to: 'human', why: 'high priority: a person answers' };
  const settings = autoAnswerSettings(store);
  if (!settings.enabled) return { to: 'human', why: `auto-answer is off: ${o.level}'s answer is a recommendation` };
  if (meetsThreshold(o.confidence, settings.threshold)) return undefined;
  return { to: o.top ? 'human' : 'next', why: `${o.level}: ${o.confidence ?? 'no'} confidence, below the auto-answer threshold (${settings.threshold})` };
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

/** The settings and the agreement stats over the window: the answers levels typed into jobs, and the ones a person corrected. */
export function autoAnswerView(store: Pick<UserStore, 'settings' | 'events'>, clock: Clock): AutoAnswerView {
  const since = new Date(clock.now().getTime() - AUTO_ANSWER_WINDOW_DAYS * DAY_MS).toISOString();
  const events = store.events.between(['question.answered', 'question.corrected'], since);
  const answered = events.filter((e) => e.type === 'question.answered' && (e.data as { auto?: boolean }).auto === true).length;
  const corrected = events.filter((e) => e.type === 'question.corrected').length;
  return {
    ...autoAnswerSettings(store),
    stats: { windowDays: AUTO_ANSWER_WINDOW_DAYS, answered, corrected, ...(answered > 0 ? { agreement: Math.max(0, answered - corrected) / answered } : {}) },
  };
}

/** An admin changes the settings; a change is an event, from the next question on. */
export function editAutoAnswer(store: Pick<UserStore, 'settings' | 'events' | 'tx'>, clock: Clock, patch: AutoAnswerPatch, by: string): AutoAnswerEdit {
  if (patch.threshold !== undefined && !(CONFIDENCES as readonly string[]).includes(patch.threshold)) return { ok: false, error: `threshold is one of ${CONFIDENCES.join(', ')}` };
  store.tx(() => {
    const was = autoAnswerSettings(store);
    const next: AutoAnswerSettings = { enabled: patch.enabled ?? was.enabled, threshold: patch.threshold ?? was.threshold };
    if (was.enabled === next.enabled && was.threshold === next.threshold) return;
    store.settings.setAutoAnswer(next);
    store.events.append({ type: 'auto_answer.settings_changed', data: { from: was, to: next, by } });
  });
  return { ok: true, view: autoAnswerView(store, clock) };
}
