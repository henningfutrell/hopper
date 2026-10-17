// The `job-run` saga's first steps of a herdr-claude job (issue #1662, design.md "Several hoppers on one database"): where
// its credentials go, then its pane opened and Claude started, its task saved unsent. The run step's `reattach` sends that
// task and watches it, on this hopper or on another after a stop: the task is sent once. Split from executor.ts for its
// line budget.
import type { ExecutionContext, ExecutionOutcome, Executor } from '../../domain/ports.ts';
import type { Interrupt } from './monitor.ts';
import { heldOf, paneStateOf, type HeldPane, type Scratch } from './panes.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { payloadOn, taskText } from './relocate.ts';
import { FOOTER_ANCHOR } from './screen.ts';
import { jobScratchOf, type PaneState } from './start.ts';

export interface PaneOpenDeps {
  onLane(ctx: ExecutionContext, getPane: () => HeldPane | undefined, body: () => Promise<ExecutionOutcome | Interrupt>): Promise<ExecutionOutcome>;
  startIn(ctx: ExecutionContext, p: ClaudeJobPayload, held: (s: PaneState | undefined) => void): Promise<PaneState | ExecutionOutcome | Interrupt>;
  exitAndClose(pane: HeldPane, scratch: Scratch): Promise<string | undefined>;
}

export function paneOpen(d: PaneOpenDeps): Required<Pick<Executor, 'credentialsAt' | 'open'>> {
  return {
    credentialsAt(ctx) {
      const p = payloadOn(ctx);
      return 'kind' in p ? undefined : { scratch: jobScratchOf(p.cwd, ctx.job.id), makeWorkTree: p.makeWorkTree === true };
    },
    async open(ctx, again) {
      const p = payloadOn(ctx);
      if ('kind' in p) return p;
      ctx.workTree(p.cwd);
      // A try a stop cut short: the pane it opened with the task saved is the job's; one it left before that is closed
      // first, so one pane runs the job.
      const cut = again ? paneStateOf(ctx.job) : undefined;
      if (cut?.turn?.unsent) return undefined;
      if (cut && !cut.turn) await d.exitAndClose(heldOf(cut, ctx.job.id), 'none');
      let state: PaneState | undefined, opened = false;
      const outcome = await d.onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
        const started = await d.startIn(ctx, p, (s) => { state = s; });
        if ('kind' in started || 'interrupt' in started) return started;
        // The task, with the notes a person sent before it started (issue #997), saved unsent: `reattach` sends it once.
        const text = taskText(ctx, p, started, ctx.notes?.take('start'));
        ctx.saveState({ ...started, turn: { seq: 0, anchor: FOOTER_ANCHOR, blockedAtSend: false, text, unsent: true } });
        opened = true;
        return { kind: 'finished', result: null };
      });
      return opened ? undefined : outcome;
    },
  };
}
