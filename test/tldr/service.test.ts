// The TL;DR writer across a restart (issue #1608, design.md "TL;DR"): a text the model failed on is kept with the card,
// so a new writer on the same store does not ask for it again; a changed text is asked for. The real store, the model a
// double at its seam.
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import type { TldrWriter } from '../../src/domain/types.ts';
import { createTldrs } from '../../src/tldr/service.ts';
import { fixedClock, spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();

const LONG = ['## Branch', '', 'Which branch do I rebase the fix onto?', '', ...Array.from({ length: 8 }, (_, i) => `${i + 1}. branch \`b${i}\`: one of the options.`)].join('\n');

function writerOn(store: UserStore, answer: Awaited<ReturnType<TldrWriter>>) {
  const prompts: string[] = [];
  const tldrs = createTldrs({
    store, clock: fixedClock(), logger: { warn: () => {} }, sweepMs: 60_000, timeoutMs: 5_000,
    writer: async (prompt) => { prompts.push(prompt); return answer; },
  });
  return { prompts, tldrs };
}

describe('TL;DR failures are records (issue #1608)', () => {
  it('a text the model failed on is not asked again after a restart; a new text is', async () => {
    const s = t.open(t.url(), fixedClock());
    const job = s.jobs.create(spec, 5);
    const q = s.questions.create({ jobId: job.id, text: LONG, recentOutput: '', detectedBy: 'marker', tier: 'human' });
    const first = writerOn(s, { error: 'claude not found: claude' });
    await first.tldrs.sweep();
    await first.tldrs.stop();
    expect(first.prompts).toHaveLength(1);
    expect(s.questions.get(q.id)!.tldrFailedOf).toMatch(/^[0-9a-f]{64}$/);

    const second = writerOn(s, { text: 'Pick a branch.', model: 'claude-haiku-test' });
    await second.tldrs.sweep();
    expect(second.prompts).toHaveLength(0);
    s.questions.update(q.id, { text: `${LONG}\n\nOne more option.` });
    await second.tldrs.sweep();
    await second.tldrs.stop();
    expect(second.prompts).toHaveLength(1);
    const written = s.questions.get(q.id)!;
    expect(written.tldr?.text).toBe('Pick a branch.');
    expect(written.tldrFailedOf).toBeUndefined();
    s.close();
  });
});
