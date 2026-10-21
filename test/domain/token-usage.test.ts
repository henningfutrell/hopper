// Issue #2302, part 1: the token ledger. A job's token use read from its agent session's log — the usage block of each
// assistant message, the same data ccusage reads — summed per model, with an estimated cost. Pure.
import { describe, expect, it } from 'vitest';
import { estimatedCostUsd, sessionTokenUse, sumTokenUse, type ModelTokenUse } from '../../src/domain/token-usage.ts';

const line = (o: object): string => JSON.stringify(o);
const assistant = (id: string, request: string, model: string, usage: object, at = '2026-10-21T08:00:00.000Z'): string =>
  line({ type: 'assistant', timestamp: at, requestId: request, sessionId: 's1', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'secret prompt text' }], usage } });

describe('the token use of an agent session (issue #2302)', () => {
  it('sums each assistant message once per model, the last line of a message winning', () => {
    const log = [
      line({ type: 'user', message: { role: 'user', content: 'do the work' } }),
      assistant('m1', 'r1', 'claude-opus-5-5', { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, '2026-10-21T08:00:00.000Z'),
      // The same message written again as it streamed on: counted once, at its last count.
      assistant('m1', 'r1', 'claude-opus-5-5', { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, '2026-10-21T08:00:01.000Z'),
      assistant('m2', 'r2', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, '2026-10-21T08:05:00.000Z'),
      assistant('m3', 'r3', 'claude-haiku-4-5', { input_tokens: 1000, output_tokens: 100 }, '2026-10-21T08:06:00.000Z'),
      'not json',
      '',
    ].join('\n');
    const use = sessionTokenUse(log);
    expect(use.first).toBe('2026-10-21T08:00:00.000Z');
    expect(use.last).toBe('2026-10-21T08:06:00.000Z');
    expect(use.models.map((m) => [m.model, m.turns, m.input, m.output, m.cacheRead, m.cacheWrite])).toEqual([
      ['claude-haiku-4-5', 1, 1000, 100, 0, 0],
      ['claude-opus-5-5', 2, 5, 45, 300, 50],
    ]);
  });

  it('keeps counts only: no text of the log is in what it gives', () => {
    const use = sessionTokenUse(assistant('m1', 'r1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }));
    expect(JSON.stringify(use)).not.toContain('secret prompt text');
  });

  it('counts no synthetic message and no line with no usage', () => {
    const log = [
      assistant('m1', 'r1', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
      line({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5' } }),
    ].join('\n');
    expect(sessionTokenUse(log).models).toEqual([]);
  });

  it('estimates the cost from the model\'s list price per million tokens', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, cache write at 1.25 × input.
    const cost = estimatedCostUsd('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    // A dated or prefixed id is its model.
    expect(estimatedCostUsd('claude-sonnet-4-6-20260101', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(3, 6);
    // A model with no known price has no estimate.
    expect(estimatedCostUsd('some-other-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });

  it('sums uses, model by model, the cost of each one estimated', () => {
    const a: ModelTokenUse = { model: 'claude-opus-5-5', turns: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const total = sumTokenUse([a, { ...a }, { ...a, model: 'mystery' }]);
    expect(total).toMatchObject({ turns: 3, input: 3, output: 6, cacheRead: 9, cacheWrite: 12 });
    expect(total.costUsd).toBeGreaterThan(0);
    expect(total.costKnown).toBe(false);
  });
});
