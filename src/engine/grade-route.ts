// Grade-aware routing at intake (issue #2845, design.md "Grade-aware routing"): with the user's grade routing on, the
// executor the grades prefer for an item no routing rule gave an executor (`gradeRouteOf`). The grades of the last
// WINDOW_DAYS are read once a minute at most, not once per item: the grade pass changes them once a minute too.
import { gradeRouteOf, pointsOf, type GradeRoute } from '../domain/grade-routing.ts';
import type { GradedChoice } from '../domain/model-routing.ts';
import type { SourceItem } from '../domain/ports.ts';
import { asksOf } from '../domain/review.ts';
import type { GradeRow } from '../domain/grades.ts';
import type { RoutedBy } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

const READ_EVERY_MS = 60_000;
const WINDOW_DAYS = 90;
const DAY = 86_400_000;

/** The grades of the last WINDOW_DAYS, read once a minute at most. */
export function gradeRows(c: Pick<EngineContext, 'store' | 'clock'>): () => GradeRow[] {
  let kept: { at: number; rows: GradeRow[] } | undefined;
  return () => {
    const now = c.clock.now().getTime();
    if (!kept || now - kept.at >= READ_EVERY_MS) kept = { at: now, rows: c.store.grades.list({ since: new Date(now - WINDOW_DAYS * DAY).toISOString() }) };
    return kept.rows;
  };
}

/** The graded jobs with a model choice (issue #2848 part 3), as model routing's tuning reads them. */
export const gradedChoicesOf = (rows: readonly GradeRow[]): GradedChoice[] =>
  rows.flatMap((r) => (r.choice ? [{ choice: r.choice, kind: r.kind, ...(r.repo !== undefined ? { repo: r.repo } : {}), points: pointsOf(r) }] : []));

/** The grade route of an item, or undefined: grade routing is off, a routing rule set the executor, or the grades do not prefer another. */
export function gradeRouter(c: EngineContext, rows: () => GradeRow[] = gradeRows(c)): (item: SourceItem, routedBy: RoutedBy | undefined) => GradeRoute | undefined {
  return (item, routedBy) => {
    if (routedBy?.set.executor !== undefined) return undefined;
    const { routing } = c.store.settings.getGradeSettings();
    if (!routing.on) return undefined;
    const asks = asksOf(item.labels, item.body ?? '', item.asks);
    const kind = asks.includes('research') ? 'research' : asks.includes('proposal') ? 'proposal' : 'code';
    return gradeRouteOf(rows(), { ...(item.repo !== undefined ? { repo: item.repo } : {}), kind }, item.executor, c.executors.names(), routing.minSamples);
  };
}
