// When the herdr-claude executor nudges a job after a status note (issue #163), and when it stops (issue #491).
// docs/design.md "Phase 2" → "Monitor". Before a nudge, the check before a nudge (issue #627).

import type { ExecutionContext, ExecutionOutcome, NudgeCheck } from '../../domain/ports.ts';
import { SUMMARY_CHARS } from './monitor.ts';

/**
 * After the first status note (`idleNudgeMs`), how long the turn sits idle before each further nudge in a
 * row; after the last, no more nudges until Claude works again by itself. Each nudge costs the job a turn.
 */
export const NUDGE_GAPS_MS = [60000, 300000, 900000, 1800000];

/** How long the turn sits idle without a marker before the next nudge, after `count` nudges in a row. */
export const nudgeGapMs = (count: number, idleNudgeMs: number): number => (count === 0 ? idleNudgeMs : NUDGE_GAPS_MS[count - 1] ?? idleNudgeMs);

/** What the check before a nudge (issue #627) is asked with: the status note, and the pane it is in. */
export interface NoteAt { statusNote: string; paneId: string }

/**
 * What follows a status note: a nudge, and the nudges in a row it makes; or none — the job waits `quiet`, its progress
 * saying why — once they are spent, or while it waits on a person; or the job `ended` done, its work over at its source
 * (issue #627). Claude going on by itself after they stopped (`quiet`) begins a new row. The check before a nudge is
 * asked only when a nudge is due; one that cannot tell is said, and the job is nudged.
 */
export async function afterStatusNote(notes: { count: number; quiet?: boolean }, ctx: Pick<ExecutionContext, 'beforeNudge' | 'progress'>, note: NoteAt): Promise<{ nudges: number } | { quiet: true } | { ended: ExecutionOutcome }> {
  const count = notes.quiet ? 0 : notes.count;
  const quiet = (why: string): { quiet: true } => { ctx.progress(0, why); return { quiet: true }; };
  if (count > NUDGE_GAPS_MS.length) return quiet(`waiting: ${count + 1} status notes in a row without a marker; no more nudges until claude works again`);
  const check = await checked(ctx);
  if ('waiting' in check) return quiet(`waiting on a person (${check.waiting}): no nudge`);
  if (!('done' in check)) return { nudges: count + 1 };
  ctx.progress(0, `ended done, not nudged: ${check.done}`);
  return { ended: { kind: 'finished', result: { summary: note.statusNote.slice(0, SUMMARY_CHARS), paneId: note.paneId, endedBy: check.done } } };
}

async function checked(ctx: Pick<ExecutionContext, 'beforeNudge' | 'progress'>): Promise<NudgeCheck> {
  try {
    return await ctx.beforeNudge?.() ?? { nudge: true };
  } catch (e) {
    ctx.progress(0, `could not read the source state before the nudge: ${(e as Error).message}`);
    return { nudge: true };
  }
}
