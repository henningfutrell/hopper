// The Machines list view (ui/src/model/machine-list.ts, issue #2352), pure: a machine's badges as its card and its row show
// them, whether it has an alert, its row's short readings, and the view mode read back from browser storage.
import { describe, expect, it } from 'vitest';
import { machineBadges, machineHasAlert, machineRow, parseMachinesMode } from '../../ui/src/model/machine-list.ts';
import type { MachineView } from '../../ui/src/model/wire.ts';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const desk = (o: Partial<MachineView> = {}): MachineView => ({ id: 'desk', label: 'desk', maxLanes: 3, online: true, executors: ['herdr-claude'], lanes: [], usage: [], ...o } as MachineView);

describe('the Machines view mode', () => {
  it('is Cards unless storage says list', () => {
    expect(parseMachinesMode(null)).toBe('cards');
    expect(parseMachinesMode('cards')).toBe('cards');
    expect(parseMachinesMode('list')).toBe('list');
    expect(parseMachinesMode('grid')).toBe('cards');
  });
});

describe('a machine\'s badges and alert', () => {
  it('a healthy online machine has only its online badge and no alert', () => {
    expect(machineBadges(desk(), NOW)).toEqual([{ status: 'online' }]);
    expect(machineHasAlert(desk(), NOW)).toBe(false);
  });

  it('a drained machine with low disk has both warnings, before its online badge, and an alert', () => {
    const m = desk({ drained: { at: '2026-10-21T11:00:00.000Z', by: 'admin' }, disk: { freeBytes: 1, totalBytes: 100, low: true } } as unknown as Partial<MachineView>);
    expect(machineBadges(m, NOW)).toEqual([{ status: 'drained', tone: 'warn' }, { status: 'disk low', tone: 'warn' }, { status: 'online' }]);
    expect(machineHasAlert(m, NOW)).toBe(true);
  });

  it('acknowledged credentials are a muted badge, not an alert', () => {
    const m = desk({ infraCredentials: ['aws'], credentialAcceptance: { credentials: ['aws'], acceptedAt: '2026-10-21T11:00:00.000Z' } } as unknown as Partial<MachineView>);
    expect(machineBadges(m, NOW)).toContainEqual({ status: 'credentials acknowledged', tone: 'muted' });
    expect(machineHasAlert(m, NOW)).toBe(false);
  });

  it('a work tree problem is an alert with no badge', () => {
    expect(machineHasAlert(desk({ workTreeProblem: 'no work tree' }), NOW)).toBe(true);
  });
});

describe('a machine\'s row', () => {
  it('says lanes in use of its max, CPU, memory, disk and version', () => {
    const m = desk({
      lanes: [{ id: 'desk/lane-1', machineId: 'desk', state: 'busy' }, { id: 'desk/lane-2', machineId: 'desk', state: 'idle' }],
      resources: { at: '2026-10-21T12:00:00.000Z', cores: 8, cpuBusyFrac: 0.25, memTotalBytes: 16e9, memAvailableBytes: 4e9 },
      disk: { freeBytes: 30e9, totalBytes: 100e9, low: false },
      client: { release: 'v1.2.3', current: true },
    } as unknown as Partial<MachineView>);
    expect(machineRow(m)).toEqual({ lanes: '1/3', cpu: '25%', memory: '75%', disk: '30% free', version: 'v1.2.3' });
  });

  it('says a dash for each reading it has none of', () => {
    expect(machineRow(desk())).toEqual({ lanes: '0/3', cpu: '—', memory: '—', disk: '—', version: '—' });
  });
});
