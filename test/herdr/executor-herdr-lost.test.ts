// A pane lost while its job waited (issue #1508): the machine or herdr restarted and herdr did not restore it. The answer
// goes to Claude resumed in a new pane, set up as at the start, told why; with no agent session recorded, the job fails,
// `pane lost`. And the probe the engine asks of a waiting job's pane: lost or not.
import { describe, expect, it } from 'vitest';
import type { PaneState } from '../../src/executors/herdr/start.ts';
import { LOST_NOTE } from '../../src/executors/herdr/restored.ts';
import { contextFor, jobWith, setup } from './support.ts';

const ASK = { output: ['● Which colour?', '  HOPPER_QUESTION'] };
const DONE = { output: ['● Done.', '  HOPPER_DONE'] };

describe('herdr-claude executor: a pane lost while its job waited (issue #1508)', () => {
  it('the answer goes to Claude resumed in a new pane, told why', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(first.ctx)).toMatchObject({ kind: 'question' });
    const state = first.saved.at(-1) as unknown as PaneState;
    const session = first.sessions[0]!;
    herdr.killAgent(state.agentName);

    const again = contextFor(jobWith({ prompt: 'go' }, { executorState: { ...state }, agentSession: session }));
    expect(await executor.paneLost!(again.ctx.job)).toBe(true);
    expect(await executor.resume!(again.ctx, 'Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    expect(herdr.agentStarts[1]!.paneId).not.toBe(state.paneId);
    expect(herdr.prompts.at(-1)!.text).toBe(`${LOST_NOTE}\n\nBlue.`);
    expect(again.progress.map((p) => p.message).join('\n')).toMatch(/pane was lost while it waited/);
  });

  it('with no agent session recorded, the job fails: pane lost', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(first.ctx);
    const { agentSession: _none, ...state } = first.saved.at(-1) as unknown as PaneState;
    herdr.killAgent(state.agentName);

    const again = contextFor(jobWith({ prompt: 'go' }, { executorState: { ...state } }));
    expect(await executor.resume!(again.ctx, 'Blue.')).toEqual({ kind: 'failed', error: 'pane lost' });
    expect(herdr.agentStarts).toHaveLength(1);
  });

  it('a pane that is there is not lost', async () => {
    const { executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(first.ctx);
    const again = contextFor(jobWith({ prompt: 'go' }, { executorState: { ...(first.saved.at(-1) as object) } }));
    expect(await executor.paneLost!(again.ctx.job)).toBe(false);
  });
});
