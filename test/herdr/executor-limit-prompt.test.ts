// A limit prompt in the pane (issue #2897): the agent stands at a usage, rate or access limit, so the turn fails at the
// next look at the pane, not at the job's timeout; a normal idle pane and a job's own words are no limit.
import { describe, expect, it } from 'vitest';
import { limitPromptOfFailure } from '../../src/domain/limit-prompts.ts';
import { exitedError } from '../../src/executors/herdr/exited.ts';
import type { PaneWaitDeps } from '../../src/executors/herdr/pane-wait.ts';
import { limitPromptOnTurn } from '../../src/executors/herdr/limit-screen.ts';
import { contextFor, jobWith, setup } from './support.ts';

const WALL = 'Run /extra-usage to continue, or ask your admin to enable access';

describe('herdr-claude executor: a limit prompt', () => {
  it('an idle pane at the access-limit prompt fails at once, with no nudge and long before the timeout', async () => {
    const { executor, herdr, clock } = setup({ turns: [{ output: ['● Bash(npm test)', '  ⎿  12 passed', `  ⎿  ${WALL}`] }] });
    const started = clock.now().getTime();
    const out = await executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 })).ctx);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && limitPromptOfFailure(out.error)).toEqual({ family: 'access', prompt: WALL });
    expect(clock.now().getTime() - started).toBeLessThan(60_000);
    expect(herdr.texts.map((t) => t.text).join('\n') + herdr.prompts.slice(1).map((p) => p.text).join('\n')).not.toContain('status note');
  });

  it('the limit dialog herdr calls blocked is a failure, not a question', async () => {
    const dialog = ['─────────', " You've hit your limit · resets 3pm (UTC)", ' What do you want to do?', ' ❯ 1. Stop and wait for limit to reset', '   2. Upgrade your plan'];
    const { executor } = setup({ turns: [{ output: ['● Working on it'], end: 'blocked', dialog }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && limitPromptOfFailure(out.error)).toEqual({ family: 'usage', prompt: "You've hit your limit · resets 3pm (UTC)" });
  });

  it('a normal idle pane is no limit: the turn is a status note, as before', async () => {
    const { executor, herdr } = setup({ turns: [{ output: ['● I will look at the docs next.'] }, { output: ['● Done.', '  HOPPER_DONE'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('finished');
    expect(herdr.prompts.map((p) => p.text).join('\n')).toContain('status note');
  });

  it("a job's done marker wins over a prompt it quotes", async () => {
    const { executor } = setup({ turns: [{ output: ['● The screen said:', "  You've hit your limit", '  HOPPER_DONE'] }] });
    expect((await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).kind).toBe('finished');
  });

  it('a warning in the footer under the input box is no limit', () => {
    const screen = ['> go', '● I go on.', '─'.repeat(40), '❯ ', '─'.repeat(40), "  You've hit your limit · resets 3pm (UTC)"].join('\n');
    expect(limitPromptOnTurn(screen, 'go')).toBeUndefined();
  });

  it('a limit dialog before anything was sent fails the job, and asks nobody', async () => {
    const lines = ['─'.repeat(40), ' You have reached your usage limit.', ' What do you want to do?', ' ❯ 1. Wait', '   2. Upgrade', '', ' Enter to confirm · Esc to cancel'];
    const { executor, herdr } = setup({ lateDialog: { lines, after: 1 }, turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && limitPromptOfFailure(out.error)).toEqual({ family: 'usage', prompt: 'You have reached your usage limit.' });
    expect(herdr.prompts).toEqual([]);
  });

  it('a Claude that exits at the prompt says the limit, not its exit', async () => {
    const herdr = { read: () => Promise.resolve(`$ claude --session-id x\n${WALL}\n$ `), runInPane: () => Promise.reject(new Error('gone')) };
    const error = await exitedError({ herdr, sleep: () => Promise.resolve() } as unknown as PaneWaitDeps, contextFor(jobWith({ prompt: 'go' })).ctx, 'p1');
    expect(limitPromptOfFailure(error)).toEqual({ family: 'access', prompt: WALL });
  });
});
