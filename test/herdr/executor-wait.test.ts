// Issue #483: a job that ends its turn with HOPPER_WAITING waits on what it named. The executor ends the run with
// a wait outcome at once: no question, no nudge. Its pane and Claude stay; what it saves lets the hopper see Claude
// go on by itself, without taking the same wait again.
import { describe, expect, it } from 'vitest';
import { readPaneAnswer } from '../../src/executors/herdr/pane-answer.ts';
import type { PaneState, TurnAnchor } from '../../src/executors/herdr/start.ts';
import { contextFor, jobWith, setup } from './support.ts';

const WAIT = {
  output: ['● The fix is committed. The push needs write access.', '  HOPPER_WAITING', '  for: write access to the repository', '  until: a background poll of the push'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const DONE = { output: ['● Access granted. Pushed.', '  HOPPER_DONE'] };

describe('herdr-claude executor: a job that waits', () => {
  it('ends the run on the wait at once, with what it waits for; nothing is sent to it', async () => {
    const { herdr, executor } = setup({ turns: [WAIT, DONE] }, { idleNudgeMs: 20000 });
    const { ctx, saved, progress } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3600000 }));
    expect(await executor.run(ctx)).toEqual({ kind: 'wait', wait: { for: 'write access to the repository', until: 'a background poll of the push' } });
    expect(herdr.prompts).toHaveLength(1);
    expect(progress.map((p) => p.message)).not.toContain(expect.stringContaining('status note'));
    const last = saved.at(-1) as PaneState;
    expect(last.parkedSeq).toEqual(expect.any(Number));
    expect(last.turn!.markersAfter).toEqual(expect.any(Number));
  });

  it('claude going on by itself is seen in the pane; the state it reattaches with skips the wait already taken', async () => {
    const { herdr, clock, executor } = setup({ turns: [WAIT, DONE] }, { idleNudgeMs: 20000 });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3600000 }));
    await executor.run(ctx);
    const state = saved.at(-1) as PaneState & { turn: TurnAnchor };
    expect(await readPaneAnswer(herdr, state, clock)).toBeNull();

    herdr.wake(state.agentName);

    const seen = await readPaneAnswer(herdr, state, clock);
    expect(seen).not.toBeNull();
    expect(seen!.answer).toBeUndefined();
    expect((seen!.executorState as PaneState).turn!.markersAfter).toBe(state.turn.markersAfter);
    const again = contextFor(jobWith({ prompt: 'go', timeoutMs: 3600000 }, { executorState: seen!.executorState }));
    expect(await executor.reattach!(again.ctx)).toMatchObject({ kind: 'finished', result: { summary: 'Access granted. Pushed.' } });
    expect(herdr.prompts).toHaveLength(1);
  });
});
