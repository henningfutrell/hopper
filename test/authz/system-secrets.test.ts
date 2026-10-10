// Issue #658, test 1: OpenFGA keeps the hopper's own secrets from everything a job runs. Real Access over a real
// instance store, OpenFGA as a double that evaluates the default model: for each kind of system secret — the TypeSafe
// API key, the GitHub connection's access and refresh tokens, a webhook signing secret, a sign-in realm's secret — a
// live job, the box it runs on, and the template that box is an instance of (approved for an operation profile) are each
// refused a read and a change. The user the secret is kept for may read it, so the check is a real one, not a deny
// for everyone.
//
// Feature: no job, worker or sandbox reads a system secret
//   Scenario: a job, its machine and its box's template are denied every system secret, read or change
//   Scenario: the secret's own user may read it; another user may not
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../../src/authz/service.ts';
import type { Requester } from '../../src/domain/access.ts';
import type { SystemSecretName } from '../../src/domain/vault.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { testDatabaseUrl } from '../support/database.ts';

const NAMES: SystemSecretName[] = [
  'typesafe-api-key', 'connected-account.github.access-token', 'connected-account.github.refresh-token',
  'webhook.3f2c9a.signing-secret', 'sign-in.corp.clientSecret',
];
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

describe('the system scope in OpenFGA (issue #658)', () => {
  it('a job, its machine and its box\'s template are denied every system secret, read or change', async () => {
    const { access, fga } = accessOf();
    // The box's template is approved for a profile: its requesters reach assets, never a system secret.
    await access.approve('kube', { operation: 'read', asset: { kind: 'cluster', name: 'prod' } }, 'Ada');
    const asking: Requester[] = [{ kind: 'job', userId: 'u1', jobId: 'j1' }, { kind: 'machine', userId: 'u1', machine: 'kbox' }];
    for (const name of NAMES) {
      for (const requester of asking) {
        for (const action of ['read', 'change'] as const) {
          const d = await access.decideSystemSecret({ requester, owner: 'u1', name, action });
          expect(d, `${requester.kind} ${action} ${name}`).toMatchObject({ allowed: false });
          expect(d.reason).toMatch(/may not/);
        }
      }
    }
    // Every one of those was asked of OpenFGA: none was decided without it.
    expect(fga.checks.filter((c) => c.tuple.object.startsWith('system_secret:'))).toHaveLength(NAMES.length * 4);
    expect(await access.decideMint({ requester: { kind: 'job', userId: 'u1', jobId: 'j1' }, operation: 'read', asset: { kind: 'cluster', name: 'prod' } })).toMatchObject({ allowed: true });
  });

  it('the secret\'s own user may read it; another user may not', async () => {
    const { access } = accessOf();
    for (const name of NAMES) {
      expect(await access.decideSystemSecret({ requester: { kind: 'user', userId: 'u1' }, owner: 'u1', name, action: 'read' })).toMatchObject({ allowed: true });
      expect(await access.decideSystemSecret({ requester: { kind: 'user', userId: 'u2' }, owner: 'u1', name, action: 'read' })).toMatchObject({ allowed: false });
    }
  });
});
