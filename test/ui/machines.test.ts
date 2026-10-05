// The Machines view's model (issue #18): which machine is the local one and which are attached
// (with their configured entry), what an Add or Edit form may send, and why it may not yet.
import { describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { addBody, addProblem, clientReleaseText, editBody, kindOf, type MachineDraft } from '../../ui/src/model/machines.ts';

const CONFIG: MachinesConfig = {
  document: 'plugins.yaml',
  version: 'v1',
  machine: { name: 'local', plugin: 'local', options: { lanes: 4 } },
  attached: [{ name: 'desk', ssh: 'desk', lanes: 1, executors: ['test'], session: 'hopper', herdrBin: '/usr/bin/herdr' }],
  executors: ['herdr-claude', 'test'],
  ssh: { targets: ['laptop', 'desk'], notes: [] },
};

const draft = (over: Partial<MachineDraft> = {}): MachineDraft => ({ name: 'laptop', ssh: 'laptop', lanes: '2', executors: ['herdr-claude'], label: '', ...over });

describe('kindOf', () => {
  it('the machine source\'s machine is local; a configured attached one carries its entry; anything else is unknown', () => {
    expect(kindOf(CONFIG, 'local')).toEqual({ kind: 'local', lanes: 4 });
    expect(kindOf(CONFIG, 'desk')).toEqual({ kind: 'attached', entry: CONFIG.attached[0] });
    expect(kindOf(CONFIG, 'other')).toEqual({ kind: 'unknown' });
    expect(kindOf(null, 'local')).toEqual({ kind: 'unknown' });
  });

  it('local lanes default to 4 when the instance sets none', () => {
    expect(kindOf({ ...CONFIG, machine: { name: 'local', plugin: 'local' } }, 'local')).toEqual({ kind: 'local', lanes: 4 });
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
    expect(addProblem(draft({ ssh: '' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ ssh: 'typed@host' }), CONFIG)).toMatch(/ssh target/);
    expect(addProblem(draft({ lanes: '0' }), CONFIG)).toMatch(/lanes/);
    expect(addProblem(draft({ lanes: '1.5' }), CONFIG)).toMatch(/lanes/);
  });
});

describe('the bodies sent', () => {
  it('add: trimmed name and label, lanes as a number; an empty label is left out; never herdrBin or session', () => {
    expect(addBody(draft({ name: ' laptop ', label: ' arch ' }), 'v1')).toEqual({
      action: 'add', name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], label: 'arch', version: 'v1',
    });
    expect(addBody(draft(), 'v1')).not.toHaveProperty('label');
  });

  it('edit: only what changed; a cleared label is null (back to the name)', () => {
    const entry = { ...CONFIG.attached[0]!, label: 'old' };
    expect(editBody(entry, { lanes: '3', executors: ['test'], label: 'old' }, 'v1')).toEqual({ action: 'edit', name: 'desk', lanes: 3, version: 'v1' });
    expect(editBody(entry, { lanes: '1', executors: ['herdr-claude', 'test'], label: '' }, 'v1')).toEqual({
      action: 'edit', name: 'desk', executors: ['herdr-claude', 'test'], label: null, version: 'v1',
    });
    expect(editBody(entry, { lanes: '1', executors: ['test'], label: 'old' }, 'v1')).toBeNull();
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
