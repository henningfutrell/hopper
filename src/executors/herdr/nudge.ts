// When the herdr-claude executor nudges a job after a status note (issue #163), and when it stops (issue #491).
// docs/design.md "Phase 2" → "Monitor".

/**
 * After the first status note (`idleNudgeMs`), how long the turn sits idle before each further nudge in a
 * row; after the last, no more nudges until Claude works again by itself. Each nudge costs the job a turn.
 */
export const NUDGE_GAPS_MS = [60000, 300000, 900000, 1800000];

/** How long the turn sits idle without a marker before the next nudge, after `count` nudges in a row. */
export const nudgeGapMs = (count: number, idleNudgeMs: number): number => (count === 0 ? idleNudgeMs : NUDGE_GAPS_MS[count - 1] ?? idleNudgeMs);

/**
 * What follows a status note: a nudge, and the nudges in a row it makes, or none once they are spent, and
 * the job's progress then. Claude going on by itself after they stopped (`quiet`) begins a new row.
 */
export function afterStatusNote(notes: { count: number; quiet?: boolean }): { nudges: number } | { spent: string } {
  const count = notes.quiet ? 0 : notes.count;
  if (count <= NUDGE_GAPS_MS.length) return { nudges: count + 1 };
  return { spent: `waiting: ${count + 1} status notes in a row without a marker; no more nudges until claude works again` };
}
