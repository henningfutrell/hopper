import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, setup } from './support.ts';

describe('herdr-claude executor: a dialog as a question', () => {
  // Issue #377: the question is the dialog; the tool output above it goes in recentOutput only.
  it('asks the dialog itself, not the screen above it', async () => {
    const dialog = ['● Bash(npm ci)', '  ⎿  added 226 packages in 7s', '● Bash(rm -rf build)', '  ⎿  Waiting…', '─────────', ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    const { executor } = setup({ turns: [{ output: dialog, end: 'blocked' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked', text: 'Bash command\nrm -rf build\nDo you want to proceed?\n1. Yes\n2. No' } });
    if (out.kind === 'question') expect(out.question.recentOutput).toContain('added 226 packages');
  });

  // Issue #376: a dialog Claude Code denies by itself when its countdown runs out says so on the question.
  it('a dialog with a countdown: the question lapses when it runs out', async () => {
    const dialog = ['● Bash(rm -rf scratch)', ' Bash command', '   rm -rf scratch', ' ⚠ Claude Code will automatically deny this request in 1:59, to avoid blocking progress on an unattended session', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    const { executor, clock } = setup({ turns: [{ output: dialog, end: 'blocked' }] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    const lapsesAt = new Date(clock.now().getTime() + 119_000).toISOString();
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked', lapsesAt } });
    expect(saved.at(-1)).toMatchObject({ lapsesAt });
  });

  it('a dialog without a countdown never lapses', async () => {
    const { executor } = setup({ turns: [{ output: [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], end: 'blocked' }] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out.kind === 'question' && out.question.lapsesAt).toBe(undefined);
    expect((saved.at(-1) as { lapsesAt?: string }).lapsesAt).toBeUndefined();
  });

  // Issue #376: Claude Code denies a dangerous-rm dialog by itself after two minutes; the escalation to
  // a human takes longer, so the countdown is off in every job's tab, and a payload cannot turn it on.
  it("turns off Claude Code's countdown that denies a dangerous rm by itself", async () => {
    const { herdr, executor } = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    await executor.run(contextFor(jobWith({ prompt: 'go', env: { CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '0' } })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '1' } });
  });
});
