// Found live (phase 3 demo): after a long prompt Claude Code's transcript stays scrolled up and
// the reply, with its marker, sits behind "1 new message (ctrl+End) ↓". The executor must scroll
// to the end before judging, or it raises a false idle question whose text is the indicator.
import { describe, expect, it } from 'vitest';
import { CTRL_END, readTurn } from '../../src/executors/herdr/index.ts';
import { contextFor, jobWith, setup } from './support.ts';

describe('a transcript left scrolled up', () => {
  it('scrolls with Ctrl+End and reads the real question and its marker', async () => {
    const { herdr, executor } = setup({ turns: [{ hiddenUntilScrolled: true, output: ['● What is your favourite word?', '  JOB_HOPPER_QUESTION'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { text: 'What is your favourite word?', detectedBy: 'marker' } });
    expect(herdr.texts.map((t) => t.text)).toContain(CTRL_END);
  });

  it('scrolls and sees JOB_HOPPER_DONE instead of asking a false idle question', async () => {
    const { executor } = setup({ turns: [{ hiddenUntilScrolled: true, output: ['● Wrote the file.', '  JOB_HOPPER_DONE'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'finished' });
  });

  it('never reports the new-message indicator as progress or question text', () => {
    const screen = ['❯ go', '● Working on it', '                    1 new message (ctrl+End) ↓', '─'.repeat(40), '❯ '].join('\n');
    expect(readTurn(screen, 'go').lastLine).toBe('Working on it');
  });
});
