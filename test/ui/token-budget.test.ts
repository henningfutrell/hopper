// Issue #2302, part 3: the token budget in Settings, an admin's. What is on, in one sentence, and the change a save
// sends: only what differs, or why the draft is refused. Pure.
import { describe, expect, it } from 'vitest';
import { tokenBudgetPatch, tokenBudgetSummary } from '../../ui/src/model/token-ledger.ts';

const OFF = { jobTokens: 0, jobCostUsd: 0, dayTokens: 0, dayCostUsd: 0, repoDayTokens: 0, repoDayCostUsd: 0 };
const DRAFT = { jobTokens: '0', jobCostUsd: '0', dayTokens: '0', dayCostUsd: '0', repoDayTokens: '0', repoDayCostUsd: '0' };

describe('the token budget in Settings (issue #2302)', () => {
  it('says what is on', () => {
    expect(tokenBudgetSummary(OFF)).toBe('Off: no job is paused or held for what it spends.');
    expect(tokenBudgetSummary({ ...OFF, jobTokens: 5_000_000 })).toBe('A job is paused when it used 5.0M tokens.');
    expect(tokenBudgetSummary({ ...OFF, jobCostUsd: 2.5 })).toBe('A job is paused when it used an estimated $2.50.');
    expect(tokenBudgetSummary({ ...OFF, jobTokens: 12_000, jobCostUsd: 10 })).toBe('A job is paused when it used 12k tokens or an estimated $10.00, whichever comes first.');
  });

  it('sends only what changed, and refuses what is not a number from 0', () => {
    const s = OFF;
    expect(tokenBudgetPatch(s, { ...DRAFT, jobTokens: '0', jobCostUsd: '0' })).toEqual({ ok: true, patch: undefined });
    expect(tokenBudgetPatch(s, { ...DRAFT, jobTokens: '5000000', jobCostUsd: ' 0 ' })).toEqual({ ok: true, patch: { jobTokens: 5_000_000 } });
    expect(tokenBudgetPatch(s, { ...DRAFT, jobTokens: '', jobCostUsd: '2.5' })).toEqual({ ok: true, patch: { jobCostUsd: 2.5 } });
    expect(tokenBudgetPatch(s, { ...DRAFT, jobTokens: '1.5', jobCostUsd: '0' })).toEqual({ ok: false, error: 'Tokens: a whole number from 0' });
    expect(tokenBudgetPatch(s, { ...DRAFT, jobTokens: '0', jobCostUsd: '-1' })).toEqual({ ok: false, error: 'Cost: a number of US dollars from 0' });
  });

  it('says what the day caps hold (part 5)', () => {
    expect(tokenBudgetSummary({ ...OFF, dayTokens: 9_000_000 })).toBe('No job starts or goes on once the jobs used 9.0M tokens in a day (UTC).');
    expect(tokenBudgetSummary({ ...OFF, jobTokens: 5_000_000, repoDayCostUsd: 15 })).toBe('A job is paused when it used 5.0M tokens. No job of a repository starts or goes on once its jobs used an estimated $15.00 in a day (UTC).');
    expect(tokenBudgetSummary({ ...OFF, dayCostUsd: 40, repoDayTokens: 3_000_000 })).toBe('No job starts or goes on once the jobs used an estimated $40.00 in a day (UTC). No job of a repository starts or goes on once its jobs used 3.0M tokens in a day (UTC).');
  });

  it('sends the day caps that changed, and refuses a bad one', () => {
    expect(tokenBudgetPatch(OFF, { ...DRAFT, dayTokens: '9000000', repoDayCostUsd: '15' })).toEqual({ ok: true, patch: { dayTokens: 9_000_000, repoDayCostUsd: 15 } });
    expect(tokenBudgetPatch(OFF, { ...DRAFT, repoDayTokens: '2.5' })).toEqual({ ok: false, error: 'Tokens: a whole number from 0' });
    expect(tokenBudgetPatch(OFF, { ...DRAFT, dayCostUsd: 'x' })).toEqual({ ok: false, error: 'Cost: a number of US dollars from 0' });
  });
});
