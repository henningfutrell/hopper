// The minor decisions view (issue #550): each decision point's settings and its record over the window, read from
// its events — asked, picked, applied, compared with what was decided after, agreed, overridden — and the newest
// picks with what was decided. A person's override replaces what was compared. Pure.
import {
  DECISION_POINTS, DECISION_POINT_TEXT, type DecisionPoint, type DomainEvent, type MinorDecisionPickView, type MinorDecisionSettings,
  type MinorDecisionsView, MINOR_DECISION_WINDOW_DAYS,
} from '../domain/types.ts';

export const RECENT_PICKS = 50;
export const VIEW_EVENT_TYPES = ['minor_decision.picked', 'minor_decision.compared', 'minor_decision.overridden'] as const;

/** Every pick in the events, oldest first, with what was decided after it. */
export function picksOf(events: readonly DomainEvent[]): MinorDecisionPickView[] {
  const picks = new Map<string, MinorDecisionPickView>();
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    const id = d.pickId as string;
    if (e.type === 'minor_decision.picked') {
      picks.set(id, {
        pickId: id, at: e.at, point: d.point as DecisionPoint, options: d.options as MinorDecisionPickView['options'],
        mode: d.mode as MinorDecisionPickView['mode'], threshold: d.threshold as number, applied: d.applied === true,
        ...(e.jobId ? { jobId: e.jobId } : {}), ...(typeof d.questionId === 'string' ? { questionId: d.questionId } : {}),
        ...(typeof d.pick === 'string' ? { pick: d.pick } : {}), ...(typeof d.confidence === 'number' ? { confidence: d.confidence } : {}),
        ...(typeof d.error === 'string' ? { error: d.error } : {}),
        ...(d.notApplied ? { notApplied: d.notApplied as MinorDecisionPickView['notApplied'] } : {}),
        ...(Array.isArray(d.consequential) ? { consequential: d.consequential as string[] } : {}),
      });
      continue;
    }
    const p = picks.get(id);
    if (!p) continue;
    if (e.type === 'minor_decision.compared' && !p.overridden) {
      Object.assign(p, { actual: d.actual as string, decidedBy: d.decidedBy as string, agreed: d.agreed === true });
    } else if (e.type === 'minor_decision.overridden') {
      Object.assign(p, { actual: d.actual as string, decidedBy: 'override', agreed: d.actual === p.pick, overridden: true });
    }
  }
  return [...picks.values()];
}

export function viewOf(events: readonly DomainEvent[], settings: MinorDecisionSettings, jev: MinorDecisionsView['jev']): MinorDecisionsView {
  const picks = picksOf(events);
  const points = DECISION_POINTS.map((point) => {
    const mine = picks.filter((p) => p.point === point);
    const compared = mine.filter((p) => p.agreed !== undefined);
    const agreed = compared.filter((p) => p.agreed).length;
    return {
      point, ...DECISION_POINT_TEXT[point], ...settings[point],
      asked: mine.length, picked: mine.filter((p) => p.pick !== undefined).length, applied: mine.filter((p) => p.applied).length,
      compared: compared.length, agreed, agreement: compared.length ? agreed / compared.length : null,
      overridden: mine.filter((p) => p.overridden).length,
    };
  });
  return { jev, windowDays: MINOR_DECISION_WINDOW_DAYS, points, recent: picks.slice(-RECENT_PICKS).reverse() };
}
