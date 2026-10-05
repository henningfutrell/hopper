// Issue #18: the Routing view's model — the router and queue-sorter pickers (every plugin of the
// role, the unavailable ones visible with why, never selectable), and the routing rules form
// (drafts → the whole list POST /ui/api/routing sends; add, move, delete).
import { describe, expect, it } from 'vitest';
import type { Job, PluginsReport, RoutingRule } from '../../src/domain/types.ts';
import {
  blankRule, choices, draftsProblem, fromDraft, machineOptions, move, routedByLabel, toDraft, type RuleDraft,
} from '../../ui/src/model/routing.ts';

const plugin = (id: string, role: string, detection: PluginsReport['plugins'][number]['detection'], builtin = true) =>
  ({ id, role, describe: `${id} does things`, builtin, detection, options: {} }) as PluginsReport['plugins'][number];

const REPORT = {
  router: { instance: { name: 'pass-through', plugin: 'pass-through' } },
  queueSorter: { instance: { name: 'priority', plugin: 'priority' } },
  plugins: [
    plugin('gate-router', 'router', { status: 'unavailable', reason: 'no grok-bot-jev checkout at ~/workbench/jev-src/grok-bot-jev' }),
    plugin('pass-through', 'router', { status: 'available' }),
    plugin('needs-it', 'router', { status: 'needs-setup', reason: 'not logged in', command: 'tool login' }, false),
    plugin('priority', 'queue-sorter', { status: 'available' }),
    plugin('oldest-first', 'queue-sorter', { status: 'available' }),
    plugin('claude-cli', 'answerer', { status: 'available' }),
  ],
} as unknown as PluginsReport;

describe('choices', () => {
  it('lists every plugin of the role, the current one marked, the unavailable ones with why and not selectable', () => {
    expect(choices(REPORT, 'router')).toEqual([
      { id: 'gate-router', describe: 'gate-router does things', builtin: true, current: false, selectable: false, status: 'unavailable', why: 'no grok-bot-jev checkout at ~/workbench/jev-src/grok-bot-jev' },
      { id: 'pass-through', describe: 'pass-through does things', builtin: true, current: true, selectable: true, status: 'available' },
      { id: 'needs-it', describe: 'needs-it does things', builtin: false, current: false, selectable: false, status: 'needs-setup', why: 'not logged in', command: 'tool login' },
    ]);
    expect(choices(REPORT, 'queue-sorter').map((c) => [c.id, c.current, c.selectable])).toEqual([['priority', true, true], ['oldest-first', false, true]]);
  });
});

const RULE: RoutingRule = { name: 'urgent', match: { repo: 'owner/*', label: 'urgent' }, set: { priority: 90, machine: 'laptop' } };

describe('rule drafts', () => {
  it('round-trip: every field a string in the form; empty fields left out when sent', () => {
    const d: RuleDraft = toDraft(RULE);
    expect(d).toEqual({
      name: 'urgent', match: { source: '', repo: 'owner/*', label: 'urgent', author: '', title: '' }, set: { machine: 'laptop', executor: '', priority: '90' },
    });
    expect(fromDraft(d)).toEqual(RULE);
    expect(fromDraft({ ...d, name: ' spaced ', match: { ...d.match, title: '  ' } }).name).toBe('spaced');
  });

  it('a blank rule takes the next free name', () => {
    expect(blankRule(['rule 1', 'rule 2']).name).toBe('rule 3');
    expect(blankRule([]).name).toBe('rule 1');
  });

  it('says what the daemon would refuse, before sending', () => {
    const ok = toDraft(RULE);
    expect(draftsProblem([ok])).toBeUndefined();
    expect(draftsProblem([{ ...ok, name: ' ' }])).toMatch(/rule 1: name it/);
    expect(draftsProblem([ok, ok])).toMatch(/urgent: named twice/);
    expect(draftsProblem([{ ...ok, set: { machine: '', executor: '', priority: '' } }])).toMatch(/urgent: set a machine, an executor or a priority/);
    expect(draftsProblem([{ ...ok, set: { ...ok.set, priority: '101' } }])).toMatch(/urgent: priority is a whole number 0..100/);
    expect(draftsProblem([{ ...ok, set: { ...ok.set, priority: '2.5' } }])).toMatch(/priority/);
  });
});

describe('move', () => {
  const list = ['a', 'b', 'c'];
  it('moves one up or down; never past the ends; the list is not mutated', () => {
    expect(move(list, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(move(list, 1, 1)).toEqual(['a', 'c', 'b']);
    expect(move(list, 0, -1)).toEqual(list);
    expect(move(list, 2, 1)).toEqual(list);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('machineOptions', () => {
  it('the machines the daemon reports and the ones a rule may name, once each, in order', () => {
    expect(machineOptions([{ id: 'local' }, { id: 'laptop' }], ['local', 'desk'])).toEqual(['local', 'laptop', 'desk']);
  });
});

describe('routedByLabel', () => {
  it('names the rule that routed a job, or nothing', () => {
    const job = { spec: { executor: 'test', payload: {}, routedBy: { rule: 'urgent', set: { priority: 90 } } } } as unknown as Job;
    expect(routedByLabel(job)).toBe('routed by urgent: priority 90');
    expect(routedByLabel({ spec: { executor: 'test', payload: {} } } as unknown as Job)).toBeNull();
    const all = { spec: { executor: 'x', payload: {}, routedBy: { rule: 'r', set: { machine: 'laptop', executor: 'x', priority: 5 } } } } as unknown as Job;
    expect(routedByLabel(all)).toBe('routed by r: machine laptop, executor x, priority 5');
  });
});
