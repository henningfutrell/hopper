// Auto-answer (issue #632): the handled question a level auto-answered — the one a person may correct —, the
// agreement stats as one line, and a level's confidence spread as one line (issue #679).
import type { AutoAnswerStats, Confidence, ConfidenceSpread, Question } from './wire.ts';

/** The level whose answer went into the job with no person, and how sure it was; none once a person corrected it. */
export function autoAnswerOf(q: Question): { level: string; confidence?: Confidence } | undefined {
  const last = q.attempts.at(-1);
  if (q.status !== 'answered' || q.corrected || last?.role !== 'level' || last.outcome !== 'accepted' || last.tier !== q.answeredBy) return undefined;
  return { level: last.tier, ...(last.confidence ? { confidence: last.confidence } : {}) };
}

export function agreementLine(s: AutoAnswerStats): string {
  if (s.answered === 0) return `no auto-answers in ${s.windowDays} days`;
  const kept = s.agreement === undefined ? '' : ` · ${Math.round(s.agreement * 100)}% kept`;
  return `${s.answered} auto-answer${s.answered === 1 ? '' : 's'} in ${s.windowDays} days · ${s.corrected} corrected${kept}`;
}

/** A level's confidence spread (issue #679): each confidence with its count, and how many fall below the threshold. */
export function spreadLine(s: ConfidenceSpread, threshold: Confidence): string {
  return `${s.level}: ${s.high} high · ${s.medium} medium · ${s.low} low · ${s.none} none — ${s.below} of ${s.total} below ${threshold}`;
}
