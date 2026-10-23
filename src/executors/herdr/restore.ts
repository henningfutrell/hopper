// A job's checkpoint restored in its new pane (issue #921, docs/design.md "Checkpoints and resume elsewhere"): the
// restore command typed into the pane's shell, and what its outcome makes of the start.
import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import { RESTORE_MARK, RESTORE_NO_WAY, restoredInPart, restoredInPartNote, restoreOutcome } from '../../client/checkpoint.ts';
import { tail } from './monitor.ts';
import { awaitOnScreen } from './pane-wait.ts';
import type { PaneState, StartDeps } from './start.ts';

const RESTORE_WAIT_MS = 10 * 60000;

/**
 * Rebuild a job's work from its checkpoint in its new worktree (issue #921, checkpoint.ts `restoreCommand`), in the
 * pane's shell, which has the job's way to the hopper: before its dependencies are linked, so the worktree it checks is
 * the job's own. A worktree that holds changes already is kept as it is. Null when done, else the failure. A pane with no
 * way to the hopper (issue #2316) fails marked `noWayToHopper` (issue #2355): a new pane on the same machine got none
 * either, so the engine places the job on another machine. A patch that applied only in part (issue #2428) goes on: what
 * it left out is said, and kept in `s.restoreNote` for the agent.
 */
export async function restoreCheckpoint(d: StartDeps, ctx: ExecutionContext, s: PaneState, command: string): Promise<ExecutionOutcome | null> {
  if (!s.jobWorktree) return { kind: 'failed', error: `the job got no worktree of its own on ${ctx.machine.id} to restore its checkpoint into: it needs job worktrees, or a repository` };
  ctx.progress('restoring the checkpoint in the job worktree');
  await d.herdr.runInPane(s.paneId, command);
  const { found: outcome, screen } = await awaitOnScreen(d, ctx, s.paneId, RESTORE_MARK, restoreOutcome, RESTORE_WAIT_MS);
  if (ctx.signal.aborted) return null;
  if (outcome === 'restored' || outcome === 'kept') {
    ctx.progress(outcome === 'restored' ? 'restored the checkpoint: its base checked out, its patch applied, its session in place' : 'the job worktree holds work already: kept it as it is'); return null;
  }
  if (outcome === 'partly') {
    const part = restoredInPart(screen);
    s.restoreNote = restoredInPartNote(part);
    ctx.progress(`restored the checkpoint in part: its patch did not apply whole, so it left out ${part.leftOut.join(', ') || 'files the screen does not show'}; the whole patch is in ${part.patch ?? 'the worktree\'s git dir'}`);
    return null;
  }
  const error = outcome ? `the checkpoint could not be restored on ${ctx.machine.id}: ${tail(screen, 10)}` : `pane ${s.paneId} never restored the checkpoint within ${RESTORE_WAIT_MS} ms: ${tail(screen, 10)}`;
  return outcome && screen.includes(RESTORE_NO_WAY) ? { kind: 'failed', error, noWayToHopper: true } : { kind: 'failed', error };
}
