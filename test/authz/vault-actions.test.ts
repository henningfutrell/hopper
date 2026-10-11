// Issue #718, item 4: what a running job may do for its user through the job door, decided by OpenFGA. Real Access over a
// real instance store, OpenFGA as a double that evaluates the default model. The job's user is told as the vault's owner
// at each ask; the default model lets the owner set a secret, save a template and launch a box. A model edited without
// the `vault` type denies each of them and names the gap; mints still work.
//
// Feature: a job's vault actions decided by OpenFGA
//   Scenario: the default model lets the user's job set a secret, save a template and launch a box in their own vault
//   Scenario: an action the model gives no one is denied, saying which
//   Scenario: a model without the vault type denies, naming the gap; a mint is still decided
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../../src/authz/service.ts';
import { DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import { VAULT_ACTIONS } from '../../src/domain/types.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { testDatabaseUrl } from '../support/database.ts';

const clock = { now: () => new Date('2026-10-10T12:00:00Z') };
const stores: InstanceStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

function accessOf() {
  const instance = openInstanceStore({ url: testDatabaseUrl(), clock });
  stores.push(instance);
  const fga = createFakeAuthorizationServer();
  const access = createAccess({
    repo: instance.access, server: fga, clock, logger: { warn: () => undefined },
    jobStatus: () => 'running',
    requesters: () => [{ userId: 'u1', jobs: [{ jobId: 'j1', machine: 'kbox' }], boxes: [{ machine: 'kbox', template: 'kube' }] }],
  });
  return { access, fga };
}

describe('a job\'s vault actions in OpenFGA (issue #718)', () => {
  it('the default model lets the user\'s job set a secret, save a template and launch a box in their own vault', async () => {
    const { access, fga } = accessOf();
    for (const action of VAULT_ACTIONS) expect(await access.decideVaultAction({ userId: 'u1', action })).toMatchObject({ allowed: true });
    const asked = fga.checks.filter((c) => c.tuple.object === 'vault:u1');
    expect(asked.map((c) => c.tuple.relation)).toEqual(['can_set_secret', 'can_save_template', 'can_launch_box']);
    expect(asked[0]!.contextual).toEqual([{ subject: 'user:u1', relation: 'owner', object: 'vault:u1' }]);
  });

  it('an action the model gives no one is denied, saying which', async () => {
    const { access } = accessOf();
    await access.setModel(DEFAULT_ACCESS_MODEL.replace('define can_launch_box: owner', 'define can_launch_box: [user]'), access.view().model.version, 'Ada');
    expect(await access.decideVaultAction({ userId: 'u1', action: 'launch-box' })).toEqual({ allowed: false, reason: 'user:u1 may not launch a box of vault:u1' });
    expect(await access.decideVaultAction({ userId: 'u1', action: 'set-secret' })).toMatchObject({ allowed: true });
  });

  it('a model without the vault type denies, naming the gap; a mint is still decided', async () => {
    const { access } = accessOf();
    const edited = DEFAULT_ACCESS_MODEL.replace(/# A user's vault and sandbox boxes[\s\S]*?define can_launch_box: owner\n/, '');
    expect(edited).not.toMatch(/^type vault$/m);
    await access.setModel(edited, access.view().model.version, 'Ada');
    expect(await access.decideVaultAction({ userId: 'u1', action: 'set-secret' })).toMatchObject({ allowed: false, reason: expect.stringContaining('vault#owner') });
    await access.approve('kube', { operation: 'read', asset: { kind: 'cluster', name: 'prod' } }, 'Ada');
    expect(await access.decideMint({ requester: { kind: 'job', userId: 'u1', jobId: 'j1' }, operation: 'read', asset: { kind: 'cluster', name: 'prod' } })).toMatchObject({ allowed: true });
  });
});
