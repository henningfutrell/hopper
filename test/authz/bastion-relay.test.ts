// Issue #2146 (the bastion path, part 3): Access decides each relay connection. OpenFGA's `bastion#can_relay`, asked for
// the job with its bastion's owner (the job), the job as running the bastion's template, and the template as approved
// for the target only when a person approved the target with it, told for that check only. Real Access over a real
// instance store; OpenFGA a double that evaluates the model.
//
// Feature: a job relays only to a target approved with its bastion's template
//   Scenario: a target approved with the template is allowed; one that is not is denied, asked of OpenFGA each time
//   Scenario: a model without bastions denies every relay and still decides mints
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../../src/authz/service.ts';
import { DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { testDatabaseUrl } from '../support/database.ts';

const clock = { now: () => new Date('2026-10-20T12:00:00Z') };
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
  return { access, fga, instance };
}

const ASK = { userId: 'u1', jobId: 'j1', template: 'observe-utility', target: 'utility/monitoring/svc/grafana:80' };

describe('a relay connection in Access (issue #2146, part 3)', () => {
  it('allows a target approved with the template; denies one that is not, asking OpenFGA each time', async () => {
    const { access, fga } = accessOf();
    expect(await access.decideRelay({ ...ASK, approved: true })).toMatchObject({ allowed: true, reason: 'job:u1/j1 may relay to utility/monitoring/svc/grafana:80' });
    expect(await access.decideRelay({ ...ASK, approved: false })).toMatchObject({ allowed: false, reason: 'job:u1/j1 may not relay to utility/monitoring/svc/grafana:80' });
    const asked = fga.checks.filter((c) => c.tuple.object.startsWith('bastion:'));
    expect(asked).toHaveLength(2);
    expect(asked[0]!.tuple).toEqual({ subject: 'job:u1/j1', relation: 'can_relay', object: 'bastion:u1/utility%2Fmonitoring%2Fsvc%2Fgrafana%3A80' });
  });

  it('a model without bastions denies every relay, and still decides mints', async () => {
    const { access } = accessOf();
    const before = DEFAULT_ACCESS_MODEL.slice(0, DEFAULT_ACCESS_MODEL.indexOf('\n# A target of a job\'s bastion'));
    await access.setModel(before, access.view().model.version, 'Ada');
    expect(await access.decideRelay({ ...ASK, approved: true })).toMatchObject({ allowed: false, reason: expect.stringContaining('bastion#can_relay') });
    await access.approve('kube', { operation: 'read', asset: { kind: 'cluster', name: 'prod' } }, 'Ada');
    expect(await access.decideMint({ requester: { kind: 'job', userId: 'u1', jobId: 'j1' }, operation: 'read', asset: { kind: 'cluster', name: 'prod' } })).toMatchObject({ allowed: true });
  });
});
