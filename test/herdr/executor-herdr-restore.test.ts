// A herdr server restart (issue #1465): herdr restores the job's pane in a new terminal and resumes Claude there by itself,
// in a shell that has none of the tab's variables (HOPPER_*, git's way to GitHub through the hopper), outside the job's
// scope and sandbox. The hopper sees the pane's terminal change, closes that pane, and starts Claude again in a new pane
// set up as at the start, resuming the same session, and tells the job why.
import { describe, expect, it } from 'vitest';
import type { PaneState } from '../../src/executors/herdr/start.ts';
import { RESTORED_NOTE } from '../../src/executors/herdr/restored.ts';
import { contextFor, jobWith, setup, until } from './support.ts';

const ASK = { output: ['● Which colour?', '  HOPPER_QUESTION'] };
const WORKING = { steps: ['● Reading the code'], output: [], end: 'working' as const };
const DONE = { output: ['● Done.', '  HOPPER_DONE'] };
const VARS = { HOPPER_URL: 'http://hopper.test', HOPPER_GH: '/w/.worktrees/@scratch/j/credentials/gh' };

const withCredentials = (c: ReturnType<typeof contextFor>) => {
  c.ctx.credentials = async () => VARS;
  return c;
};

describe('herdr-claude executor: a pane herdr restored (issue #1465)', () => {
  it('records the pane\'s terminal and the agent session with the pane', async () => {
    const { executor } = setup({ turns: [DONE] });
    const { ctx, saved, sessions } = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(ctx);
    expect(saved.at(-1)).toMatchObject({ terminal: expect.any(String), agentSession: sessions[0] });
  });

  it('while it watches: closes the restored pane, starts Claude in a new one with the job\'s variables, resumes the session, and says why', async () => {
    const { herdr, executor } = setup({ turns: [WORKING, DONE] });
    const c = withCredentials(contextFor(jobWith({ prompt: 'go' })));
    const running = executor.run(c.ctx);
    await until(() => herdr.prompts.length === 1 && herdr.screen((c.saved.at(-1) as unknown as PaneState).paneId).includes('Reading the code'));
    const first = c.saved.at(-1) as unknown as PaneState;

    herdr.restartServer();

    expect(await running).toMatchObject({ kind: 'finished' });
    expect(herdr.closed).toContain(first.paneId);
    const tabs = herdr.calls.filter((call) => call.method === 'createTab').map((call) => call.args[0] as { env: Record<string, string> });
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.env).toMatchObject({ ...VARS, HOPPER_JOB_ID: c.ctx.job.id });
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', c.sessions[0]!]));
    expect(herdr.agentStarts[1]!.paneId).not.toBe(first.paneId);
    expect(herdr.prompts.at(-1)!.text).toBe(RESTORED_NOTE);
    expect(c.progress.map((p) => p.message).join('\n')).toMatch(/herdr restored the job's pane/);
    expect(c.saved.at(-1)).toMatchObject({ terminal: expect.any(String) });
    expect((c.saved.at(-1) as unknown as PaneState).terminal).not.toBe(first.terminal);
  });

  it('an answer to a job whose pane herdr restored while it waited goes to Claude resumed in a new pane, not to the restored one', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(first.ctx)).toMatchObject({ kind: 'question' });
    const state = first.saved.at(-1) as unknown as PaneState;
    const session = first.sessions[0]!;

    herdr.restartServer();

    const again = withCredentials(contextFor(jobWith({ prompt: 'go' }, { executorState: { ...state }, agentSession: session })));
    expect(await executor.resume!(again.ctx, 'Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.closed).toContain(state.paneId);
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', session]));
    const tabs = herdr.calls.filter((call) => call.method === 'createTab').map((call) => call.args[0] as { env: Record<string, string> });
    expect(tabs.at(-1)!.env).toMatchObject(VARS);
    expect(herdr.prompts.at(-1)!.text).toBe(`${RESTORED_NOTE}\n\nBlue.`);
  });

  // Issue #2320: herdr resumed Claude by itself in a pane the hopper did not open, a shell with none of the job's variables.
  const resumedElsewhere = async (herdr: ReturnType<typeof setup>['herdr'], state: PaneState, session: string): Promise<string> => {
    herdr.killAgent(state.agentName);
    const other = herdr.openPane({ title: '', lines: ['$ '] });
    await herdr.startAgent({ name: state.agentName, paneId: other, args: ['--resume', session], timeoutMs: 1000 });
    return other;
  };

  it('an answer to a job whose Claude herdr resumed in another pane goes to Claude resumed in a new pane with the job\'s variables; the other pane is closed (issue #2320)', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(first.ctx)).toMatchObject({ kind: 'question' });
    const state = first.saved.at(-1) as unknown as PaneState;
    const session = first.sessions[0]!;
    const other = await resumedElsewhere(herdr, state, session);

    const again = withCredentials(contextFor(jobWith({ prompt: 'go' }, { executorState: { ...state }, agentSession: session })));
    expect(await executor.resume!(again.ctx, 'Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.closed).toEqual(expect.arrayContaining([state.paneId, other]));
    expect([state.paneId, other]).not.toContain(herdr.agentStarts.at(-1)!.paneId);
    expect(herdr.agentStarts.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', session]));
    const tabs = herdr.calls.filter((call) => call.method === 'createTab').map((call) => call.args[0] as { env: Record<string, string> });
    expect(tabs.at(-1)!.env).toMatchObject(VARS);
    expect(herdr.prompts.at(-1)!.text).toBe(`${RESTORED_NOTE}\n\nBlue.`);
  });

  it('a pane saved with no terminal: Claude in another pane is not the job\'s pane either (issue #2320)', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(first.ctx);
    const { terminal: _unused, ...state } = first.saved.at(-1) as unknown as PaneState;
    const other = await resumedElsewhere(herdr, state, first.sessions[0]!);

    const again = withCredentials(contextFor(jobWith({ prompt: 'go' }, { executorState: { ...state }, agentSession: first.sessions[0]! })));
    expect(await executor.resume!(again.ctx, 'Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.closed).toContain(other);
    expect(herdr.prompts.at(-1)!.text).toBe(`${RESTORED_NOTE}\n\nBlue.`);
  });

  it('while it watches: Claude that herdr resumed in another pane is stopped there, and resumes in a new pane with the job\'s variables (issue #2320)', async () => {
    const { herdr, executor } = setup({ turns: [WORKING, DONE] });
    const c = withCredentials(contextFor(jobWith({ prompt: 'go' })));
    const running = executor.run(c.ctx);
    await until(() => herdr.prompts.length === 1 && herdr.screen((c.saved.at(-1) as unknown as PaneState).paneId).includes('Reading the code'));
    const first = c.saved.at(-1) as unknown as PaneState;
    const other = await resumedElsewhere(herdr, first, c.sessions[0]!);

    expect(await running).toMatchObject({ kind: 'finished' });
    expect(herdr.closed).toEqual(expect.arrayContaining([first.paneId, other]));
    expect([first.paneId, other]).not.toContain(herdr.agentStarts.at(-1)!.paneId);
    const tabs = herdr.calls.filter((call) => call.method === 'createTab').map((call) => call.args[0] as { env: Record<string, string> });
    expect(tabs.at(-1)!.env).toMatchObject(VARS);
    expect(herdr.prompts.at(-1)!.text).toBe(RESTORED_NOTE);
  });

  it('a pane saved with no terminal (started before the check) is watched as before', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'go' }));
    await executor.run(first.ctx);
    const { terminal: _unused, ...state } = first.saved.at(-1) as unknown as PaneState;

    const again = contextFor(jobWith({ prompt: 'go' }, { executorState: { ...state } }));
    expect(await executor.resume!(again.ctx, 'Blue.')).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(1);
  });
});
