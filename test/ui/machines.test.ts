// The Machines view's model (issues #18, #74): which machine is a `local` instance and which an
// attached one (an instance of `ssh`, `docker` or `client`), what an Add form may send to
// POST /ui/api/machines and an Edit form to POST /ui/api/plugins, and why it may not yet.
import { describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { addBody, addProblem, clientReleaseText, defaultsBody, editBody, kindOf, newDraft, type MachineDraft } from '../../ui/src/model/machines.ts';

const CONFIG: MachinesConfig = {
  document: 'plugins.yaml',
  version: 'v1',
  machines: [
    { name: 'local', plugin: 'local', options: { lanes: 4 } },
    { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'], herdrBin: '/usr/bin/herdr' } },
    { name: 'box', plugin: 'docker', options: { docker: 'box', lanes: 2 } },
    { name: 'odd', plugin: 'custom-machines' },
  ],
  executors: ['herdr-claude', 'test'],
  defaults: { lanes: 1, executors: ['herdr-claude'] },
  ssh: { targets: ['laptop', 'desk'], notes: [] },
};

const draft = (over: Partial<MachineDraft> = {}): MachineDraft => ({ name: 'laptop', ssh: 'laptop', lanes: '2', executors: ['herdr-claude'], label: '', ...over });

describe('kindOf', () => {
  it('a local instance is local; an ssh, docker or client instance is attached, with its lanes, executors and label; anything else is unknown', () => {
    expect(kindOf(CONFIG, 'local')).toEqual({ kind: 'local', instance: CONFIG.machines[0], lanes: 4 });
    expect(kindOf(CONFIG, 'desk')).toEqual({ kind: 'attached', instance: CONFIG.machines[1], lanes: 1, executors: ['test'] });
    expect(kindOf(CONFIG, 'box')).toEqual({ kind: 'attached', instance: CONFIG.machines[2], lanes: 2, executors: ['command'] });
    expect(kindOf(CONFIG, 'odd')).toEqual({ kind: 'unknown' });
    expect(kindOf(CONFIG, 'other')).toEqual({ kind: 'unknown' });
    expect(kindOf(null, 'local')).toEqual({ kind: 'unknown' });
  });

  it('local lanes default to 4 when the instance sets none', () => {
    expect(kindOf({ ...CONFIG, machines: [{ name: 'local', plugin: 'local' }] }, 'local')).toMatchObject({ kind: 'local', lanes: 4 });
  });
});

describe('addProblem', () => {
  it('none for a complete draft', () => {
    expect(addProblem(draft(), CONFIG)).toBeNull();
  });

  it('names what is missing or refused, as the daemon would', () => {
    expect(addProblem(draft({ name: ' ' }), CONFIG)).toMatch(/name/);
    expect(addProblem(draft({ name: 'local' }), CONFIG)).toMatch(/local/);
    expect(addProblem(draft({ name: 'desk' }), CONFIG)).toMatch(/desk/);
    expect(addProblem(draft({ name: 'odd' }), CONFIG)).toMatch(/odd/);
    expect(addProblem(draft({ ssh: '' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ ssh: 'typed@host' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ lanes: '0' }), CONFIG)).toMatch(/lanes/);
    expect(addProblem(draft({ lanes: '1.5' }), CONFIG)).toMatch(/lanes/);
  });
});

describe('the bodies sent', () => {
  it('add: trimmed name and label, lanes as a number; an empty label is left out; never herdrBin or session', () => {
    expect(addBody(draft({ name: ' laptop ', label: ' arch ' }), 'v1')).toEqual({
      name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], label: 'arch', version: 'v1',
    });
    expect(addBody(draft(), 'v1')).not.toHaveProperty('label');
  });

  it('edit: the instance\'s whole options with lanes, executors and label as typed, everything else kept; null when nothing changed', () => {
    const desk = kindOf({ ...CONFIG, machines: [{ ...CONFIG.machines[1]!, options: { ...CONFIG.machines[1]!.options, label: 'old' } }] }, 'desk');
    if (desk.kind !== 'attached') throw new Error('desk is attached');
    expect(editBody(desk, { lanes: '3', executors: ['test'], label: 'old' }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'desk', version: 'v1',
      options: { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 3, executors: ['test'], label: 'old' },
    });
    expect(editBody(desk, { lanes: '1', executors: ['herdr-claude', 'test'], label: '' }, 'v1')).toEqual({
      action: 'options', role: 'machine-source', name: 'desk', version: 'v1',
      options: { ssh: 'desk', herdrBin: '/usr/bin/herdr', lanes: 1, executors: ['herdr-claude', 'test'] },
    });
    expect(editBody(desk, { lanes: '1', executors: ['test'], label: 'old' }, 'v1')).toBeNull();
  });
});

// Issue #142: a new machine starts from the machine defaults, which the Machines view edits.
describe('machine defaults', () => {
  it('the Add form starts from them: their lanes, and their executors that are configured', () => {
    expect(newDraft(CONFIG)).toEqual({ name: '', ssh: '', lanes: '1', executors: ['herdr-claude'], label: '' });
    expect(newDraft({ ...CONFIG, defaults: { lanes: 3, executors: ['cursor', 'test'] } })).toEqual({ name: '', ssh: '', lanes: '3', executors: ['test'], label: '' });
  });

  it('the defaults form sends lanes as a number and the executors picked; null while lanes is not a whole number ≥ 1', () => {
    expect(defaultsBody({ lanes: '2', executors: ['test'] }, 'v1')).toEqual({ lanes: 2, executors: ['test'], version: 'v1' });
    expect(defaultsBody({ lanes: '0', executors: ['test'] }, 'v1')).toBeNull();
    expect(defaultsBody({ lanes: 'x', executors: [] }, 'v1')).toBeNull();
  });
});

describe('clientReleaseText (issue #70)', () => {
  it('a client target\'s release, and whether it is the hopper\'s; nothing for any other machine or before a probe', () => {
    expect(clientReleaseText({ tokenEnv: 'T', release: '0123456789abcdef', current: true })).toBe('0123456789abcdef (the hopper\'s)');
    expect(clientReleaseText({ tokenEnv: 'T', release: '0123456789abcdef', current: false })).toBe('0123456789abcdef (not the hopper\'s: loaded once no job runs there)');
    expect(clientReleaseText({ tokenEnv: 'T', current: false })).toBe('none: older than releases, install it again (scripts/attach-client.sh)');
    expect(clientReleaseText({ tokenEnv: 'T' })).toBeNull();
    expect(clientReleaseText(undefined)).toBeNull();
  });
});
