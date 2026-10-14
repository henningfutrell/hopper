// The Windows link watch (issue #712): a WSL machine whose client found that Windows does not reach the hopper is told
// once (machine.windows_link_broken), and once more when Windows reaches it again (machine.windows_link_restored). A
// machine offline or with no result keeps what was told. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import type { MachineSnapshot, ResourceReading, WindowsLink } from '../../src/domain/types.ts';
import { WINDOWS_REPORTER, createWindowsLinkWatch, type WindowsLinkEvent } from '../../src/machines/windows-link-watch.ts';

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

// The Windows link report (issue #712, the path "The Windows keep-alive loop reports the Windows link"): the keep-alive
// loop on Windows tests the link itself and reports it through the operator CLI. A second source beside the clients: told
// as the machine `windows`, kept in memory, and dropped when older than 15 minutes.
describe('the Windows link report', () => {
  const reported = (ok: boolean, min: number): WindowsLink => ({ ...link(ok), at: at(min) });

  it('broken is told once as the machine windows; working again is told once', () => {
    const told: WindowsLinkEvent[] = [];
    const w = createWindowsLinkWatch({ tell: (e) => told.push(e) });
    w.report(reported(true, 0));
    expect(told).toEqual([]);
    w.report(reported(false, 5));
    w.report(reported(false, 10));
    expect(told).toEqual([{
      type: 'machine.windows_link_broken', machineId: WINDOWS_REPORTER,
      data: { machineId: WINDOWS_REPORTER, url: 'http://localhost:4790/api/health', mode: 'nat', error: 'Unable to connect to the remote server' },
    }]);
    w.report(reported(true, 15));
    expect(told.map((e) => e.type)).toEqual(['machine.windows_link_broken', 'machine.windows_link_restored']);
  });

  it('the last report is kept for 15 minutes, then dropped', () => {
    const w = createWindowsLinkWatch({ tell: () => {} });
    expect(w.reported(at(0))).toBeUndefined();
    w.report(reported(false, 0));
    expect(w.reported(at(15))).toEqual(reported(false, 0));
    expect(w.reported(at(16))).toBeUndefined();
  });

  it('a client\'s machine and the report are told apart', () => {
    const told: WindowsLinkEvent[] = [];
    const w = createWindowsLinkWatch({ tell: (e) => told.push(e) });
    w.observe([machine(link(false))], at(0));
    w.report(reported(false, 0));
    expect(told.map((e) => e.machineId)).toEqual(['win', WINDOWS_REPORTER]);
    w.observe([machine(link(true))], at(1));
    expect(told.map((e) => `${e.machineId} ${e.type}`)).toEqual(['win machine.windows_link_broken', `${WINDOWS_REPORTER} machine.windows_link_broken`, 'win machine.windows_link_restored']);
  });
});
