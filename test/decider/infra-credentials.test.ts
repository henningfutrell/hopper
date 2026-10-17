// Issues #1248, #1467: a machine whose job user holds credentials (a kube config, cloud CLI credentials, an ssh key, a token
// variable) takes jobs with a warning. Only a machine the credential check holds (`credentialHeld`: an admin stopped it, or
// strict mode is on and no admin acknowledged it) takes no new job: the job is held with the reason, never failed there.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { credentialHeld, credentialHeldIds, newCredentials } from '../../src/domain/machine-credentials.ts';
import { inputs, job, machine } from './support.ts';

const NOT_READY = 'is not ready: its job user holds credentials a job could use (.kube, .aws). Run its jobs as a dedicated user that holds none';

describe('machines whose job user holds credentials', () => {
  it('by default such a machine takes the job: the credentials are a warning', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', infraCredentials: ['.kube', '.aws'] })], waiting: [job('a')] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'box' })]);
    expect(d.hold).toEqual([]);
  });

  it('a held machine: a job goes to a machine the check does not hold', () => {
    const machines = [machine({ id: 'box', maxLanes: 4, infraCredentials: ['.kube', '.aws'] }), machine({ id: 'host', maxLanes: 1, infraCredentials: [] })];
    const d = decide(inputs({ machines, waiting: [job('a')], credentialHeld: ['box'] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'host' })]);
  });

  it('only held machines: the job is held with the reason, never failed', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', infraCredentials: ['.kube', '.aws'] })], waiting: [job('a')], credentialHeld: ['box'] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `no machine running executor test is ready: box ${NOT_READY}` }]);
  });

  it('a job pinned to a held machine is held with the reason', () => {
    const machines = [machine({ id: 'box', infraCredentials: ['.kube', '.aws'] }), machine({ id: 'host' })];
    const d = decide(inputs({ machines, waiting: [job('a', { machineId: 'box' })], credentialHeld: ['box'] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: `pinned machine box ${NOT_READY}` }]);
  });

  it('a job resuming there returns to the pane it holds', () => {
    const machines = [machine({ id: 'box', infraCredentials: ['.kube'] })];
    const d = decide(inputs({ machines, waiting: [job('a', { pendingAnswer: 'yes', resumeOn: 'box' })], credentialHeld: ['box'] }), 'd1');
    expect(d.hold).toEqual([]);
  });

  it('once its probe finds none, a held machine takes the job', () => {
    const d = decide(inputs({ machines: [machine({ id: 'box', infraCredentials: [] })], waiting: [job('a')], credentialHeld: ['box'] }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'box' })]);
  });
});

describe('the credential check\'s rule', () => {
  const ack = { machineKey: 'box', credentials: ['.kube'], acceptedBy: 'admin', acceptedAt: '2026-10-16T00:00:00.000Z' };
  const stop = { ...ack, revokedAt: '2026-10-16T01:00:00.000Z' };

  it('holds none by default, and none that holds no credential', () => {
    expect(credentialHeld(['.kube'], undefined, false)).toBe(false);
    expect(credentialHeld([], stop, true)).toBe(false);
    expect(credentialHeld(undefined, undefined, true)).toBe(false);
  });

  it('strict mode holds a machine no admin acknowledged; Use anyway lets it take jobs', () => {
    expect(credentialHeld(['.kube'], undefined, true)).toBe(true);
    expect(credentialHeld(['.kube'], ack, true)).toBe(false);
  });

  it('a stop holds the machine, strict mode or not', () => {
    expect(credentialHeld(['.kube'], stop, false)).toBe(true);
    expect(credentialHeld(['.kube'], stop, true)).toBe(true);
  });

  it('a credential the acknowledgement did not name is new', () => {
    expect(newCredentials(['.kube', '.aws'], ack)).toEqual(['.aws']);
    expect(newCredentials(['.kube'], ack)).toEqual([]);
    expect(newCredentials(['.kube'], undefined)).toEqual(['.kube']);
  });

  it('the held ids of a machine list', () => {
    const machines = [{ id: 'box', infraCredentials: ['.kube'] }, { id: 'host', infraCredentials: ['.aws'] }, { id: 'clean' }];
    expect(credentialHeldIds(machines, [stop], false)).toEqual(['box']);
    expect(credentialHeldIds(machines, [ack], true)).toEqual(['host']);
  });
});
