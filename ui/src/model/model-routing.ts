// Model routing's words and forms (issue #2848, part 2): the setting in Settings, an admin's, as a draft a person edits —
// on and off, escalation, the executors, each model choice's model and budget, and the rules and the repositories' budgets as
// JSON —, what a save sends, and what is on in one sentence; a person's job budget on one job, its form and its line. Pure.
import { tokenCount, tokensOf } from './token-ledger';
import type { JobBudget, ModelBudget, ModelRoutingSettings, TokenTotals } from './wire';

type Choice = 'cheap' | 'strong';

export interface ModelRoutingDraft {
  on: boolean; escalate: boolean; executors: string;
  cheapModel: string; cheapTokens: string; cheapCost: string;
  strongModel: string; strongTokens: string; strongCost: string;
  rules: string; repos: string;
}

export const modelRoutingDraftOf = (s: ModelRoutingSettings): ModelRoutingDraft => ({
  on: s.on, escalate: s.escalate, executors: s.executors.join(', '),
  cheapModel: s.cheap.model, cheapTokens: String(s.cheap.jobTokens), cheapCost: String(s.cheap.jobCostUsd),
  strongModel: s.strong.model, strongTokens: String(s.strong.jobTokens), strongCost: String(s.strong.jobCostUsd),
  rules: JSON.stringify(s.rules, null, 2), repos: JSON.stringify(s.repos, null, 2),
});

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A cap as a person typed it: empty is 0; tokens a whole number. */
function capOf(text: string, whole: boolean): Checked<number> {
  const n = Number(text.trim() || '0');
  if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) return { ok: false, error: whole ? 'Tokens: a whole number from 0' : 'Cost: a number of US dollars from 0' };
  return { ok: true, value: n };
}

function jsonOf<T>(text: string, what: string, shape: (v: unknown) => boolean): Checked<T> {
  try {
    const v: unknown = JSON.parse(text);
    return shape(v) ? { ok: true, value: v as T } : { ok: false, error: `${what}: not the right shape` };
  } catch {
    return { ok: false, error: `${what}: not JSON` };
  }
}

/**
 * The change a save sends: the fields that differ, each whole (undefined: nothing to save), or why the draft is refused. The
 * daemon checks the rest (a model name, a rule's fields) and answers why it refuses.
 */
export function modelRoutingPatch(s: ModelRoutingSettings, d: ModelRoutingDraft): { ok: true; patch: Partial<ModelRoutingSettings> | undefined } | { ok: false; error: string } {
  const choice = (c: Choice): Checked<ModelRoutingSettings[Choice]> => {
    const tokens = capOf(d[`${c}Tokens`], true), cost = capOf(d[`${c}Cost`], false);
    if (!tokens.ok) return tokens;
    if (!cost.ok) return cost;
    return { ok: true, value: { model: d[`${c}Model`].trim(), jobTokens: tokens.value, jobCostUsd: cost.value } };
  };
  const cheap = choice('cheap'), strong = choice('strong');
  if (!cheap.ok) return cheap;
  if (!strong.ok) return strong;
  const rules = jsonOf<ModelRoutingSettings['rules']>(d.rules, 'Rules', Array.isArray);
  if (!rules.ok) return rules;
  const repos = jsonOf<ModelRoutingSettings['repos']>(d.repos, 'Repository budgets', (v) => typeof v === 'object' && v !== null && !Array.isArray(v));
  if (!repos.ok) return repos;
  const to: ModelRoutingSettings = {
    on: d.on, escalate: d.escalate, executors: d.executors.split(',').map((e) => e.trim()).filter((e) => e !== ''),
    cheap: cheap.value, strong: strong.value, rules: rules.value, repos: repos.value,
  };
  const keys = (Object.keys(to) as (keyof ModelRoutingSettings)[]).filter((k) => JSON.stringify(to[k]) !== JSON.stringify(s[k]));
  return { ok: true, patch: keys.length > 0 ? Object.fromEntries(keys.map((k) => [k, to[k]])) as Partial<ModelRoutingSettings> : undefined };
}

const budgetText = (b: ModelBudget): string => {
  const caps = [b.jobCostUsd > 0 ? `$${b.jobCostUsd.toFixed(2)}` : undefined, b.jobTokens > 0 ? `${tokenCount(b.jobTokens)} tokens` : undefined].filter((c) => c !== undefined);
  return caps.length > 0 ? caps.join(' or ') : 'the token budget\'s job caps';
};

/** What is on, in one sentence. */
export function modelRoutingSummary(s: ModelRoutingSettings): string {
  if (!s.on) return 'Off: every job runs on the model its job source or its agent gives it.';
  const model = (c: Choice) => s[c].model || 'the agent\'s default';
  return `On for ${s.executors.join(', ') || 'no executor'}: simple work runs on ${model('cheap')} (budget: ${budgetText(s.cheap)}), other work on ${model('strong')} (budget: ${budgetText(s.strong)}). `
    + (s.escalate ? 'A cheap job that fails or reaches its budget escalates once to the strong model.' : 'No escalation.');
}

export interface JobBudgetDraft { jobTokens: string; jobCostUsd: string }

/** A job budget's change: the caps that differ from what the job has (undefined: nothing to save), or why it is refused. */
export function jobBudgetPatch(own: JobBudget | undefined, d: JobBudgetDraft): { ok: true; patch: Partial<ModelBudget> | undefined } | { ok: false; error: string } {
  const tokens = capOf(d.jobTokens, true), cost = capOf(d.jobCostUsd, false);
  if (!tokens.ok) return tokens;
  if (!cost.ok) return cost;
  const patch: Partial<ModelBudget> = {};
  if (tokens.value !== (own?.jobTokens ?? 0)) patch.jobTokens = tokens.value;
  if (cost.value !== (own?.jobCostUsd ?? 0)) patch.jobCostUsd = cost.value;
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}

/** A job's own budget against its spend, as its job view says it; undefined: none set, or every cap 0. */
export function jobBudgetLine(own: JobBudget | undefined, spent: TokenTotals | undefined): string | undefined {
  if (!own) return undefined;
  const caps = [
    own.jobCostUsd > 0 ? `$${(spent?.costUsd ?? 0).toFixed(2)} of $${own.jobCostUsd.toFixed(2)}` : undefined,
    own.jobTokens > 0 ? `${tokenCount(spent ? tokensOf(spent) : 0)} of ${tokenCount(own.jobTokens)} tokens` : undefined,
  ].filter((c) => c !== undefined);
  return caps.length > 0 ? `Job budget: ${caps.join(' · ')} spent${own.by ? `, set by ${own.by}` : ''}` : undefined;
}
