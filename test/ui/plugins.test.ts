// The Plugins view's model (design.md "Settled in slice 7"): which status an instance shows, and
// the whole options object one Save sends — drafts over what is configured, command-bearing options
// like any other (issue #198: a command-bearing option is edited from the UI).
import { describe, expect, it } from 'vitest';
import { collectOptions, fieldKind, instanceState, isListRole, newInstance, shippedPlugins, toggleEdit, type OptionsSchema } from '../../ui/src/model/plugins.ts';
import type { PluginsReport, Role } from '../../src/domain/types.ts';

const SCHEMA: OptionsSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string', commandBearing: true },
    pollMs: { type: 'integer', default: 1000 },
    trust: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
    authors: { type: 'array', items: { type: 'string' } },
    extra: { type: 'object' },
  },
};

describe('fieldKind', () => {
  it('an option the plugin lists choices for is a choice, whatever its type; command-bearing is an ordinary field', () => {
    const choices = [{ value: 'opus' }, { value: 'haiku' }];
    expect(fieldKind({ type: 'string' }, choices)).toBe('choice');
    expect(fieldKind({ type: 'string' }, [])).toBe('string');
    expect(fieldKind({ type: 'string' })).toBe('string');
    expect(fieldKind({ type: 'string', commandBearing: true }, choices)).toBe('choice');
    expect(fieldKind({ type: 'string', commandBearing: true })).toBe('string');
  });
});

describe('collectOptions', () => {
  it('keeps configured values with no draft', () => {
    expect(collectOptions({ cwd: '/w', pollMs: 500, unknown: 1 }, SCHEMA, {})).toEqual({ cwd: '/w', pollMs: 500, unknown: 1 });
  });

  it('takes a command-bearing value from the draft like any other', () => {
    const out = collectOptions({ cwd: '/w', pollMs: 500, unknown: 1 }, SCHEMA, { cwd: '/elsewhere' });
    expect(out).toEqual({ cwd: '/elsewhere', pollMs: 500, unknown: 1 });
  });

  it('converts drafts by schema type; an emptied field is left out (its default applies)', () => {
    const out = collectOptions({ pollMs: 500 }, SCHEMA, {
      pollMs: '', trust: true, mode: 'b', authors: ' owner \n\n other ', extra: '{"k":1}',
    });
    expect(out).toEqual({ trust: true, mode: 'b', authors: ['owner', 'other'], extra: { k: 1 } });
    expect(collectOptions({}, SCHEMA, { pollMs: '250' })).toEqual({ pollMs: 250 });
  });

  it('refuses JSON that does not parse, naming the option', () => {
    expect(() => collectOptions({}, SCHEMA, { extra: '{nope' })).toThrow(/extra: not valid JSON/);
  });
});

describe('fieldKind', () => {
  it('picks an input per JSON Schema type', () => {
    const p = SCHEMA.properties!;
    expect([p.cwd, p.pollMs, p.trust, p.mode, p.authors, p.extra].map((x) => fieldKind(x!))).toEqual(
      ['string', 'number', 'boolean', 'enum', 'lines', 'json'],
    );
  });
});

describe('instanceState', () => {
  const report = {
    router: { instance: { name: 'gate-router', plugin: 'gate-router' }, active: 'pass-through', fallback: true, reason: 'no python' },
    escalationLevels: [
      { instance: { name: 'opus', plugin: 'claude-cli' }, detection: { status: 'available' }, active: 'claude-cli' },
      { instance: { name: 'fable', plugin: 'claude-cli' }, detection: { status: 'unavailable', reason: 'no claude' }, active: null, reason: 'no claude' },
    ],
    executors: { instances: [{ instance: { name: 'test', plugin: 'test' }, detection: { status: 'available' }, active: 'test' }] },
    jobSources: { instances: [{ instance: { name: 'github', plugin: 'github-gh' }, detection: { status: 'unavailable', reason: 'no gh' }, active: null, reason: 'no gh' }] },
    machines: { instances: [{ instance: { name: 'local', plugin: 'local' }, detection: { status: 'available' }, active: 'local' }], pending: { status: 'changed — restart pending', instances: [] } },
    usageSources: { instances: [] },
    notifiers: { instances: [] },
  } as unknown as PluginsReport;

  it('a live role: active, or the fallback answering', () => {
    expect(instanceState(report, 'router', 'gate-router')).toMatchObject({ tone: 'warn', label: 'fallback: pass-through', reason: 'no python' });
  });

  it('an escalation level: active, or cannot run (it escalates every question), never restart pending', () => {
    expect(instanceState(report, 'escalation-level', 'opus')).toMatchObject({ tone: 'ok', label: 'active', rolePending: false });
    expect(instanceState(report, 'escalation-level', 'fable')).toMatchObject({ tone: 'bad', label: 'cannot run', reason: 'no claude' });
    expect(instanceState(report, 'escalation-level', 'new-one')).toMatchObject({ tone: 'warn', label: 'loading' });
  });

  it('a restart role: active, cannot run (with the reason), or not built yet (restart pending)', () => {
    expect(instanceState(report, 'job-source', 'github')).toMatchObject({ tone: 'bad', label: 'cannot run', reason: 'no gh' });
    expect(instanceState(report, 'notifier', 'new-one')).toMatchObject({ tone: 'warn', label: 'restart pending' });
  });

  it('the machine sources (issue #74) and the executors (issue #142) are live: never restart pending', () => {
    expect(instanceState(report, 'machine-source', 'local')).toMatchObject({ tone: 'ok', label: 'active', rolePending: false });
    expect(instanceState(report, 'executor', 'test')).toMatchObject({ tone: 'ok', label: 'active', rolePending: false });
    expect(instanceState(report, 'executor', 'just-added')).toMatchObject({ tone: 'warn', label: 'applying', rolePending: false });
  });
});

describe('adding an instance (issue #4)', () => {
  const report = {
    instances: [{ role: 'executor', instance: { name: 'test', plugin: 'test' } }, { role: 'job-source', instance: { name: 'github', plugin: 'github-gh' } }],
  } as unknown as PluginsReport;

  it('only the list roles take added and removed instances', () => {
    expect(['escalation-level', 'executor', 'job-source', 'usage-source', 'notifier', 'router', 'queue-sorter', 'machine-source'].map((r) => isListRole(r as Role))).toEqual(
      [true, true, true, true, true, false, false, true],
    );
  });

  it('the name typed, trimmed; empty: the plugin id', () => {
    expect(newInstance(report, 'executor', 'herdr-claude', '  laptop ')).toEqual({ name: 'laptop' });
    expect(newInstance(report, 'executor', 'herdr-claude', '')).toEqual({ name: 'herdr-claude' });
  });

  it('a name the role already has is refused, naming it; the same name in another role is not', () => {
    expect(newInstance(report, 'executor', 'test', '')).toEqual({ name: 'test', problem: 'an executor is already named test' });
    expect(newInstance(report, 'executor', 'github-gh', 'github')).toEqual({ name: 'github' });
  });
});

// Issue #142 (owner decision: users never edit the plugins config by hand): every shipped plugin of a list role is
// enabled or disabled from the Plugins view. Enable adds one instance under the plugin's id with its
// defaults; disable removes its one instance. Machines are attached in the Machines view.
describe('shipped plugins', () => {
  const plugin = (id: string, role: string, detection: Record<string, unknown> = { status: 'available' }, builtin = true) =>
    ({ id, role, describe: `${id} does things`, builtin, detection, options: {} });
  const report = {
    config: { version: 'v1' },
    instances: [
      { role: 'executor', instance: { name: 'test', plugin: 'test' } },
      { role: 'executor', instance: { name: 'claude-a', plugin: 'herdr-claude' } },
      { role: 'executor', instance: { name: 'claude-b', plugin: 'herdr-claude' } },
      { role: 'machine-source', instance: { name: 'local', plugin: 'local' } },
    ],
    plugins: [
      plugin('test', 'executor'), plugin('herdr-claude', 'executor'), plugin('cursor-agent', 'executor'),
      plugin('command', 'executor', { status: 'needs-setup', reason: 'set its options' }),
      plugin('github-gh', 'job-source', { status: 'unavailable', reason: 'gh not found' }),
      plugin('local', 'machine-source'), plugin('gate-router', 'router'), plugin('mine', 'executor', { status: 'available' }, false),
    ],
  } as unknown as PluginsReport;

  it('the built-in plugins of the list roles but machines: enabled when an instance names them, and whether a click can change that', () => {
    expect(shippedPlugins(report)).toEqual([
      { id: 'test', role: 'executor', describe: 'test does things', enabled: true, instances: ['test'] },
      { id: 'herdr-claude', role: 'executor', describe: 'herdr-claude does things', enabled: true, instances: ['claude-a', 'claude-b'], blocked: '2 instances: remove them below' },
      { id: 'cursor-agent', role: 'executor', describe: 'cursor-agent does things', enabled: false, instances: [] },
      { id: 'command', role: 'executor', describe: 'command does things', enabled: false, instances: [], blocked: 'set its options' },
      { id: 'github-gh', role: 'job-source', describe: 'github-gh does things', enabled: false, instances: [], blocked: 'gh not found' },
    ]);
  });

  it('the edit a switch sends: add under the plugin id, or remove its one instance; none when blocked', () => {
    const [test, herdr, cursor] = shippedPlugins(report);
    expect(toggleEdit(report, cursor!)).toEqual({ action: 'add', role: 'executor', plugin: 'cursor-agent', name: 'cursor-agent', version: 'v1' });
    expect(toggleEdit(report, test!)).toEqual({ action: 'remove', role: 'executor', name: 'test', version: 'v1' });
    expect(toggleEdit(report, herdr!)).toBeNull();
  });
});

// Issue #174: a plugin with a machine option is never added without its machine.
describe('a shipped plugin that runs on a machine', () => {
  const report = {
    config: { version: 'v1' },
    instances: [{ role: 'machine-source', instance: { name: 'local', plugin: 'local' } }],
    plugins: [{
      id: 'claude-plan', role: 'usage-source', describe: 'usage', builtin: true, detection: { status: 'available' },
      options: { type: 'object', properties: { machine: { type: 'string', machine: true } }, required: ['machine'] },
    }],
  } as unknown as PluginsReport;

  it('is not switched on: it is added where its machine is picked', () => {
    const [plan] = shippedPlugins(report);
    expect(plan).toMatchObject({ id: 'claude-plan', enabled: false, blocked: 'runs on a machine: add it under Usage sources, picking the machine' });
    expect(toggleEdit(report, plan!)).toBeNull();
  });

  it('a machine option is always a choice, even before any machine is listed', () => {
    expect(fieldKind({ type: 'string', machine: true } as never)).toBe('choice');
  });
});
