// Issue #718, item 3: shared secrets in OpenFGA. Real Access over a real instance store, OpenFGA as a double that
// evaluates the default model. A shared secret's readers are told at each ask: every user (`user:*`) when the admin
// named none, else the users named. Only the hopper's admin changes one. A model edited without `shared_secret` denies
// every shared secret and says what it lacks; mints still work.
//
// Feature: shared secrets decided by OpenFGA
//   Scenario: with no readers named, every user may read; only an admin may change
//   Scenario: with readers named, a user not named is denied
//   Scenario: a model without shared_secret denies, naming the gap; a mint is still decided
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../../src/authz/service.ts';
import { DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
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

describe('shared secrets in OpenFGA (issue #718)', () => {
  it('with no readers named, every user may read; only an admin may change', async () => {
    const { access, fga } = accessOf();
    for (const userId of ['u1', 'u2']) {
      expect(await access.decideSharedSecret({ userId, name: 'AWS_DIAG', action: 'read' })).toMatchObject({ allowed: true });
      expect(await access.decideSharedSecret({ userId, name: 'AWS_DIAG', action: 'change' })).toMatchObject({ allowed: false, reason: expect.stringMatching(/may not change/) });
    }
    expect(await access.decideSharedSecret({ userId: 'u1', name: 'AWS_DIAG', action: 'change', admin: true })).toMatchObject({ allowed: true });
    // Each was asked of OpenFGA, every user told as a reader with the wildcard.
    const asked = fga.checks.filter((c) => c.tuple.object === 'shared_secret:AWS_DIAG');
    expect(asked).toHaveLength(5);
    expect(asked[0]!.contextual).toContainEqual({ subject: 'user:*', relation: 'reader', object: 'shared_secret:AWS_DIAG' });
  });

  it('with readers named, a user not named is denied', async () => {
    const { access } = accessOf();
    expect(await access.decideSharedSecret({ userId: 'u1', name: 'AWS_DIAG', action: 'read', readers: ['u1'] })).toMatchObject({ allowed: true });
    expect(await access.decideSharedSecret({ userId: 'u2', name: 'AWS_DIAG', action: 'read', readers: ['u1'] }))
      .toMatchObject({ allowed: false, reason: 'user:u2 may not read shared_secret:AWS_DIAG' });
  });

  it('a model without shared_secret denies, naming the gap; a mint is still decided', async () => {
    const { access } = accessOf();
    const edited = DEFAULT_ACCESS_MODEL.replace(/# A secret an admin shares[\s\S]*?define can_read: reader\n/, '');
    expect(edited).not.toContain('shared_secret');
    await access.setModel(edited, access.view().model.version, 'Ada');
    expect(await access.decideSharedSecret({ userId: 'u1', name: 'AWS_DIAG', action: 'read' }))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('shared_secret#reader') });
    await access.approve('kube', { operation: 'read', asset: { kind: 'cluster', name: 'prod' } }, 'Ada');
    expect(await access.decideMint({ requester: { kind: 'job', userId: 'u1', jobId: 'j1' }, operation: 'read', asset: { kind: 'cluster', name: 'prod' } })).toMatchObject({ allowed: true });
  });
});
