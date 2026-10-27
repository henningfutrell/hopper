// Issue #2848, part 2: model routing in Settings, an admin's — its draft, what a save sends, what is on in one sentence —, and
// a person's job budget on one job, its form and its line on the job view. Pure.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ROUTING } from '../../src/domain/model-routing.ts';
import { jobBudgetLine, jobBudgetPatch, modelRoutingDraftOf, modelRoutingPatch, modelRoutingSummary } from '../../ui/src/model/model-routing.ts';

const S = DEFAULT_MODEL_ROUTING;
const totals = { turns: 3, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, costUsd: 1.5, costKnown: true };

describe('model routing in Settings (issue #2848, part 2)', () => {
  it('says what is on', () => {
    expect(modelRoutingSummary(S)).toBe('Off: every job runs on the model its job source or its agent gives it.');
    expect(modelRoutingSummary({ ...S, on: true })).toBe('On for herdr-claude, claude: simple work runs on sonnet (budget: $5.00), other work on the agent\'s default (budget: the token budget\'s job caps). A cheap job that fails, stalls or reaches its budget escalates once to the strong model.');
    expect(modelRoutingSummary({ ...S, on: true, escalate: false, cheap: { model: 'haiku', jobTokens: 2_000_000, jobCostUsd: 0 } })).toMatch(/haiku \(budget: 2\.0M tokens\).*No escalation\.$/);
  });

  it('sends only the fields that changed, each whole', () => {
    const d = modelRoutingDraftOf(S);
    expect(modelRoutingPatch(S, d)).toEqual({ ok: true, patch: undefined });
    expect(modelRoutingPatch(S, { ...d, on: true, cheapCost: '2.5' })).toEqual({ ok: true, patch: { on: true, cheap: { model: 'sonnet', jobTokens: 0, jobCostUsd: 2.5 } } });
    expect(modelRoutingPatch(S, { ...d, executors: ' herdr-claude ,, codex ' })).toEqual({ ok: true, patch: { executors: ['herdr-claude', 'codex'] } });
    const rules = [{ name: 'docs', match: { label: 'docs' }, choice: 'cheap' }];
    expect(modelRoutingPatch(S, { ...d, rules: JSON.stringify(rules), repos: '{"o/a":{"cheap":{"jobCostUsd":1}}}' }))
      .toEqual({ ok: true, patch: { rules, repos: { 'o/a': { cheap: { jobCostUsd: 1 } } } } });
  });

  it('refuses a bad cap, rules that are no list and JSON that does not parse', () => {
    const d = modelRoutingDraftOf(S);
    expect(modelRoutingPatch(S, { ...d, strongTokens: '1.5' })).toEqual({ ok: false, error: 'Tokens: a whole number from 0' });
    expect(modelRoutingPatch(S, { ...d, cheapCost: '-1' })).toEqual({ ok: false, error: 'Cost: a number of US dollars from 0' });
    expect(modelRoutingPatch(S, { ...d, rules: '{}' })).toEqual({ ok: false, error: 'Rules: not the right shape' });
    expect(modelRoutingPatch(S, { ...d, repos: '[' })).toEqual({ ok: false, error: 'Repository budgets: not JSON' });
  });
});

describe('tuning from grades in Settings (issue #2848, part 3)', () => {
  it('edits tuning on and off, its least grades and its margin, and says it when on', () => {
    const d = modelRoutingDraftOf(S);
    expect(d).toMatchObject({ tuneOn: false, tuneMinSamples: '5', tuneMargin: '10' });
    expect(modelRoutingPatch(S, { ...d, tuneOn: true, tuneMargin: '15' })).toEqual({ ok: true, patch: { tune: { on: true, minSamples: 5, margin: 15 } } });
    expect(modelRoutingPatch(S, { ...d, tuneMinSamples: '0' })).toEqual({ ok: false, error: 'Grades: a whole number from 1' });
    expect(modelRoutingPatch(S, { ...d, tuneMargin: '101' })).toEqual({ ok: false, error: 'Margin: a number of points from 0 to 100' });
    expect(modelRoutingSummary({ ...S, on: true, tune: { on: true, minSamples: 5, margin: 10 } }))
      .toMatch(/ Grade history tunes the choice: at least 5 graded jobs of each model, a margin of 10 points\.$/);
  });
});

describe('a job budget (issue #2848, part 2)', () => {
  it('sends the caps that differ from the job\'s, and refuses a bad one', () => {
    expect(jobBudgetPatch(undefined, { jobTokens: '', jobCostUsd: '0' })).toEqual({ ok: true, patch: undefined });
    expect(jobBudgetPatch(undefined, { jobTokens: '0', jobCostUsd: '12' })).toEqual({ ok: true, patch: { jobCostUsd: 12 } });
    expect(jobBudgetPatch({ jobTokens: 5000, jobCostUsd: 12, at: 'x' }, { jobTokens: '0', jobCostUsd: '12' })).toEqual({ ok: true, patch: { jobTokens: 0 } });
    expect(jobBudgetPatch(undefined, { jobTokens: 'many', jobCostUsd: '0' })).toEqual({ ok: false, error: 'Tokens: a whole number from 0' });
  });

  it('says the job budget against what the job spent', () => {
    expect(jobBudgetLine(undefined, totals)).toBeUndefined();
    expect(jobBudgetLine({ jobTokens: 0, jobCostUsd: 0, at: 'x' }, totals)).toBeUndefined();
    expect(jobBudgetLine({ jobTokens: 10_000, jobCostUsd: 12, at: 'x', by: 'ada' }, totals)).toBe('Job budget: $1.50 of $12.00 · 2.0k of 10k tokens spent, set by ada');
    expect(jobBudgetLine({ jobTokens: 0, jobCostUsd: 12, at: 'x' }, undefined)).toBe('Job budget: $0.00 of $12.00 spent');
  });
});
