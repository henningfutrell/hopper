// Confidence calibration (issue #679, design.md "Question pipeline"): the confidence each level gave with the answers it
// did not escalate, over the window — read from the trails of the newest questions —, and how many fall below the
// auto-answer threshold. Most below it flags the level: the threshold is then seldom met, and its answers seldom go into a
// job by themselves, however sure the context makes them. Pure but for the read.
import type { QuestionRepository } from '../domain/ports.ts';
import { meetsThreshold, type Confidence, type ConfidenceSpread } from '../domain/types.ts';

/** The newest questions read for the spread: the window's at personal scale. */
const READ = 1000;

/** Per level, in the order the newest answers name them: its answers that did not escalate since `since`, by confidence. */
export function confidenceSpread(questions: Pick<QuestionRepository, 'list'>, since: string, threshold: Confidence): ConfidenceSpread[] {
  const spread = new Map<string, ConfidenceSpread>();
  for (const q of questions.list({ limit: READ })) {
    for (const a of q.attempts) {
      if (a.role !== 'level' || a.escalate !== false || a.answer === undefined || (a.finishedAt ?? a.startedAt) < since) continue;
      const s = spread.get(a.tier) ?? { level: a.tier, high: 0, medium: 0, low: 0, none: 0, total: 0, below: 0, flagged: false };
      s[a.confidence ?? 'none'] += 1;
      s.total += 1;
      if (!meetsThreshold(a.confidence, threshold)) s.below += 1;
      s.flagged = s.below * 2 > s.total;
      spread.set(a.tier, s);
    }
  }
  return [...spread.values()];
}
