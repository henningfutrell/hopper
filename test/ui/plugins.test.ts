// The Plugins view's model (design.md "Settled in slice 7"): which status an instance shows, and
// the whole options object one Save sends — drafts over what is configured, command-bearing as
// configured, so the daemon's command-bearing check never trips on a form round trip.
import { describe, expect, it } from 'vitest';
import { collectOptions, fieldKind, instanceState, isListRole, newInstance, type OptionsSchema } from '../../ui/src/model/plugins.ts';
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

describe('collectOptions', () => {
  it('keeps configured values with no draft, and command-bearing ones whatever the draft says', () => {
    const out = collectOptions({ cwd: '/w', pollMs: 500, unknown: 1 }, SCHEMA, { cwd: '/elsewhere' });
    expect(out).toEqual({ cwd: '/w', pollMs: 500, unknown: 1 });
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
      ['readonly', 'number', 'boolean', 'enum', 'lines', 'json'],
    );
  });
});

describe('instanceState', () => {
  const report = {
    router: { instance: { name: 'gate-router', plugin: 'gate-router' }, active: 'pass-through', fallback: true, reason: 'no python' },
    answerer: { instance: null, active: null, fallback: false },
    assessor: { instance: { name: 'fable', plugin: 'claude-cli-assessor' }, active: 'claude-cli-assessor', fallback: false },
    executors: { instances: [{ instance: { name: 'test', plugin: 'test' }, detection: { status: 'available' }, active: 'test' }] },
    jobSources: { instances: [{ instance: { name: 'github', plugin: 'github-gh' }, detection: { status: 'unavailable', reason: 'no gh' }, active: null, reason: 'no gh' }] },
    machines: { instances: [{ instance: { name: 'local', plugin: 'local' }, detection: { status: 'available' }, active: 'local' }], pending: { status: 'changed — restart pending', instances: [] } },
    usageSources: { instances: [] },
    notifiers: { instances: [] },
  } as unknown as PluginsReport;

  it('a live role: active, or the fallback answering', () => {
    expect(instanceState(report, 'assessor', 'fable')).toMatchObject({ tone: 'ok', label: 'active' });
    expect(instanceState(report, 'router', 'gate-router')).toMatchObject({ tone: 'warn', label: 'fallback: pass-through', reason: 'no python' });
  });

  it('a restart role: active, cannot run (with the reason), or not built yet (restart pending)', () => {
    expect(instanceState(report, 'executor', 'test')).toMatchObject({ tone: 'ok', label: 'active' });
    expect(instanceState(report, 'job-source', 'github')).toMatchObject({ tone: 'bad', label: 'cannot run', reason: 'no gh' });
    expect(instanceState(report, 'notifier', 'new-one')).toMatchObject({ tone: 'warn', label: 'restart pending' });
  });

  it('a restart role whose section changed says so', () => {
    expect(instanceState(report, 'executor', 'test').rolePending).toBe(false);
  });

  it('the machine sources are live (issue #74): never restart pending', () => {
    expect(instanceState(report, 'machine-source', 'local')).toMatchObject({ tone: 'ok', label: 'active', rolePending: false });
  });
});

describe('adding an instance (issue #4)', () => {
  const report = {
    instances: [{ role: 'executor', instance: { name: 'test', plugin: 'test' } }, { role: 'job-source', instance: { name: 'github', plugin: 'github-gh' } }],
  } as unknown as PluginsReport;

  it('only the list roles take added and removed instances', () => {
    expect(['executor', 'job-source', 'usage-source', 'notifier', 'router', 'assessor', 'machine-source'].map((r) => isListRole(r as Role))).toEqual(
      [true, true, true, true, false, false, true],
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
