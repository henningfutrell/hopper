// Issue #2302, part 6: the token use a print-mode Claude turn answers in its JSON result (`modelUsage`), and a turn's use
// added to what the ledger holds of its session. Pure.
import { describe, expect, it } from 'vitest';
import { printTurnTokenUse, withTurnUse, type TokenLedgerEntry } from '../../src/domain/token-usage.ts';

const AT = { first: '2026-10-21T08:00:00.000Z', last: '2026-10-21T08:03:00.000Z' };

describe('the token use of a print-mode Claude turn (issue #2302)', () => {
  it('reads each model of modelUsage, the turns on the model that wrote most, and the one-hour cache write of a one-model turn', () => {
    const result = {
      type: 'result', is_error: false, num_turns: 7, result: 'secret answer text', session_id: 's1',
      usage: { input_tokens: 9, output_tokens: 90, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 30 } },
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 10, outputTokens: 100, cacheReadInputTokens: 1000, cacheCreationInputTokens: 50, costUSD: 0.5 },
        'claude-haiku-4-5': { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    };
    const use = printTurnTokenUse(result, AT)!;
    expect(use).toEqual({
      ...AT,
      models: [
        { model: 'claude-haiku-4-5', turns: 0, input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
        { model: 'claude-opus-5-5', turns: 7, input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 },
      ],
    });
    expect(JSON.stringify(use)).not.toContain('secret answer text');
    const one = printTurnTokenUse({ ...result, modelUsage: { 'claude-opus-5-5': result.modelUsage['claude-opus-5-5'] } }, AT)!;
    expect(one.models).toEqual([{ model: 'claude-opus-5-5', turns: 7, input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, cacheWrite1h: 30 }]);
  });

  it('reads nothing from a result with no modelUsage, or with none spent', () => {
    expect(printTurnTokenUse({ type: 'result', result: 'x' }, AT)).toBeUndefined();
    expect(printTurnTokenUse({ modelUsage: { 'claude-opus-5-5': { inputTokens: 0, outputTokens: 0 } } }, AT)).toBeUndefined();
    expect(printTurnTokenUse('not an object', AT)).toBeUndefined();
  });
});

describe('a turn added to its session in the ledger (issue #2302)', () => {
  const row = (model: string, n: number, more: Partial<TokenLedgerEntry> = {}): TokenLedgerEntry => ({
    jobId: 'j1', session: 's1', readAt: '2026-10-21T07:00:00.000Z', model, turns: n, input: n, output: n, cacheRead: n, cacheWrite: n, first: '2026-10-21T07:00:00.000Z', last: '2026-10-21T07:30:00.000Z', ...more,
  });

  it('sums each model\'s counts with the session\'s rows, keeps a model only one of them has, and widens the times', () => {
    const before = [row('claude-opus-5-5', 2, { cacheWrite1h: 1, failedTests: 1 }), row('claude-haiku-4-5', 3)];
    const turn = { ...AT, models: [{ model: 'claude-opus-5-5', turns: 1, input: 10, output: 10, cacheRead: 10, cacheWrite: 10, cacheWrite1h: 4 }, { model: 'claude-sonnet-5-5', turns: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] };
    expect(withTurnUse(before, turn)).toEqual({
      first: '2026-10-21T07:00:00.000Z', last: AT.last,
      models: [
        { model: 'claude-haiku-4-5', turns: 3, input: 3, output: 3, cacheRead: 3, cacheWrite: 3 },
        { model: 'claude-opus-5-5', turns: 3, input: 12, output: 12, cacheRead: 12, cacheWrite: 12, cacheWrite1h: 5, failedTests: 1 },
        { model: 'claude-sonnet-5-5', turns: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      ],
    });
  });

  it('is the turn itself for a session the ledger does not hold', () => {
    const turn = { ...AT, models: [{ model: 'claude-opus-5-5', turns: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] };
    expect(withTurnUse([], turn)).toEqual(turn);
  });
});
