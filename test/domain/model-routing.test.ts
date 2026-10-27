// Model routing (issue #2848): the work's class at intake picks the cheap or the strong model and the job's budget; a
// failed cheap job's next job of the item escalates once to the strong model. Pure.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ROUTING, classifyWork, jobBudgetOf, modelRouteOf, modelRoutingOf, modelRoutingProblem, type ModelRoute, type ModelRoutingSettings, type WorkItem,
} from '../../src/domain/model-routing.ts';
import { DEFAULT_TOKEN_BUDGET } from '../../src/domain/token-budget.ts';

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
