// Issue #2302, part 3: the token budget in Settings, an admin's. What is on, in one sentence, and the change a save
// sends: only what differs, or why the draft is refused. Pure.
import { describe, expect, it } from 'vitest';
import { tokenBudgetPatch, tokenBudgetSummary } from '../../ui/src/model/token-ledger.ts';

describe('the token budget in Settings (issue #2302)', () => {
  it('says what is on', () => {
    expect(tokenBudgetSummary({ jobTokens: 0, jobCostUsd: 0 })).toBe('Off: no job is paused for what it spends.');
    expect(tokenBudgetSummary({ jobTokens: 5_000_000, jobCostUsd: 0 })).toBe('A job is paused when it used 5.0M tokens.');
    expect(tokenBudgetSummary({ jobTokens: 0, jobCostUsd: 2.5 })).toBe('A job is paused when it used an estimated $2.50.');
    expect(tokenBudgetSummary({ jobTokens: 12_000, jobCostUsd: 10 })).toBe('A job is paused when it used 12k tokens or an estimated $10.00, whichever comes first.');
  });

  it('sends only what changed, and refuses what is not a number from 0', () => {
    const s = { jobTokens: 0, jobCostUsd: 0 };
    expect(tokenBudgetPatch(s, { jobTokens: '0', jobCostUsd: '0' })).toEqual({ ok: true, patch: undefined });
    expect(tokenBudgetPatch(s, { jobTokens: '5000000', jobCostUsd: ' 0 ' })).toEqual({ ok: true, patch: { jobTokens: 5_000_000 } });
    expect(tokenBudgetPatch(s, { jobTokens: '', jobCostUsd: '2.5' })).toEqual({ ok: true, patch: { jobCostUsd: 2.5 } });
    expect(tokenBudgetPatch(s, { jobTokens: '1.5', jobCostUsd: '0' })).toEqual({ ok: false, error: 'Tokens: a whole number from 0' });
    expect(tokenBudgetPatch(s, { jobTokens: '0', jobCostUsd: '-1' })).toEqual({ ok: false, error: 'Cost: a number of US dollars from 0' });
  });
});
