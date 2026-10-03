import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { PROTOCOL_FOOTER } from '../../src/executors/herdr/index.ts';
import { CWD, LANE, contextFor, jobWith, setup, until } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  JOB_HOPPER_DONE'] };

describe('herdr-claude executor: shape and validation', () => {
  const { executor } = setup();

  it('is herdr-claude, not idempotent, and resumes and cleans up', () => {
    expect(executor.name).toBe('herdr-claude');
    expect(executor.idempotent).toBe(false);
    expect(typeof executor.resume).toBe('function');
    expect(typeof executor.cleanup).toBe('function');
  });

  it.each([
    [{ prompt: 'go' }, null],
    [{ prompt: 'go', cwd: '/abs', model: 'opus', expectedMs: 1000, timeoutMs: 5000 }, null],
    [{ prompt: 'go', cwd: '~' }, null],
    [{ prompt: 'go', cwd: '~/x' }, null],
    [{}, 'prompt must be a non-empty string'],
    [{ prompt: '   ' }, 'prompt must be a non-empty string'],
    [{ prompt: 7 }, 'prompt must be a non-empty string'],
    [{ prompt: 'go', cwd: 'rel/dir' }, 'cwd must be an absolute path or start with ~'],
    [{ prompt: 'go', cwd: 3 }, 'cwd must be an absolute path or start with ~'],
    [{ prompt: 'go', model: 1 }, 'model must be a string'],
    [{ prompt: 'go', expectedMs: 0 }, 'expectedMs must be a positive number'],
    [{ prompt: 'go', timeoutMs: -1 }, 'timeoutMs must be a positive number'],
    [{ prompt: 'go', timeoutMs: 'x' }, 'timeoutMs must be a positive number'],
  ])('validate(%j) → %s', (payload, expected) => {
    expect(executor.validate(payload)).toBe(expected);
  });
});

describe('herdr-claude executor: run', () => {
  it('opens one tab in the job-hopper workspace, starts Claude, saves state before prompting', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { claudeArgs: ['--dangerously-skip-permissions'] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'Write hello.txt', model: 'opus' }));
    await executor.run(ctx);
    expect(herdr.calls.find((c) => c.method === 'ensureWorkspace')!.args).toEqual(['job-hopper', CWD]);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args).toEqual([{ workspaceId: 'w1', cwd: CWD, label: `${LANE} · abcdef12` }]);
    expect(herdr.agentStarts).toEqual([{ name: 'jh-abcdef12', paneId: 'w1:p1', args: ['--dangerously-skip-permissions', '--model', 'opus'], timeoutMs: 60000 }]);
    expect(saved[0]).toEqual({ session: 'jh-test', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', agentName: 'jh-abcdef12', cwd: CWD, laneId: LANE });
    const order = herdr.calls.map((c) => c.method);
    expect(order.indexOf('createTab')).toBeLessThan(order.indexOf('startAgent'));
  });

  it('expands ~ in the cwd', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go', cwd: '~/proj' })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ cwd: `${homedir()}/proj` });
  });

  it('sends the prompt exactly once, with the protocol footer', async () => {
    const { herdr, executor } = setup({ turns: [{ steps: ['● a', '● b', '● c'], ...DONE }] });
    await executor.run(contextFor(jobWith({ prompt: 'Write hello.txt' })).ctx);
    expect(herdr.prompts).toEqual([{ name: 'jh-abcdef12', text: `Write hello.txt\n\n${PROTOCOL_FOOTER}` }]);
  });

  it('finishes on JOB_HOPPER_DONE with the final assistant text and the pane id', async () => {
    const { executor } = setup({ turns: [DONE] });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx))
      .toEqual({ kind: 'finished', result: { summary: 'Wrote hello.txt.', paneId: 'w1:p1' } });
  });

  it('fails on JOB_HOPPER_FAILED with its reason', async () => {
    const { executor } = setup({ turns: [{ output: ['● I cannot.', '  JOB_HOPPER_FAILED no network access'] }] });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).toEqual({ kind: 'failed', error: 'no network access' });
  });

  it('asks on JOB_HOPPER_QUESTION, keeps the pane, and frees the lane mapping', async () => {
    const { herdr, executor } = setup({ turns: [{ output: ['● Which language?', '  JOB_HOPPER_QUESTION'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { text: 'Which language?', detectedBy: 'marker' } });
    expect(out.kind === 'question' && out.question.recentOutput).toContain('Which language?');
    expect(herdr.closed).toEqual([]);
    expect(executor.lanePanes().has(LANE)).toBe(false);
  });

  it('asks when Claude shows a question dialog (blocked)', async () => {
    const { executor } = setup({ turns: [{ output: ['● Pick one', '  ❯ 1. Red', '    2. Blue'], end: 'blocked' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('question');
    if (out.kind !== 'question') return;
    expect(out.question.detectedBy).toBe('blocked');
    expect(out.question.text).toContain('2. Blue');
  });

  it('asks after idleQuestionMs idle with no marker, not before', async () => {
    const { clock, executor } = setup({ turns: [{ output: ['● I made the change. Anything else?'] }] }, { idleQuestionMs: 20000 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'idle', text: 'I made the change. Anything else?' } });
    expect(clock.elapsed()).toBeGreaterThanOrEqual(20000);
  });

  it('fails when Claude exits, with its last output', async () => {
    const { executor } = setup({ turns: [{ output: ['● Segfault in the matrix'], end: 'exit' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error).toMatch(/^claude exited/);
    expect(out.kind === 'failed' && out.error).toContain('Segfault in the matrix');
  });

  it('times out per call: interrupts, exits Claude, closes the pane', async () => {
    const { herdr, clock, executor } = setup({ turns: [{ output: [], end: 'working' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: 5000 })).ctx);
    expect(out).toEqual({ kind: 'failed', error: 'timed out' });
    expect(clock.elapsed()).toBeLessThan(10000);
    expect(herdr.keys).toEqual([{ paneId: 'w1:p1', keys: ['esc'] }, { paneId: 'w1:p1', keys: ['ctrl+c', 'ctrl+c'] }]);
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('reports progress on each new assistant line, capped at 0.9 and non-decreasing', async () => {
    const { executor } = setup({ turns: [{ steps: ['● Reading files', '● Writing hello.txt'], ...DONE }] });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go', expectedMs: 2000 }));
    await executor.run(ctx);
    const messages = progress.map((p) => p.message);
    expect(messages).toEqual(expect.arrayContaining(['Reading files', 'Writing hello.txt']));
    expect(progress.every((p) => p.fraction >= 0 && p.fraction <= 0.9)).toBe(true);
    expect(progress.map((p) => p.fraction)).toEqual([...progress.map((p) => p.fraction)].sort((a, b) => a - b));
  });

  it('maps its lane to its pane while running', async () => {
    const { herdr, executor } = setup({ turns: [{ steps: ['● a', '● b', '● c', '● d'], ...DONE }] });
    const running = executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    await until(() => herdr.prompts.length === 1);
    const seen = executor.lanePanes().get(LANE);
    await running;
    expect(seen).toBe('w1:p1');
    expect(executor.lanePanes().has(LANE)).toBe(false);
  });

  it('accepts the folder-trust dialog for its own cwd and says so', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, turns: [DONE] });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(ctx)).kind).toBe('finished');
    expect(herdr.keys[0]).toEqual({ paneId: 'w1:p1', keys: ['down', 'enter'] });
    expect(progress.map((p) => p.message)).toContain(`trusted workdir ${CWD}`);
  });

  it('refuses a trust dialog naming another path: failed with the screen, pane closed', async () => {
    const { herdr, executor } = setup({ trustDialogFor: '/somewhere/else', turns: [DONE] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error).toContain('Quick safety check');
    expect(herdr.keys.some((k) => k.keys.includes('down'))).toBe(false);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('refuses its own trust dialog when trustWorkdir is false', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, turns: [DONE] }, { trustWorkdir: false });
    expect((await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).kind).toBe('failed');
    expect(herdr.prompts).toEqual([]);
  });

  it('fails with the screen on any other startup block', async () => {
    const { executor } = setup({ startupBlockedBy: ['Claude Code needs to update. Press enter.'] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toContain('needs to update');
  });

  it('never rejects: a herdr error becomes failed', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.failNext('createTab', 'workspace_not_found');
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/workspace_not_found/);
  });
});
