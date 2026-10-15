// Issue #1128 part 5, failover: a machine whose agent tool reads signed out takes no new job of that tool's executors.
// The job goes to a machine on another account, or is held with the reason; a job resuming in its pane is not kept off.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { signedOutOf } from '../../src/decider/signed-out.ts';
import type { SignedOutTool } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

const OUT: SignedOutTool = { machineId: 'seat', source: 'claude-seat', service: 'claude', executors: ['test'] };

describe('signed-out machines', () => {
  it('a job goes to a machine whose tool is signed in', () => {
    const machines = [machine({ id: 'seat', maxLanes: 4 }), machine({ id: 'host', maxLanes: 1 })];
    const d = decide(inputs({ machines, signedOut: [OUT], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
    expect(d.reasons).toContain('seat: claude signed out (usage source claude-seat): no new job of executor test');
  });

  it('only such machines: the job is held with the reason, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat' })], signedOut: [OUT], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'no machine running executor test is signed in: seat (claude signed out): sign it in from Accounts' }]);
    expect(d.lanes.find((l) => l.machineId === 'seat')?.idle).toBe('claude signed out: sign it in from Accounts; no new job is claimed there');
  });

  it('a job pinned to such a machine is held with the reason', () => {
    const machines = [machine({ id: 'seat' }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, signedOut: [OUT], waiting: [job('a', { machineId: 'seat' })] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'pinned machine seat: claude signed out (usage source claude-seat): sign it in from Accounts' }]);
  });

  it('another executor\'s jobs still run there', () => {
    const machines = [machine({ id: 'seat', executors: ['test', 'command'] })];
    const d = decide(inputs({ machines, signedOut: [OUT], waiting: [job('a', { executor: 'command' })] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'seat' })]);
  });

  it('a source that names no executor keeps every job off', () => {
    const machines = [machine({ id: 'seat', executors: ['test', 'command'] }), machine({ id: 'host', executors: ['command'] })];
    const { executors: _e, ...all } = OUT;
    const d = decide(inputs({ machines, signedOut: [all], waiting: [job('a', { executor: 'command' })] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
    expect(d.reasons).toContain('seat: claude signed out (usage source claude-seat): no new job of any executor');
  });

  it('a job resuming returns to its pane there', () => {
    const d = decide(inputs({ machines: [machine({ id: 'seat' })], signedOut: [OUT], waiting: [job('a', { machineId: 'seat', pendingAnswer: 'yes' })] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'seat' })]);
  });
});

describe('signedOutOf', () => {
  it('takes each usage source whose account on a machine reads signed out', () => {
    expect(signedOutOf([
      { name: 'claude-seat', state: { executors: ['herdr-claude'], account: { service: 'claude', detail: { machine: 'seat' }, signedOut: true } } },
      { name: 'claude-host', state: { account: { service: 'claude', identity: 'a@example.com', detail: { machine: 'host' } } } },
      { name: 'claude-box', state: { account: { service: 'claude', detail: { machine: 'box' }, problem: 'not dialled in' } } },
      { name: 'claude-any', state: { account: { service: 'claude', detail: {}, signedOut: true } } },
      { name: 'plain', state: undefined },
    ])).toEqual([{ machineId: 'seat', source: 'claude-seat', service: 'claude', executors: ['herdr-claude'] }]);
  });
});
