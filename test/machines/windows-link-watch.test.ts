// The Windows link watch (issue #712): a WSL machine whose client found that Windows does not reach the hopper is told
// once (machine.windows_link_broken), and once more when Windows reaches it again (machine.windows_link_restored). A
// machine offline or with no result keeps what was told. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot, ResourceReading, WindowsLink } from '../../src/domain/types.ts';
import { createWindowsLinkWatch, type WindowsLinkEvent } from '../../src/machines/windows-link-watch.ts';

const GIB = 1024 ** 3;
const at = (min: number) => new Date(Date.parse('2026-10-13T10:00:00.000Z') + min * 60_000).toISOString();
const link = (ok: boolean): WindowsLink => ok
  ? { url: 'http://localhost:4790/api/health', mode: 'nat', ok: true, status: 200, at: at(0) }
  : { url: 'http://localhost:4790/api/health', mode: 'nat', ok: false, error: 'Unable to connect to the remote server', at: at(0) };
const reading = (l: WindowsLink | undefined): ResourceReading => ({ cores: 8, memTotalBytes: 16 * GIB, memAvailableBytes: 8 * GIB, wsl: true, ...(l ? { windowsLink: l } : {}) });
const machine = (l: WindowsLink | undefined, online = true): MachineSnapshot =>
  ({ id: 'win', online, resources: reading(l) }) as unknown as MachineSnapshot;

function watch() {
  const told: WindowsLinkEvent[] = [];
  const w = createWindowsLinkWatch({ tell: (e) => told.push(e) });
  return { told, see: (m: MachineSnapshot, min: number) => w.observe([m], at(min)) };
}

describe('the Windows link watch', () => {
  it('broken is told once; working again is told once', () => {
    const w = watch();
    w.see(machine(link(true)), 0);
    expect(w.told).toEqual([]);
    w.see(machine(link(false)), 1);
    w.see(machine(link(false)), 2);
    expect(w.told).toEqual([{
      type: 'machine.windows_link_broken', machineId: 'win',
      data: { machineId: 'win', url: 'http://localhost:4790/api/health', mode: 'nat', error: 'Unable to connect to the remote server' },
    }]);
    w.see(machine(link(true)), 3);
    w.see(machine(link(true)), 4);
    expect(w.told.map((e) => e.type)).toEqual(['machine.windows_link_broken', 'machine.windows_link_restored']);
    expect(w.told[1]).toEqual({ type: 'machine.windows_link_restored', machineId: 'win', data: { machineId: 'win', url: 'http://localhost:4790/api/health', mode: 'nat' } });
  });

  it('offline or no result: nothing is told, and a broken link told stays told until it works', () => {
    const w = watch();
    w.see(machine(link(false)), 0);
    w.see(machine(link(false), false), 1);
    w.see(machine(undefined), 2);
    w.see(machine(link(false)), 3);
    expect(w.told.map((e) => e.type)).toEqual(['machine.windows_link_broken']);
    w.see(machine(link(true)), 4);
    expect(w.told.map((e) => e.type)).toEqual(['machine.windows_link_broken', 'machine.windows_link_restored']);
  });

  it('a machine that never had a broken link is never told it works', () => {
    const w = watch();
    w.see(machine(undefined), 0);
    w.see(machine(link(true)), 1);
    expect(w.told).toEqual([]);
  });
});
