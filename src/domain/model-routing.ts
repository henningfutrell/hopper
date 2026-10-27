// Model routing (issue #2848, design.md "Model routing"): at intake the hopper reads the work's class — its size, kind,
// risk and repository — and the user's model rules pick the **cheap model** or the **strong model** for the job, with the
// job's budget from that choice. The item's next job after a failed cheap job runs on the strong model: escalated once,
// and the item stays there; so does a cheap job a person picks up after its budget paused it (part 2: a stalled cheap run
// goes on on the strong model, not on the cheap one again). The budget is enforced by the token budget's pause (issue
// #2302); a person's **job budget** on one job holds over it. Part 3: grade history (issue #2845) tunes a rule's choice,
// and a cheap job whose waste signals say it stalled is paused as its budget would pause it. Pure.
import { z } from 'zod';
import { glob } from './glob.ts';
import type { TokenWaste, TokenWasteKind } from './token-waste.ts';
import type { TokenBudgetSettings } from './token-budget.ts';
import { MAX_BUDGET_COST_USD, MAX_BUDGET_TOKENS } from './token-budget.ts';

export const MODEL_CHOICES = ['cheap', 'strong'] as const;
export type ModelChoice = typeof MODEL_CHOICES[number];
export const WORK_SIZES = ['small', 'large'] as const;
export const WORK_KINDS = ['code', 'research', 'proposal', 'tend'] as const;
export const WORK_RISKS = ['low', 'high'] as const;
export type WorkSize = typeof WORK_SIZES[number]; export type WorkKind = typeof WORK_KINDS[number]; export type WorkRisk = typeof WORK_RISKS[number];

/** A job's caps from its model choice; 0: the user's own job cap (the token budget) applies. */
export interface ModelBudget { jobTokens: number; jobCostUsd: number }
/** One model choice: the model its jobs run on ('' : the agent's own default, no `--model`) and its budget. */
export interface ModelChoiceSettings extends ModelBudget { model: string }
/** A model rule: the first whose every field matches the work picks the choice. */
export interface ModelRule {
  name: string;
  match: { repo?: string; label?: string; kind?: WorkKind; size?: WorkSize; risk?: WorkRisk };
  choice: ModelChoice;
}

export interface ModelRoutingSettings {
  /** Off: no job gets a model or a budget from model routing. */
  on: boolean;
  /** The executor instances whose jobs it routes: their agent takes the models' names (Claude Code's by default). */
  executors: string[];
  cheap: ModelChoiceSettings;
  strong: ModelChoiceSettings;
  /** In order; no rule matches: the strong model. */
  rules: ModelRule[];
  /** A repository's budget per choice, over the choice's own. */
  repos: Record<string, Partial<Record<ModelChoice, Partial<ModelBudget>>>>;
  /** The item's next job after a failed cheap job runs on the strong model. */
  escalate: boolean;
  /** Part 3: grade history tunes a rule's choice. */
  tune: ModelTuning;
}

/**
 * Tuning from grades (part 3): `minSamples` graded jobs of each choice on the work's repository, else on its kind of work,
 * and a cheap choice goes strong when the strong model's mean is higher by more than `margin` points (of 100).
 */
export interface ModelTuning { on: boolean; minSamples: number; margin: number }

/** A graded job as tuning reads it: its model choice, its work kind and repository, and its points (0 to 100). */
export interface GradedChoice { choice: ModelChoice; kind: string; repo?: string; points: number }

/** The class of the work, read at intake. */
export interface WorkClass { size: WorkSize; kind: WorkKind; risk: WorkRisk; repo?: string }

/** What model routing chose for a job, kept on its spec. */
export interface ModelRoute extends Omit<WorkClass, 'repo'> {
  choice: ModelChoice;
  /** The model the job runs on; '': the agent's own default. */
  model: string;
  /** The model rule that chose it; `label` (a job label), `escalated`, `grades` (tuned, part 3) or `default` (no rule matched). */
  rule: string;
  why: string;
  budget: ModelBudget;
  /** Set on the job that escalated, and on the item's later jobs: the earlier job whose failure escalated it. */
  escalated?: { from: ModelChoice; jobId: string };
}

/** The work as intake reads it. */
export interface WorkItem { title: string; body?: string; labels: readonly string[]; repo?: string; research?: boolean; proposal?: boolean; tend?: boolean }

/** The item's job before this one, as escalation reads it. */
export interface EarlierRoute { jobId: string; status: string; route?: ModelRoute }

export const DEFAULT_MODEL_RULES: ModelRule[] = [
  { name: 'risky-work', match: { risk: 'high' }, choice: 'strong' },
  { name: 'research', match: { kind: 'research' }, choice: 'strong' },
  { name: 'proposal', match: { kind: 'proposal' }, choice: 'strong' },
  { name: 'tend', match: { kind: 'tend' }, choice: 'cheap' },
  { name: 'small-work', match: { size: 'small' }, choice: 'cheap' },
];

export const DEFAULT_MODEL_ROUTING: ModelRoutingSettings = {
  on: false, executors: ['herdr-claude', 'claude'],
  cheap: { model: 'sonnet', jobTokens: 0, jobCostUsd: 5 }, strong: { model: '', jobTokens: 0, jobCostUsd: 0 },
  rules: DEFAULT_MODEL_RULES, repos: {}, escalate: true, tune: { on: false, minSamples: 5, margin: 10 },
};

/** The labels that pick the choice over every rule. */
export const MODEL_LABELS: Record<string, ModelChoice> = { 'hopper:model-cheap': 'cheap', 'hopper:model-strong': 'strong' };
/** Rule names model routing writes itself: no model rule may take one. */
const RESERVED = ['label', 'escalated', 'grades', 'default'];

/** The most a small item's text holds: characters, and list items (steps). */
export const SMALL_WORK = { chars: 1500, steps: 6 } as const;
const SIZE_LABELS: Record<string, WorkSize> = { 'size:small': 'small', 'size:s': 'small', 'size:xs': 'small', 'good first issue': 'small', 'size:large': 'large', 'size:l': 'large', 'size:xl': 'large', epic: 'large' };
const RISK_LABELS = ['security', 'risk:high', 'breaking', 'breaking-change', 'migration'];
const RISK_WORDS = /\b(security|vulnerab\w*|migrations?|auth|authentication|authorization|credentials?|secrets?|encrypt\w*|permissions?)\b/i;

const lower = (s: string) => s.toLowerCase();

export function classifyWork(w: WorkItem): WorkClass {
  const labels = w.labels.map(lower);
  const body = w.body ?? '';
  const steps = body.split('\n').filter((l) => /^\s*([-*+]|\d+[.)])\s/.test(l)).length;
  const sized = labels.map((l) => SIZE_LABELS[l]).find((s) => s !== undefined);
  const size: WorkSize = sized ?? (body.length <= SMALL_WORK.chars && steps <= SMALL_WORK.steps ? 'small' : 'large');
  const kind: WorkKind = w.research ? 'research' : w.proposal ? 'proposal' : w.tend ? 'tend' : 'code';
  const risk: WorkRisk = labels.some((l) => RISK_LABELS.includes(l)) || RISK_WORDS.test(w.title) ? 'high' : 'low';
  return { size, kind, risk, ...(w.repo !== undefined ? { repo: w.repo } : {}) };
}

function ruleMatches(r: ModelRule, c: WorkClass, labels: readonly string[]): boolean {
  const m = r.match;
  if (m.repo !== undefined && (c.repo === undefined || !glob(m.repo, c.repo))) return false;
  if (m.label !== undefined && !labels.some((l) => lower(l) === lower(m.label!))) return false;
  return (m.kind === undefined || m.kind === c.kind) && (m.size === undefined || m.size === c.size) && (m.risk === undefined || m.risk === c.risk);
}

const matchText = (r: ModelRule): string => {
  const m = r.match;
  const parts = [m.risk === 'high' ? 'high-risk' : m.risk === 'low' ? 'low-risk' : undefined, m.size, m.kind ?? 'code', 'work',
    m.repo !== undefined ? `in ${m.repo}` : undefined, m.label !== undefined ? `labelled ${m.label}` : undefined];
  return parts.filter((p) => p !== undefined).join(' ');
};

/** The job's budget from the choice: the repository's over the choice's own. */
function budgetOf(s: ModelRoutingSettings, choice: ModelChoice, repo: string | undefined): ModelBudget {
  const own = repo === undefined ? undefined : s.repos[repo]?.[choice];
  return { jobTokens: own?.jobTokens ?? s[choice].jobTokens, jobCostUsd: own?.jobCostUsd ?? s[choice].jobCostUsd };
}

const mean = (xs: number[]): number => Math.round(xs.reduce((n, x) => n + x, 0) / xs.length);

/**
 * A rule's choice tuned by grade history (part 3): on the work's repository when both choices have `minSamples` graded
 * jobs of its kind there, else on its kind. A cheap choice goes strong when the strong model's mean is higher by more than
 * the margin; a low-risk strong choice goes cheap when the cheap model's is as high. Else the rule's choice stands. A tend
 * job is graded as code work.
 */
function tuned(s: ModelRoutingSettings, r: ModelRoute, graded: readonly GradedChoice[], repo: string | undefined): ModelRoute {
  const kind = r.kind === 'tend' ? 'code' : r.kind;
  const ofKind = graded.filter((g) => g.kind === kind);
  const at = repo?.toLowerCase();
  const scopes: [string, GradedChoice[]][] = [...(at ? [[`in ${repo}`, ofKind.filter((g) => g.repo?.toLowerCase() === at)] as [string, GradedChoice[]]] : []), [`in ${kind} work`, ofKind]];
  for (const [where, rows] of scopes) {
    const cheap = rows.filter((g) => g.choice === 'cheap').map((g) => g.points), strong = rows.filter((g) => g.choice === 'strong').map((g) => g.points);
    if (cheap.length < s.tune.minSamples || strong.length < s.tune.minSamples) continue;
    const c = mean(cheap), st = mean(strong);
    const to: ModelChoice | undefined = r.choice === 'cheap' && st - c > s.tune.margin ? 'strong' : r.choice === 'strong' && r.risk === 'low' && c >= st ? 'cheap' : undefined;
    if (!to) return r;
    const scored = `the cheap model's ${kind} jobs scored ${c} (${cheap.length} jobs) and the strong model's ${st} (${strong.length} jobs)`;
    const picked = r.rule === 'default' ? 'no rule matched' : `rule ${r.rule} picked`;
    return { ...r, choice: to, model: s[to].model, rule: 'grades', budget: budgetOf(s, to, repo),
      why: `Grades: ${where} ${scored}, so the ${to} model, not the ${r.choice} one ${picked}.` };
  }
  return r;
}

/**
 * The model route of a new job, or undefined: model routing is off, or the job's executor is not one it routes. `earlier`:
 * the item's job before it. A failed cheap job escalates its item to the strong model once; an escalated item stays there.
 * `graded`: the grade history tuning reads (part 3), read only while tuning is on.
 */
export function modelRouteOf(s: ModelRoutingSettings, w: WorkItem, executor: string, earlier?: EarlierRoute, graded?: () => readonly GradedChoice[]): ModelRoute | undefined {
  if (!s.on || !s.executors.includes(executor)) return undefined;
  const c = classifyWork(w);
  const route = (choice: ModelChoice, rule: string, why: string, escalated?: ModelRoute['escalated']): ModelRoute =>
    ({ choice, model: s[choice].model, rule, size: c.size, kind: c.kind, risk: c.risk, why, budget: budgetOf(s, choice, w.repo), ...(escalated ? { escalated } : {}) });
  const was = earlier?.route;
  if (was?.escalated) return route('strong', 'escalated', `Escalated: the cheap model's job ${was.escalated.jobId} failed, so this item runs on the strong model.`, was.escalated);
  if (s.escalate && earlier && was?.choice === 'cheap' && earlier.status === 'failed') {
    return route('strong', 'escalated', `Escalated: the cheap model's job ${earlier.jobId} failed, so this job runs on the strong model.`, { from: 'cheap', jobId: earlier.jobId });
  }
  const label = w.labels.map(lower).find((l) => MODEL_LABELS[l] !== undefined);
  if (label) return route(MODEL_LABELS[label]!, 'label', `The job's label ${label} picks the ${MODEL_LABELS[label]} model.`);
  const r = s.rules.find((x) => ruleMatches(x, c, w.labels));
  const ruled = r ? route(r.choice, r.name, `Rule ${r.name}: ${matchText(r)} goes to the ${r.choice} model.`) : route('strong', 'default', 'No model rule matched: the strong model.');
  return s.tune.on && graded ? tuned(s, ruled, graded(), w.repo) : ruled;
}

/** A person's caps on one job (part 2), over its route's and the user's: each 0 falls back to them. Kept on the job. */
export interface JobBudget extends ModelBudget { at: string; by?: string }

/** The caps that hold for the job: its job budget's, else its route's, else the user's job cap; a 0 falls back. */
export function jobBudgetOf(route: ModelRoute | undefined, user: TokenBudgetSettings, own?: ModelBudget): TokenBudgetSettings {
  const pick = (k: keyof ModelBudget): number => (own && own[k] > 0 ? own[k] : route && route.budget[k] > 0 ? route.budget[k] : user[k]);
  return { ...user, jobTokens: pick('jobTokens'), jobCostUsd: pick('jobCostUsd') };
}

/**
 * The route a cheap job goes on with when a person picks it up after its budget paused it (part 2), or a stall (part 3): the strong model and
 * its budget, escalated from the job itself; undefined: routing or escalation is off, or the job is not on the cheap model.
 */
export function escalateOnPickUp(s: ModelRoutingSettings, route: ModelRoute | undefined, jobId: string, repo: string | undefined, stalled = false): ModelRoute | undefined {
  if (!s.on || !s.escalate || route?.choice !== 'cheap') return undefined;
  return { ...route, choice: 'strong', model: s.strong.model, rule: 'escalated', budget: budgetOf(s, 'strong', repo), escalated: { from: 'cheap', jobId },
    why: `Escalated: the cheap model ${stalled ? 'stalled' : 'reached its budget'} in job ${jobId}, so the job goes on on the strong model.` };
}

/** The waste signals that say a cheap run stalled (part 3): no progress, or tests that fail again and again. */
export const STALL_SIGNALS: readonly TokenWasteKind[] = ['no_progress', 'failing_tests'];

/**
 * Why a running cheap job is paused as stalled (part 3), or undefined: routing or escalation is off, the job is not on the
 * cheap model, or no stall signal. Picked up, it goes on on the strong model (`escalateOnPickUp`).
 */
export function cheapStallOf(s: ModelRoutingSettings, route: ModelRoute | undefined, waste: readonly TokenWaste[]): string | undefined {
  if (!s.on || !s.escalate || route?.choice !== 'cheap') return undefined;
  const stalled = waste.filter((w) => STALL_SIGNALS.includes(w.kind));
  return stalled.length > 0 ? `Paused: the cheap model stalled. ${stalled.map((w) => w.why).join(' ')} Picked up, the job goes on on the strong model.` : undefined;
}

const text = z.string().trim().min(1).max(200);
const tokens = z.number().int().min(0).max(MAX_BUDGET_TOKENS);
const cost = z.number().min(0).max(MAX_BUDGET_COST_USD);
/** A model alias or id, as the agent CLI takes it; '' for the agent's own default. */
const model = z.string().regex(/^$|^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, 'model must be a model alias or id, or empty for the agent\'s default');
const choiceSettings = z.strictObject({ model, jobTokens: tokens, jobCostUsd: cost });
const rule = z.strictObject({
  name: text.refine((n) => !RESERVED.includes(n), `a rule name may not be ${RESERVED.join(', ')}: those are reserved`),
  match: z.strictObject({ repo: text.optional(), label: text.optional(), kind: z.enum(WORK_KINDS).optional(), size: z.enum(WORK_SIZES).optional(), risk: z.enum(WORK_RISKS).optional() }),
  choice: z.enum(MODEL_CHOICES),
});
const repoBudget = z.strictObject({ jobTokens: tokens.optional(), jobCostUsd: cost.optional() });
/** A person's job budget, as they set it: either cap, or both; 0 takes it off. */
export const jobBudgetBody = repoBudget.refine((b) => b.jobTokens !== undefined || b.jobCostUsd !== undefined, { message: 'name jobTokens or jobCostUsd' });

/** The whole setting, as stored and as an admin saves it. */
export const MODEL_ROUTING = z.strictObject({
  on: z.boolean(), executors: z.array(text).max(50), cheap: choiceSettings, strong: choiceSettings,
  rules: z.array(rule).max(100).superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const r of rules) {
      if (seen.has(r.name)) ctx.addIssue({ code: 'custom', message: `rule ${r.name} named twice; a job records the rule by name` });
      seen.add(r.name);
    }
  }),
  repos: z.record(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'a repository is owner/name'), z.strictObject({ cheap: repoBudget.optional(), strong: repoBudget.optional() })),
  escalate: z.boolean(),
  tune: z.strictObject({ on: z.boolean(), minSamples: z.number().int().min(1).max(1000), margin: z.number().min(0).max(100) }),
});
/** The setting as an event holds it: one from before part 3 has no `tune`. */
export const MODEL_ROUTING_RECORDED = MODEL_ROUTING.extend({ tune: MODEL_ROUTING.shape.tune.optional() });

/** Why a setting is refused, or undefined. */
export function modelRoutingProblem(raw: unknown): string | undefined {
  const r = MODEL_ROUTING.safeParse(raw);
  return r.success ? undefined : r.error.issues.map((i) => `${i.path.join('.') || 'modelRouting'}: ${i.message}`).join('; ');
}

/** The stored setting over the defaults: a field a setting stored before it does not name takes its default. */
export const modelRoutingOf = (s: Partial<ModelRoutingSettings> | undefined): ModelRoutingSettings => ({ ...DEFAULT_MODEL_ROUTING, ...s });
