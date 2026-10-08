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
});
