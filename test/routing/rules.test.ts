// Issue #18: routing rules — an ordered list in plugins.yaml `routing:`. Each rule matches a source
// item at intake (source, repo glob, label, author, title; case-insensitive) and sets the job's
// machine pin, executor and/or priority. The first matching rule wins. Never a lane.
import { describe, expect, it } from 'vitest';
import type { RoutingItem, RoutingRule } from '../../src/domain/types.ts';
import { routeItem, routingRulesProblem, ruleMatches } from '../../src/routing/index.ts';

const item = (over: Partial<RoutingItem> = {}): RoutingItem => ({
  source: 'github-app', repo: 'owner/hopper', labels: ['hopper', 'Urgent'], author: 'owner', title: 'Fix the Login page', ...over,
});
const rule = (name: string, match: RoutingRule['match'], set: RoutingRule['set']): RoutingRule => ({ name, match, set });
const known = { machines: ['local', 'laptop'], executors: ['herdr-claude', 'test'] };

describe('ruleMatches', () => {
  it.each([
    ['source', { source: 'github-app' }, true],
    ['source (another instance)', { source: 'github' }, false],
    ['repo exact, any case', { repo: 'Owner/Hopper' }, true],
    ['repo glob', { repo: 'owner/*' }, true],
    ['repo glob across the slash', { repo: '*hopper' }, true],
    ['repo glob, no match', { repo: 'someone/*' }, false],
    ['label present, any case', { label: 'urgent' }, true],
    ['label absent', { label: 'later' }, false],
    ['author, any case', { author: 'Owner' }, true],
    ['title substring, any case', { title: 'login' }, true],
    ['title not in it', { title: 'logout' }, false],
    ['every field must match', { label: 'urgent', author: 'stranger' }, false],
    ['an empty match matches every item', {}, true],
  ])('%s', (_n, match, expected) => {
    expect(ruleMatches(rule('r', match, { priority: 1 }), item())).toBe(expected);
  });

  it('an item without a repo matches no repo rule', () => {
    expect(ruleMatches(rule('r', { repo: '*' }, { priority: 1 }), item({ repo: undefined }))).toBe(false);
  });
});

describe('routeItem', () => {
  it('no rules: nothing set', () => {
    expect(routeItem([], item(), known)).toEqual({ skipped: [] });
  });

  it('the first matching rule wins; later matches do not add to it', () => {
    const rules = [
      rule('other-repo', { repo: 'someone/*' }, { priority: 10 }),
      rule('urgent', { label: 'urgent' }, { priority: 90, machine: 'laptop' }),
      rule('all', {}, { executor: 'test' }),
    ];
    expect(routeItem(rules, item(), known)).toEqual({ routedBy: { rule: 'urgent', set: { priority: 90, machine: 'laptop' } }, skipped: [] });
  });

  it('a rule naming a machine or executor that is not configured is skipped with a reason; the next match applies', () => {
    const rules = [
      rule('gone-machine', {}, { machine: 'ghost' }),
      rule('gone-executor', {}, { executor: 'codex' }),
      rule('fine', {}, { priority: 70 }),
    ];
    expect(routeItem(rules, item(), known)).toEqual({
      routedBy: { rule: 'fine', set: { priority: 70 } },
      skipped: [
        { rule: 'gone-machine', reason: 'machine ghost is not configured' },
        { rule: 'gone-executor', reason: 'executor codex is not configured' },
      ],
    });
  });
});

describe('routingRulesProblem (the plugins.yaml `routing:` schema)', () => {
  const ok = [{ name: 'urgent', match: { label: 'urgent' }, set: { priority: 90 } }];
  it('accepts an ordered list; match may be left out (every item)', () => {
    expect(routingRulesProblem(ok)).toBeUndefined();
    expect(routingRulesProblem([{ name: 'all', set: { executor: 'test' } }])).toBeUndefined();
    expect(routingRulesProblem([])).toBeUndefined();
  });
  it.each([
    ['a lane (never a routing target)', [{ name: 'x', match: {}, set: { lane: 'local/lane-1' } }], /lane/],
    ['a lane match', [{ name: 'x', match: { lane: 'a' }, set: { priority: 1 } }], /lane/],
    ['nothing to set', [{ name: 'x', match: { label: 'a' }, set: {} }], /set at least one of machine, executor, priority/],
    ['a priority out of range', [{ name: 'x', match: {}, set: { priority: 101 } }], /priority/],
    ['no name', [{ name: '', match: {}, set: { priority: 1 } }], /name/],
    ['a name twice', [...ok, ...ok], /urgent named twice/],
    ['an empty match value', [{ name: 'x', match: { title: '' }, set: { priority: 1 } }], /title/],
  ])('refuses %s', (_n, rules, why) => {
    expect(routingRulesProblem(rules)).toMatch(why);
  });
});
