// The Machines list view (ui/src/model/machine-list.ts, issue #2352), pure: a machine's badges as its card and its row show
// them, whether it has an alert, its row's short readings, and the view mode read back from browser storage.
import { describe, expect, it } from 'vitest';
import { machineBadges, machineHasAlert, machineRow, nodeText, parseMachinesMode } from '../../ui/src/model/machine-list.ts';
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

  it('a machine below the patched Node floor has a Node unpatched warning, and its card says what to update to (issue #2479)', () => {
    const resources = { cores: 2, memTotalBytes: 8, memAvailableBytes: 4, node: 'v26.8.2', nodeFloor: '26.12.1' };
    const m = desk({ resources } as unknown as Partial<MachineView>);
    expect(machineBadges(m, NOW)).toEqual([{ status: 'Node unpatched', tone: 'warn' }, { status: 'online' }]);
    expect(machineHasAlert(m, NOW)).toBe(true);
    expect(nodeText(resources)).toBe('v26.8.2: it lacks the October 21, 2026 security release. Update Node there to 26.12.1 or later');
    expect(nodeText({ node: 'v26.12.1' })).toBe('v26.12.1');
    expect(machineHasAlert(desk({ resources: { ...resources, node: 'v26.12.1', nodeFloor: undefined } } as unknown as Partial<MachineView>), NOW)).toBe(false);
  });

  // Issue #2622 part 6: a burst of large page allocation failures comes before wsl.exe hangs on a WSL host.
  it('a machine whose kernel logged a burst of large allocation failures has a warning and an alert; fewer have none', () => {
    const resources = { cores: 2, memTotalBytes: 8, memAvailableBytes: 4, memAllocFailures: { count: 3, maxOrder: 7 } };
    const m = desk({ resources } as unknown as Partial<MachineView>);
    expect(machineBadges(m, NOW)).toEqual([{ status: 'allocation failures', tone: 'warn' }, { status: 'online' }]);
    expect(machineHasAlert(m, NOW)).toBe(true);
    expect(machineHasAlert(desk({ resources: { ...resources, memAllocFailures: { count: 2, maxOrder: 7 } } } as unknown as Partial<MachineView>), NOW)).toBe(false);
  });

  // Issue #2622: one burst of builds on a machine whose jobs no memory limit holds can take the whole host.
  it('a machine whose jobs no memory limit holds has a no memory limit warning and an alert', () => {
    const resources = { cores: 2, memTotalBytes: 8, memAvailableBytes: 4, jobMemoryLimit: 'none' };
    const m = desk({ resources } as unknown as Partial<MachineView>);
    expect(machineBadges(m, NOW)).toEqual([{ status: 'no memory limit', tone: 'warn' }, { status: 'online' }]);
    expect(machineHasAlert(m, NOW)).toBe(true);
    for (const held of ['scope', 'machine']) {
      expect(machineHasAlert(desk({ resources: { ...resources, jobMemoryLimit: held } } as unknown as Partial<MachineView>), NOW)).toBe(false);
    }
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
