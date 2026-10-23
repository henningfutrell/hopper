// A Windows job (issue #1350): an item labelled `hopper:win` or `hopper:windows` goes only to a Windows machine. When no
// Windows machine can take it, it waits queued and says why; it never falls back to a Linux machine.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job } from '../../src/domain/types.ts';
import { busy, inputs, job, machine } from './support.ts';

const labelled = (id: string, labels: string[], over: Partial<Job> & { machineId?: string } = {}): Job =>
  job(id, { source: { source: 'direct', kind: 'direct', key: `direct:${id}`, labels }, ...over });
const windowsJob = (id: string, over: Partial<Job> & { machineId?: string } = {}): Job => labelled(id, ['hopper:windows'], over);
const linux = machine({ id: 'fleet-l1', label: 'fleet-l1' });
const win = machine({ id: 'win-native', label: 'win-native', windows: true });

describe('a Windows job goes only to a Windows machine (issue #1350)', () => {
  it('no Windows machine: it waits queued, not held, and says it waits for a Windows lane', () => {
    const d = decide(inputs({ machines: [linux], waiting: [windowsJob('w')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'w', reason: 'waiting for a Windows lane: no Windows machine runs executor test' }]);
  });

  it('the Windows machine offline: it waits and names it, never the Linux machine', () => {
    const d = decide(inputs({ machines: [linux, { ...win, online: false }], waiting: [windowsJob('w')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'w', reason: 'waiting for a Windows lane: no Windows machine that runs executor test is online (win-native offline)' }]);
  });

  it('the Windows machine online: it starts there, though the Linux machine has more room', () => {
    const d = decide(inputs({ machines: [linux, { ...win, maxLanes: 1 }], waiting: [windowsJob('w')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'w', machineId: 'win-native' })]);
  });

  it.each(['hopper:win', 'hopper:windows', 'Hopper:Win'])('labelled %s, in any case', (label) => {
    const d = decide(inputs({ machines: [linux], waiting: [labelled('w', ['hopper', label])] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toMatch(/^waiting for a Windows lane/);
  });

  it('the Windows machine full: it waits for a lane there, never the Linux machine', () => {
    const d = decide(inputs({ machines: [linux, { ...win, maxLanes: 1 }], lanes: [busy(1, 'x', { machineId: 'win-native' })], waiting: [windowsJob('w')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait).toEqual([{ jobId: 'w', reason: 'waiting for a lane: machine win-native\'s lane cap is 1, all 1 in use; left out: fleet-l1 is not a Windows machine' }]);
  });

  it('pinned to a Linux machine: it waits for a Windows lane', () => {
    const d = decide(inputs({ machines: [linux, win], waiting: [windowsJob('w', { machineId: 'fleet-l1' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.wait[0]!.reason).toMatch(/^waiting for a Windows lane/);
  });

  it('a job with no Windows label goes anywhere, a Windows machine too', () => {
    const d = decide(inputs({ machines: [{ ...linux, online: false }, win], waiting: [labelled('o', ['hopper'])] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'o', machineId: 'win-native' })]);
  });
});
