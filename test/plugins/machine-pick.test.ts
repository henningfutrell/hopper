// Issue #442: a part that runs claude and names no machine — a claude-cli escalation level, the
// claude-plan usage source — picks one in a set order, or says in plain words that none can run it;
// and the stored plugins config is filled where exactly one machine can.
import { describe, expect, it } from 'vitest';
import type { InstanceSpec, MachineSnapshot } from '../../src/domain/types.ts';
import { fillMachines, machineNote, namedMachineNote, NO_MACHINE_FOR_LEVEL, NO_MACHINE_FOR_USAGE, pickMachine } from '../../src/domain/machine-pick.ts';

const m = (id: string, over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({ id, label: id, maxLanes: 1, online: true, executors: ['herdr-claude'], ...over });
const HERE = m('here');
const DESK = m('desk', { ssh: 'desk' });
const PHONE = m('phone', { client: {} });
const BOX = m('box', { docker: 'box' });

describe('pickMachine (a level that names no machine)', () => {
  it('the job\'s machine first, where claude can run there: a client target too (issue #482)', () => {
    expect(pickMachine({ reach: 'no-container', jobMachine: 'desk', machines: [HERE, DESK] })).toEqual({ machine: 'desk', why: 'the job\'s machine' });
    expect(pickMachine({ reach: 'no-container', jobMachine: 'phone', machines: [HERE, PHONE] })).toEqual({ machine: 'phone', why: 'the job\'s machine' });
  });

  it('a container hopper whose only machine is a client target: the client is picked (issue #482)', () => {
    expect(pickMachine({ reach: 'no-container', machines: [PHONE] })).toEqual({ machine: 'phone', why: 'the only machine that can run claude' });
  });

  it.each([
    ['a container target', BOX],
    ['offline', m('desk', { ssh: 'desk', online: false })],
  ])('the job\'s machine is skipped when it is %s', (_n, job) => {
    expect(pickMachine({ reach: 'no-container', jobMachine: job.id, machines: [job, HERE] })).toEqual({ machine: 'here', why: 'the only machine that can run claude' });
  });

  it('then the only machine that can run claude, then the default escalation machine', () => {
    expect(pickMachine({ reach: 'no-container', machines: [m('gone', { client: {}, online: false }), DESK, BOX] })).toEqual({ machine: 'desk', why: 'the only machine that can run claude' });
    expect(pickMachine({ reach: 'no-container', machines: [HERE, DESK], fallback: 'desk' })).toEqual({ machine: 'desk', why: 'the default escalation machine' });
  });

  it('none: the plain reason and how to fix it, no options-validation text', () => {
    const none = pickMachine({ reach: 'no-container', machines: [m('gone', { client: {}, online: false }), BOX] });
    expect(none).toEqual({ none: NO_MACHINE_FOR_LEVEL });
    expect(NO_MACHINE_FOR_LEVEL).toMatch(/^No machine can run claude for this level/);
    expect(NO_MACHINE_FOR_LEVEL).toMatch(/anthropic-api/);
    expect(NO_MACHINE_FOR_LEVEL).not.toMatch(/invalid|expected|undefined/);
    // Several can, none is the job's, no default: which is not guessed.
    expect(pickMachine({ reach: 'no-container', machines: [HERE, DESK] })).toEqual({ none: expect.stringMatching(/names no machine, and here, desk can run claude.*default escalation machine/) });
  });

  it('a usage source reaches any online machine, a client or container target too', () => {
    expect(pickMachine({ reach: 'any', machines: [PHONE] })).toEqual({ machine: 'phone', why: 'the only machine that can run claude' });
    expect(pickMachine({ reach: 'any', machines: [PHONE, BOX] })).toEqual({ none: expect.stringMatching(/^This usage source names no machine, and phone, box can run claude/) });
    expect(pickMachine({ reach: 'any', machines: [m('gone', { online: false })] })).toEqual({ none: NO_MACHINE_FOR_USAGE });
  });
});

const spec = (name: string, plugin: string): InstanceSpec => ({ name, plugin });

describe('machineNote (the Settings status of a part that names no machine)', () => {
  it('one machine can run claude: not flagged, it names that machine — a client target too (issue #482)', () => {
    expect(machineNote({ reach: 'no-container', machines: [spec('desk', 'ssh'), spec('box', 'docker')] })).toEqual({ machine: 'desk', needsMachine: false, note: 'names no machine: runs on desk, the only machine that can run claude' });
    expect(machineNote({ reach: 'no-container', machines: [spec('phone', 'client')] })).toEqual({ machine: 'phone', needsMachine: false, note: 'names no machine: runs on phone, the only machine that can run claude' });
  });

  it('none can: flagged, with the plain reason', () => {
    expect(machineNote({ reach: 'no-container', machines: [spec('box', 'docker')] })).toEqual({ needsMachine: true, note: NO_MACHINE_FOR_LEVEL });
  });

  it('several can and no default: flagged; with the default set, not', () => {
    const two = [spec('here', 'local'), spec('desk', 'ssh')];
    expect(machineNote({ reach: 'no-container', machines: two })).toMatchObject({ needsMachine: true, note: expect.stringMatching(/here, desk/) });
    expect(machineNote({ reach: 'no-container', machines: two, fallback: 'desk' })).toMatchObject({ needsMachine: false, note: expect.stringMatching(/desk, the default escalation machine/) });
  });
});

describe('namedMachineNote (the Settings status of a level that names its machine, issue #482)', () => {
  const specs = [spec('desk', 'ssh'), spec('phone', 'client'), spec('box', 'docker')];

  it('a machine claude can run on, online or not yet listed: no note', () => {
    expect(namedMachineNote({ reach: 'no-container', machine: 'phone', machines: specs, live: [PHONE] })).toBeUndefined();
    expect(namedMachineNote({ reach: 'no-container', machine: 'desk', machines: specs })).toBeUndefined();
  });

  it('a container target: flagged as needing a machine, with the reason and how to fix it', () => {
    expect(namedMachineNote({ reach: 'no-container', machine: 'box', machines: specs })).toEqual({
      needsMachine: true, note: expect.stringMatching(/^machine box is a container target: claude-cli cannot run there\. Pick another machine for this level in Settings → Question gates/),
    });
  });

  it('a machine that is not configured: flagged the same way', () => {
    expect(namedMachineNote({ reach: 'no-container', machine: 'gone', machines: specs })).toEqual({ needsMachine: true, note: expect.stringMatching(/^machine gone is not configured\. Pick another machine/) });
  });

  it('a machine offline now: cannot run, with the reason and how to fix it', () => {
    expect(namedMachineNote({ reach: 'no-container', machine: 'phone', machines: specs, live: [{ ...PHONE, online: false }] })).toEqual({
      needsMachine: false, cannotRun: true, note: expect.stringMatching(/^machine phone is offline: questions skip this level until it is back/),
    });
  });

  it('a usage source reaches a container too', () => {
    expect(namedMachineNote({ reach: 'any', machine: 'box', machines: specs })).toBeUndefined();
  });
});

describe('fillMachines (the stored plugins config)', () => {
  it('names the one machine that can run claude on every claude-cli level and claude-plan source that names none', () => {
    const doc = {
      version: 1,
      machines: [{ name: 'desk', plugin: 'ssh', options: { ssh: 'desk' } }, { name: 'box', plugin: 'docker' }],
      escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { model: 'opus' } }, { name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'kept' } }, { name: 'api', plugin: 'anthropic-api' }],
      usageSources: [{ name: 'claude', plugin: 'claude-plan' }],
    };
    expect(fillMachines(doc)).toEqual(['level-1']);
    expect(doc.escalationLevels).toEqual([
      { name: 'level-1', plugin: 'claude-cli', options: { model: 'opus', machine: 'desk' } },
      { name: 'level-2', plugin: 'claude-cli', options: { model: 'fable', machine: 'kept' } },
      { name: 'api', plugin: 'anthropic-api' },
    ]);
    // Two machines can run claude-plan (the ssh one and the container): left for the owner.
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
