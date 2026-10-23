// Issue #466 part 1: the hopper.io state snapshot, what the instance may send on the cloud link for the dashboard.
// A closed schema and a pure projection: counts, enums and an opaque machine key only (docs/hopper-io-security.md R4, R5).
import { describe, expect, it } from 'vitest';
import { HOPPER_IO_EXECUTORS, HOPPER_IO_STATE_SCHEMA, projectHopperIoState, type HopperIoStateInputs } from '../../src/domain/hopper-io-state.ts';
import type { Lane, MachineSnapshot } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';

const at = '2026-10-17T06:00:00.000Z';
const key = (id: string): string => `k-${id.length}-${[...id].reverse().join('').length}`;

const machine = (id: string, extra: Partial<MachineSnapshot> = {}): MachineSnapshot => ({ id, label: id, maxLanes: 4, online: true, executors: ['claude'], ...extra });
const lane = (id: string, machineId: string, state: Lane['state']): Lane => ({ id, machineId, state, openedAt: at });

const inputs = (over: Partial<HopperIoStateInputs> = {}): HopperIoStateInputs => ({
  sentAt: at,
  installed: { commit: '1f36076e0123456789abcdef0123456789abcdef' },
  channel: 'dev',
  machines: [],
  lanes: [],
  queue: { waiting: [], running: [], locked: [], gate: { mode: 'auto-accept', autoAcceptPerHour: null } },
  questions: [],
  machineKey: key,
  executorPlugin: (name) => name,
  ...over,
});

describe('the hopper.io state snapshot (issue #466)', () => {
  it('counts the queue, the questions that wait on the owner, and the locked entries', () => {
    const s = projectHopperIoState(inputs({
      queue: { waiting: [{}, {}], running: [{}], locked: [{}], gate: { mode: 'review', autoAcceptPerHour: 3 } },
      questions: [
        { id: 'q1', jobId: 'j1', status: 'open', tier: 'human' },
        { id: 'q2', jobId: 'j2', status: 'open', tier: 'level-1' },
        { id: 'q3', jobId: 'j3', status: 'answered', tier: 'human' },
        { id: 'q4', jobId: 'j4', status: 'open', tier: 'human' },
      ],
    }));
    expect(s).toMatchObject({
      schema: 2,
      sentAt: at,
      instance: { version: '1f36076e', channel: 'dev' },
      queue: { waiting: 2, running: 1, locked: 1, gate: 'review' },
      attention: { questionsAwaitingOwner: 2, jobsLocked: 1, machinesOffline: 0 },
    });
  });

  it('gives each machine its lanes in use, its total, and why it takes no new job', () => {
    const s = projectHopperIoState(inputs({
      machines: [
        machine('a'),
        machine('b', { online: false }),
        machine('c', { drained: { person: 'someone', via: 'ui', at } }),
        machine('d', { disk: { freeBytes: 1, totalBytes: 10, low: true } }),
        machine('e', { workTreeProblem: 'no such dir' }),
        machine('f', { maxLanes: 0 }),
      ],
      lanes: [lane('l1', 'a', 'busy'), lane('l2', 'a', 'draining'), lane('l3', 'a', 'idle'), lane('l4', 'c', 'busy')],
    }));
    expect(s.machines).toEqual([
      { key: key('a'), online: true, lanesInUse: 2, lanes: 4, executors: ['claude'], takesJobs: true },
      { key: key('b'), online: false, lanesInUse: 0, lanes: 4, executors: ['claude'], takesJobs: false, notTaking: 'offline' },
      { key: key('c'), online: true, lanesInUse: 1, lanes: 4, executors: ['claude'], takesJobs: false, notTaking: 'drained' },
      { key: key('d'), online: true, lanesInUse: 0, lanes: 4, executors: ['claude'], takesJobs: false, notTaking: 'disk-low' },
      { key: key('e'), online: true, lanesInUse: 0, lanes: 4, executors: ['claude'], takesJobs: false, notTaking: 'work-tree' },
      { key: key('f'), online: true, lanesInUse: 0, lanes: 0, executors: ['claude'], takesJobs: false, notTaking: 'no-lanes' },
    ]);
    expect(s.attention.machinesOffline).toBe(1);
  });

  it('an instance with no installed version and no machines still makes a snapshot the schema takes', () => {
    const s = projectHopperIoState(inputs({ installed: undefined }));
    expect(s.instance.version).toBe('unknown');
    expect(HOPPER_IO_STATE_SCHEMA.parse(s)).toEqual(s);
  });

  it('the schema is closed: a key outside it is refused, at every level', () => {
    const s = projectHopperIoState(inputs({ machines: [machine('a')] }));
    expect(HOPPER_IO_STATE_SCHEMA.safeParse({ ...s, extra: 1 }).success).toBe(false);
    expect(HOPPER_IO_STATE_SCHEMA.safeParse({ ...s, instance: { ...s.instance, host: 'x' } }).success).toBe(false);
    expect(HOPPER_IO_STATE_SCHEMA.safeParse({ ...s, machines: [{ ...s.machines[0], name: 'x' }] }).success).toBe(false);
    expect(HOPPER_IO_STATE_SCHEMA.safeParse({ ...s, schema: 1 }).success).toBe(false);
    expect(HOPPER_IO_STATE_SCHEMA.safeParse({ ...s, schema: 3 }).success).toBe(false);
    expect(HOPPER_IO_STATE_SCHEMA.safeParse({ ...s, machines: [{ ...s.machines[0], executors: ['my-box-claude'] }] }).success).toBe(false);
  });

  it('sends no free text of a machine: no id, label, path, host name, address or person', () => {
    const secretish = ['omarchybox', 'builder@omarchybox.tailnet.ts.net', '/home/someone/work', '100.64.1.2', 'Some Person', 'http://192.168.1.5:7777', 'herdr broke', 'cannot reach'];
    const leaky = machine('omarchybox', {
      label: 'Some Person',
      ssh: 'builder@omarchybox.tailnet.ts.net',
      home: '/home/someone/work',
      workTree: '/home/someone/work',
      workTreeProblem: 'no such dir /home/someone/work',
      hopperUrl: 'http://192.168.1.5:7777',
      addressProblem: 'cannot reach 100.64.1.2',
      herdrProblem: 'herdr broke',
      drained: { person: 'Some Person', via: 'ui', at },
      client: { door: 'http://192.168.1.5:7777', release: 'x' },
    });
    const s = projectHopperIoState(inputs({ machines: [leaky], lanes: [lane('l1', 'omarchybox', 'busy')], machineKey: () => 'opaque' }));
    const sent = JSON.stringify(s);
    for (const text of secretish) expect(sent).not.toContain(text);
    expect(HOPPER_IO_STATE_SCHEMA.parse(s)).toEqual(s);
  });

  it('gives each machine the kinds of executor it offers, never the names the plugins config gives them (issue #465)', () => {
    const plugins: Record<string, string> = { 'omarchybox-claude': 'herdr-claude', 'fast codex': 'codex', 'my-runner': 'acme-runner', claude: 'claude' };
    const s = projectHopperIoState(inputs({
      machines: [
        machine('a', { executors: ['omarchybox-claude', 'claude', 'fast codex'] }),
        machine('b', { executors: ['my-runner', 'gone', 'claude'] }),
        machine('c', { executors: [] }),
      ],
      executorPlugin: (name) => plugins[name],
    }));
    expect(s.machines.map((m) => m.executors)).toEqual([['claude', 'codex', 'herdr-claude'], ['claude', 'other'], []]);
    const sent = JSON.stringify(s);
    for (const text of ['omarchybox', 'fast codex', 'my-runner', 'acme-runner', 'gone']) expect(sent).not.toContain(text);
    expect(HOPPER_IO_STATE_SCHEMA.parse(s)).toEqual(s);
  });

  it('knows every built-in executor kind, and `other` for the rest', () => {
    const builtin = BUILTIN_PLUGINS.filter((p) => p.role === 'executor').map((p) => p.id).sort();
    expect([...HOPPER_IO_EXECUTORS].filter((e) => e !== 'other').sort()).toEqual(builtin);
    expect(HOPPER_IO_EXECUTORS).toContain('other');
  });

  it('is small: 50 machines fit in 8 KiB', () => {
    const machines = Array.from({ length: 50 }, (_, i) => machine(`m${i}`, { executors: ['herdr-claude', 'codex'] }));
    const s = projectHopperIoState(inputs({ machines, machineKey: (id) => `${id}`.padEnd(43, 'x') }));
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThan(8 * 1024);
  });
});
