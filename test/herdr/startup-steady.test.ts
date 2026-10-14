// How long Claude's input box stays on screen before Claude is taken as ready (issue #533): 2 s by default, the
// executor's `promptSteadyMs` when set (issue #949: the tests set it short, so a job's start does not wait 2 s).
import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };

/** The fake clock's time when the job's prompt was sent. */
async function promptSentAt(promptSteadyMs?: number): Promise<number> {
  const { herdr, clock, executor } = setup({ turns: [DONE] }, promptSteadyMs !== undefined ? { promptSteadyMs } : {});
  let at: number | undefined;
  const prompt = herdr.prompt.bind(herdr);
  herdr.prompt = async (name, text) => { at ??= clock.elapsed(); return prompt(name, text); };
  const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
  expect(out.kind, JSON.stringify(out)).toBe('finished');
  return at!;
}

describe('herdr-claude executor: Claude ready at startup', () => {
  it('waits for the input box to stay up promptSteadyMs before the prompt is sent; 2 s by default', async () => {
    const byDefault = await promptSentAt();
    expect(await promptSentAt(2000)).toBe(byDefault);
    expect(await promptSentAt(10000)).toBe(byDefault + 8000);
  });
});
