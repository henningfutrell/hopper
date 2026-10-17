// A quarantined job's vault grant ask (issue #655 part 6): it is not shown on the Vault page and cannot be denied, so no
// person grants the item while the job is quarantined. The ask goes: after the lift, the job's next ask opens a new one.
//
// Feature: a quarantine hides the job's grant ask
//   Scenario: a job asks with no grant, then is quarantined: its ask is not open, and goes
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { withVaultGrants } from '../../src/vault/grants.ts';
import type { Vault } from '../../src/vault/vault.ts';

const clock = { now: () => new Date('2026-10-17T12:00:00Z') };

describe('a quarantined job\'s grant ask (issue #655 part 6)', () => {
  it('is not open while the job is quarantined, and cannot be denied', async () => {
    const job = { id: 'j1', status: 'running', spec: { goal: 'g', payload: {} } } as unknown as Job;
    let doors = true;
    const store = {
      events: { append: () => undefined }, jobs: { get: (id: string) => (id === job.id ? job : undefined), opensDoors: () => doors, getBySourceKey: () => undefined },
      vaultGrants: { get: () => undefined, list: () => [] }, tx: <T>(f: () => T) => f(), directJobs: { get: () => undefined }, settings: {},
    };
    const vault = withVaultGrants({ view: () => ({ templates: [] }) } as unknown as Vault, { store: store as never, clock, targets: () => [], holds: () => true });
    await vault.forStep({ job: 'j1', name: 's', host: 'win' } as never);
    expect(vault.view().grantAsks?.map((a) => a.job)).toEqual(['j1']);
    doors = false;
    expect(vault.view().grantAsks).toEqual([]);
    expect(vault.denyGrant!('j1', 'person')).toMatchObject({ ok: false, code: 'conflict' });
  });
});
