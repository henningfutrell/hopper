// Model routing (issue #2848): the work's class at intake picks the cheap or the strong model and the job's budget; a
// failed cheap job's next job of the item escalates once to the strong model. Pure.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_ROUTING, cheapStallOf, classifyWork, escalateOnPickUp, jobBudgetOf, modelRouteOf, modelRoutingOf, modelRoutingProblem, type GradedChoice, type ModelRoute,
  type ModelRoutingSettings, type WorkItem,
} from '../../src/domain/model-routing.ts';
import { DEFAULT_TOKEN_BUDGET, budgetNear } from '../../src/domain/token-budget.ts';

const on: ModelRoutingSettings = { ...DEFAULT_MODEL_ROUTING, on: true };
const work = (over: Partial<WorkItem> = {}): WorkItem => ({ title: 'Fix the typo in the README', body: 'One word is wrong.', labels: [], repo: 'o/r', ...over });
const LONG = Array.from({ length: 12 }, (_, i) => `- [ ] step ${i}: change the module and its tests`).join('\n');

describe('classifyWork', () => {
  it('reads a short item as small, a long one or one with many steps as large', () => {
    expect(classifyWork(work())).toMatchObject({ size: 'small', kind: 'code', risk: 'low', repo: 'o/r' });
    expect(classifyWork(work({ body: 'x'.repeat(3000) })).size).toBe('large');
    expect(classifyWork(work({ body: LONG })).size).toBe('large');
  });

  it('takes the size from a size label first', () => {
    expect(classifyWork(work({ body: LONG, labels: ['size:small'] })).size).toBe('small');
    expect(classifyWork(work({ labels: ['size:L'] })).size).toBe('large');
  });

  it('reads the kind from the job: research, proposal, tend, else code', () => {
    expect(classifyWork(work({ research: true, proposal: true })).kind).toBe('research');
    expect(classifyWork(work({ proposal: true })).kind).toBe('proposal');
    expect(classifyWork(work({ tend: true })).kind).toBe('tend');
  });

  it('reads high risk from a label or a risky word in the title', () => {
    expect(classifyWork(work({ labels: ['security'] })).risk).toBe('high');
    expect(classifyWork(work({ labels: ['risk:high'] })).risk).toBe('high');
    expect(classifyWork(work({ title: 'Database migration for the vault' })).risk).toBe('high');
    expect(classifyWork(work({ title: 'Rotate the auth secret' })).risk).toBe('high');
    expect(classifyWork(work({ title: 'Author list in the footer' })).risk).toBe('low');
  });
});

describe('modelRouteOf', () => {
  it('routes nothing while model routing is off, or for an executor it does not cover', () => {
    expect(modelRouteOf(DEFAULT_MODEL_ROUTING, work(), 'herdr-claude')).toBeUndefined();
    expect(modelRouteOf(on, work(), 'codex')).toBeUndefined();
  });

  it('routes simple work to the cheap model and complex or risky work to the strong one, by the default rules', () => {
    expect(modelRouteOf(on, work(), 'herdr-claude')).toEqual({
      choice: 'cheap', model: 'sonnet', rule: 'small-work', size: 'small', kind: 'code', risk: 'low',
      why: 'Rule small-work: small code work goes to the cheap model.', budget: { jobTokens: 0, jobCostUsd: 5 },
    });
    expect(modelRouteOf(on, work({ body: LONG }), 'herdr-claude')).toMatchObject({ choice: 'strong', model: '', rule: 'default', budget: { jobTokens: 0, jobCostUsd: 0 } });
    expect(modelRouteOf(on, work({ labels: ['security'] }), 'herdr-claude')).toMatchObject({ choice: 'strong', rule: 'risky-work' });
    expect(modelRouteOf(on, work({ research: true }), 'claude')).toMatchObject({ choice: 'strong', rule: 'research' });
    expect(modelRouteOf(on, work({ tend: true, body: LONG }), 'herdr-claude')).toMatchObject({ choice: 'cheap', rule: 'tend' });
  });

  it('takes the first rule that matches, by repository and label too', () => {
    const s: ModelRoutingSettings = { ...on, rules: [{ name: 'docs', match: { repo: 'o/docs-*', label: 'docs' }, choice: 'cheap' }, ...on.rules] };
    expect(modelRouteOf(s, work({ repo: 'o/docs-site', labels: ['Docs'], body: LONG }), 'herdr-claude')).toMatchObject({ choice: 'cheap', rule: 'docs' });
    expect(modelRouteOf(s, work({ repo: 'o/app', labels: ['docs'], body: LONG }), 'herdr-claude')).toMatchObject({ choice: 'strong', rule: 'default' });
  });

  it('lets a job label pick the model over every rule', () => {
    expect(modelRouteOf(on, work({ labels: ['hopper:model-strong'] }), 'herdr-claude')).toMatchObject({ choice: 'strong', rule: 'label' });
    expect(modelRouteOf(on, work({ labels: ['hopper:model-cheap', 'security'] }), 'herdr-claude')).toMatchObject({ choice: 'cheap', rule: 'label' });
  });

  it('takes a repository\'s budget over the choice\'s', () => {
    const s: ModelRoutingSettings = { ...on, repos: { 'o/r': { cheap: { jobCostUsd: 2 } } } };
    expect(modelRouteOf(s, work(), 'herdr-claude')!.budget).toEqual({ jobTokens: 0, jobCostUsd: 2 });
    expect(modelRouteOf(s, work({ repo: 'o/other' }), 'herdr-claude')!.budget).toEqual({ jobTokens: 0, jobCostUsd: 5 });
  });

  it('escalates once to the strong model after the item\'s cheap job failed', () => {
    const cheap = modelRouteOf(on, work(), 'herdr-claude')!;
    const escalated = modelRouteOf(on, work(), 'herdr-claude', { jobId: 'j1', status: 'failed', route: cheap })!;
    expect(escalated).toMatchObject({
      choice: 'strong', model: '', rule: 'escalated', escalated: { from: 'cheap', jobId: 'j1' },
      why: 'Escalated: the cheap model\'s job j1 failed, so this job runs on the strong model.',
    });
    // The item stays on the strong model: its next job does not drop back, and records no second escalation.
    const after = modelRouteOf(on, work(), 'herdr-claude', { jobId: 'j2', status: 'failed', route: escalated })!;
    expect(after).toMatchObject({ choice: 'strong', rule: 'escalated', escalated: { from: 'cheap', jobId: 'j1' } });
    // A cheap job that did not fail, or escalation turned off, routes by the rules again.
    expect(modelRouteOf(on, work(), 'herdr-claude', { jobId: 'j1', status: 'finished', route: cheap })!.choice).toBe('cheap');
    expect(modelRouteOf({ ...on, escalate: false }, work(), 'herdr-claude', { jobId: 'j1', status: 'failed', route: cheap })!.choice).toBe('cheap');
  });
});

describe('jobBudgetOf', () => {
  const route = (budget: ModelRoute['budget']): ModelRoute => ({ choice: 'cheap', model: 'sonnet', rule: 'r', why: 'w', size: 'small', kind: 'code', risk: 'low', budget });
  it('takes the route\'s caps, each 0 falling back to the user\'s job cap', () => {
    const user = { ...DEFAULT_TOKEN_BUDGET, jobTokens: 9000, jobCostUsd: 20, dayTokens: 7 };
    expect(jobBudgetOf(undefined, user)).toEqual(user);
    expect(jobBudgetOf(route({ jobTokens: 0, jobCostUsd: 5 }), user)).toEqual({ ...user, jobTokens: 9000, jobCostUsd: 5 });
  });

  it('takes a person\'s job budget over the route\'s and the user\'s, each 0 falling back (part 2)', () => {
    const user = { ...DEFAULT_TOKEN_BUDGET, jobTokens: 9000, jobCostUsd: 20 };
    expect(jobBudgetOf(route({ jobTokens: 0, jobCostUsd: 5 }), user, { jobTokens: 0, jobCostUsd: 12 })).toEqual({ ...user, jobTokens: 9000, jobCostUsd: 12 });
    expect(jobBudgetOf(undefined, user, { jobTokens: 500, jobCostUsd: 0 })).toEqual({ ...user, jobTokens: 500, jobCostUsd: 20 });
  });
});

describe('escalateOnPickUp (part 2)', () => {
  it('puts a cheap job a person picks up after its budget pause on the strong model, with the strong budget', () => {
    const s: ModelRoutingSettings = { ...on, strong: { model: 'opus', jobTokens: 0, jobCostUsd: 30 }, repos: { 'o/a': { strong: { jobCostUsd: 40 } } } };
    const cheap = modelRouteOf(s, work(), 'herdr-claude')!;
    expect(escalateOnPickUp(s, cheap, 'j1', 'o/a')).toEqual({
      ...cheap, choice: 'strong', model: 'opus', rule: 'escalated', budget: { jobTokens: 0, jobCostUsd: 40 }, escalated: { from: 'cheap', jobId: 'j1' },
      why: 'Escalated: the cheap model reached its budget in job j1, so the job goes on on the strong model.',
    });
    expect(escalateOnPickUp(s, cheap, 'j1', 'o/b')!.budget).toEqual({ jobTokens: 0, jobCostUsd: 30 });
  });

  it('leaves a strong job, a job not routed, and a cheap job while routing or escalation is off', () => {
    const cheap = modelRouteOf(on, work(), 'herdr-claude')!;
    expect(escalateOnPickUp(on, modelRouteOf(on, work({ labels: ['security'] }), 'herdr-claude'), 'j1', undefined)).toBeUndefined();
    expect(escalateOnPickUp(on, undefined, 'j1', undefined)).toBeUndefined();
    expect(escalateOnPickUp({ ...on, escalate: false }, cheap, 'j1', undefined)).toBeUndefined();
    expect(escalateOnPickUp({ ...on, on: false }, cheap, 'j1', undefined)).toBeUndefined();
  });
});

describe('the settings', () => {
  it('reads a stored setting over the defaults, and refuses a bad one', () => {
    expect(modelRoutingOf(undefined)).toEqual(DEFAULT_MODEL_ROUTING);
    expect(modelRoutingOf({ on: true })).toEqual(on);
    expect(DEFAULT_MODEL_ROUTING.on).toBe(false);
    expect(modelRoutingProblem(on)).toBeUndefined();
    expect(modelRoutingProblem({ ...on, rules: [{ name: 'a', match: {}, choice: 'cheap' }, { name: 'a', match: {}, choice: 'strong' }] })).toMatch(/named twice/);
    expect(modelRoutingProblem({ ...on, cheap: { ...on.cheap, model: 'bad model;' } })).toMatch(/model/);
    expect(modelRoutingProblem({ ...on, rules: [{ name: 'label', match: {}, choice: 'cheap' }] })).toMatch(/reserved/);
  });
});

// Part 3: grade history tunes the rules' choice (issue #2845's grades): with tuning on, a rule's cheap choice goes strong
// when the cheap model's graded jobs of the same work did clearly worse, and a low-risk strong choice goes cheap when the
// cheap model's did as well. The same repository first, else the same kind of work; each choice needs `minSamples`.
describe('tuning from grades (part 3)', () => {
  const tuned: ModelRoutingSettings = { ...on, strong: { model: 'opus', jobTokens: 0, jobCostUsd: 0 }, tune: { on: true, minSamples: 2, margin: 10 } };
  const g = (choice: GradedChoice['choice'], points: number, repo = 'o/r', kind = 'code'): GradedChoice => ({ choice, points, repo, kind });
  const worseCheap = [g('cheap', 50), g('cheap', 60), g('strong', 80), g('strong', 90)];

  it('moves a rule\'s cheap choice to the strong model when the cheap model\'s grades are lower by more than the margin', () => {
    expect(modelRouteOf(tuned, work(), 'herdr-claude', undefined, () => worseCheap)).toMatchObject({
      choice: 'strong', model: 'opus', rule: 'grades', budget: { jobTokens: 0, jobCostUsd: 0 },
      why: 'Grades: in o/r the cheap model\'s code jobs scored 55 (2 jobs) and the strong model\'s 85 (2 jobs), so the strong model, not the cheap one rule small-work picked.',
    });
    // Within the margin: the rule's choice stands.
    expect(modelRouteOf(tuned, work(), 'herdr-claude', undefined, () => [g('cheap', 75), g('cheap', 75), g('strong', 80), g('strong', 80)])!.rule).toBe('small-work');
  });

  it('moves a low-risk strong choice to the cheap model when the cheap model\'s grades are as good, never a high-risk one', () => {
    const asGood = [g('cheap', 90), g('cheap', 90), g('strong', 85), g('strong', 85)];
    expect(modelRouteOf(tuned, work({ body: LONG }), 'herdr-claude', undefined, () => asGood)).toMatchObject({ choice: 'cheap', model: 'sonnet', rule: 'grades', budget: { jobCostUsd: 5 } });
    expect(modelRouteOf(tuned, work({ body: LONG, labels: ['security'] }), 'herdr-claude', undefined, () => asGood)).toMatchObject({ choice: 'strong', rule: 'risky-work' });
  });

  it('compares on the same kind of work when the repository has too few grades, and needs minSamples of each choice', () => {
    const elsewhere = worseCheap.map((x) => ({ ...x, repo: 'o/other' }));
    expect(modelRouteOf(tuned, work(), 'herdr-claude', undefined, () => elsewhere)).toMatchObject({ choice: 'strong', rule: 'grades' });
    expect(modelRouteOf(tuned, work(), 'herdr-claude', undefined, () => elsewhere)!.why).toMatch(/^Grades: in code work the cheap model/);
    expect(modelRouteOf(tuned, work(), 'herdr-claude', undefined, () => worseCheap.map((x) => ({ ...x, kind: 'research' })))!.rule).toBe('small-work');
    expect(modelRouteOf(tuned, work(), 'herdr-claude', undefined, () => worseCheap.slice(1))!.rule).toBe('small-work');
  });

  it('leaves a label\'s choice and an escalation, and reads no grades while tuning is off', () => {
    expect(modelRouteOf(tuned, work({ labels: ['hopper:model-cheap'] }), 'herdr-claude', undefined, () => worseCheap)).toMatchObject({ choice: 'cheap', rule: 'label' });
    const cheap = modelRouteOf(on, work(), 'herdr-claude')!;
    expect(modelRouteOf(tuned, work(), 'herdr-claude', { jobId: 'j1', status: 'failed', route: cheap }, () => [g('cheap', 99), g('cheap', 99), g('strong', 1), g('strong', 1)])!.rule).toBe('escalated');
    const read = vi.fn(() => worseCheap);
    expect(modelRouteOf({ ...tuned, tune: { ...tuned.tune, on: false } }, work(), 'herdr-claude', undefined, read)!.rule).toBe('small-work');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses the reserved rule name grades, and a bad tuning', () => {
    expect(DEFAULT_MODEL_ROUTING.tune).toEqual({ on: false, minSamples: 5, margin: 10 });
    expect(modelRoutingProblem({ ...on, rules: [{ name: 'grades', match: {}, choice: 'cheap' }] })).toMatch(/reserved/);
    expect(modelRoutingProblem({ ...on, tune: { on: true, minSamples: 0, margin: 10 } })).toMatch(/tune.minSamples/);
  });
});

// Part 3: a cheap job whose waste signals say it stalled — many turns with no commit and no push, or test runs that fail
// again and again — is paused as a budget pause is, so a person's pick up puts it on the strong model.
describe('cheapStallOf (part 3)', () => {
  const cheap = modelRouteOf(on, work(), 'herdr-claude')!;
  const noProgress = [{ kind: 'no_progress' as const, why: '150 turns with no commit and no push.' }];
  it('says why a cheap job stalled, on a no-progress or failing-tests signal only', () => {
    expect(cheapStallOf(on, cheap, noProgress)).toBe('Paused: the cheap model stalled. 150 turns with no commit and no push. Picked up, the job goes on on the strong model.');
    expect(cheapStallOf(on, cheap, [{ kind: 'failing_tests', why: '5 test runs failed.' }])).toMatch(/5 test runs failed\./);
    expect(cheapStallOf(on, cheap, [{ kind: 'cache_churn', why: 'x' }, { kind: 'resume_loop', why: 'y' }])).toBeUndefined();
  });
  it('pauses no strong job, no job not routed, and none while routing or escalation is off', () => {
    expect(cheapStallOf(on, { ...cheap, choice: 'strong' }, noProgress)).toBeUndefined();
    expect(cheapStallOf(on, undefined, noProgress)).toBeUndefined();
    expect(cheapStallOf({ ...on, escalate: false }, cheap, noProgress)).toBeUndefined();
    expect(cheapStallOf({ ...on, on: false }, cheap, noProgress)).toBeUndefined();
  });
});

// Part 3: a job near its budget is checkpointed every minute, not every ten, so it goes over by less.
describe('budgetNear (part 3)', () => {
  it('is true from 80% of a cap, counted since a pick up', () => {
    const s = { ...DEFAULT_TOKEN_BUDGET, jobTokens: 1000, jobCostUsd: 10 };
    expect(budgetNear({ tokens: 799, costUsd: 1 }, undefined, s)).toBe(false);
    expect(budgetNear({ tokens: 800, costUsd: 1 }, undefined, s)).toBe(true);
    expect(budgetNear({ tokens: 0, costUsd: 8 }, undefined, s)).toBe(true);
    expect(budgetNear({ tokens: 1500, costUsd: 1 }, { tokens: 1000, costUsd: 0 }, s)).toBe(false);
    expect(budgetNear({ tokens: 10_000, costUsd: 100 }, undefined, DEFAULT_TOKEN_BUDGET)).toBe(false);
  });
});
