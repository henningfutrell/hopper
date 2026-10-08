// Issue #442: a part that runs claude and names no machine — a claude-cli escalation level, the
// claude-plan usage source — picks one in a set order, or says in plain words that none can run it;
// and the stored plugins config is filled where exactly one machine can.
import { describe, expect, it } from 'vitest';
import type { InstanceSpec, MachineSnapshot } from '../../src/domain/types.ts';
import { fillMachines, machineNote, NO_MACHINE_FOR_LEVEL, pickMachine } from '../../src/domain/machine-pick.ts';

const m = (id: string, over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({ id, label: id, maxLanes: 1, online: true, executors: ['herdr-claude'], ...over });
const HERE = m('here');
const DESK = m('desk', { ssh: 'desk' });
const PHONE = m('phone', { client: {} });
const BOX = m('box', { docker: 'box' });

describe('pickMachine (a level that names no machine)', () => {
  it('the job\'s machine first, where claude can run there', () => {
    expect(pickMachine({ reach: 'here-or-ssh', jobMachine: 'desk', machines: [HERE, DESK] })).toEqual({ machine: 'desk', why: 'the job\'s machine' });
  });

  it.each([
    ['a client target', PHONE],
    ['a container target', BOX],
    ['offline', m('desk', { ssh: 'desk', online: false })],
  ])('the job\'s machine is skipped when it is %s', (_n, job) => {
    expect(pickMachine({ reach: 'here-or-ssh', jobMachine: job.id, machines: [job, HERE] })).toEqual({ machine: 'here', why: 'the only machine that can run claude' });
  });

  it('then the only machine that can run claude, then the default escalation machine', () => {
    expect(pickMachine({ reach: 'here-or-ssh', machines: [PHONE, DESK, BOX] })).toEqual({ machine: 'desk', why: 'the only machine that can run claude' });
    expect(pickMachine({ reach: 'here-or-ssh', machines: [HERE, DESK], fallback: 'desk' })).toEqual({ machine: 'desk', why: 'the default escalation machine' });
  });

  it('none: the plain reason and how to fix it, no options-validation text', () => {
    const none = pickMachine({ reach: 'here-or-ssh', machines: [PHONE, BOX] });
    expect(none).toEqual({ none: NO_MACHINE_FOR_LEVEL });
    expect(NO_MACHINE_FOR_LEVEL).toMatch(/^No machine can run claude for this level/);
    expect(NO_MACHINE_FOR_LEVEL).toMatch(/anthropic-api/);
    expect(NO_MACHINE_FOR_LEVEL).not.toMatch(/invalid|expected|undefined/);
    // Several can, none is the job's, no default: which is not guessed.
    expect(pickMachine({ reach: 'here-or-ssh', machines: [HERE, DESK] })).toEqual({ none: expect.stringMatching(/names no machine, and here, desk can run claude.*default escalation machine/) });
  });

  it('a usage source reaches any online machine, a client or container target too', () => {
    expect(pickMachine({ reach: 'any', machines: [PHONE] })).toEqual({ machine: 'phone', why: 'the only machine that can run claude' });
    expect(pickMachine({ reach: 'any', machines: [PHONE, BOX] })).toMatchObject({ none: expect.stringMatching(/^No machine can run claude/) });
  });
});

const spec = (name: string, plugin: string): InstanceSpec => ({ name, plugin });

describe('machineNote (the Settings status of a part that names no machine)', () => {
  it('one machine can run claude: not flagged, it names that machine', () => {
    expect(machineNote({ reach: 'here-or-ssh', machines: [spec('desk', 'ssh'), spec('phone', 'client')] })).toEqual({ machine: 'desk', needsMachine: false, note: 'names no machine: runs on desk, the only machine that can run claude' });
  });

  it('none can: flagged, with the plain reason', () => {
    expect(machineNote({ reach: 'here-or-ssh', machines: [spec('phone', 'client')] })).toEqual({ needsMachine: true, note: NO_MACHINE_FOR_LEVEL });
  });

  it('several can and no default: flagged; with the default set, not', () => {
    const two = [spec('here', 'local'), spec('desk', 'ssh')];
    expect(machineNote({ reach: 'here-or-ssh', machines: two })).toMatchObject({ needsMachine: true, note: expect.stringMatching(/here, desk/) });
    expect(machineNote({ reach: 'here-or-ssh', machines: two, fallback: 'desk' })).toMatchObject({ needsMachine: false, note: expect.stringMatching(/desk, the default escalation machine/) });
  });
});

describe('fillMachines (the stored plugins config)', () => {
  it('names the one machine that can run claude on every claude-cli level and claude-plan source that names none', () => {
    const doc = {
      version: 1,
      machines: [{ name: 'desk', plugin: 'ssh', options: { ssh: 'desk' } }, { name: 'phone', plugin: 'client' }],
      escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { model: 'opus' } }, { name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'kept' } }, { name: 'api', plugin: 'anthropic-api' }],
      usageSources: [{ name: 'claude', plugin: 'claude-plan' }],
    };
    expect(fillMachines(doc)).toEqual(['level-1']);
    expect(doc.escalationLevels).toEqual([
      { name: 'level-1', plugin: 'claude-cli', options: { model: 'opus', machine: 'desk' } },
      { name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'kept' } },
      { name: 'api', plugin: 'anthropic-api' },
    ]);
    // Two machines can run claude-plan (the ssh one and the client): left for the owner.
    expect(doc.usageSources).toEqual([{ name: 'claude', plugin: 'claude-plan' }]);
  });

  it('no machine, several, or no machines section: nothing changes', () => {
    for (const machines of [[], [{ name: 'a', plugin: 'local' }, { name: 'b', plugin: 'ssh' }], undefined]) {
      const doc = { version: 1, ...(machines ? { machines } : {}), escalationLevels: [{ name: 'level-1', plugin: 'claude-cli' }] };
      expect(fillMachines(doc)).toEqual([]);
      expect(doc.escalationLevels).toEqual([{ name: 'level-1', plugin: 'claude-cli' }]);
    }
  });
});
