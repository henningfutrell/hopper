// Issue #655, part 15: the trust stamp in OpenFGA. Real Access over a real instance store, OpenFGA as a double that
// evaluates the default model. Each live job whose stamp verifies holds `trust:<level>` for its level and each level
// below it (`trust:<level>#holder@job`), so `trust:approved#holder` is every live job at approved or above. An admin
// can set a **minimum trust** on an operation profile: then a job below it is not a requester of that profile, whatever
// its template's approvals say. A box and a person are no job: the minimum does not gate them. A model edited without
// the trust relations writes no trust tuple, refuses a minimum trust, and still decides mints.
//
// Feature: trust stamps as OpenFGA tuples
//   Scenario: a live job holds its level and each level below it; a quarantined job or one with no verified level holds none
//   Scenario: a minimum trust on a profile denies a job below it, says why, and allows one at it; cleared, it allows again
//   Scenario: the minimum gates jobs only: the job's box and its user still reach the profile
//   Scenario: the permission matrix shows a job's trust, and no grant below the minimum
//   Scenario: a trial is told a level (owner when none is given)
//   Scenario: a model the hopper wrote before part 15 is upgraded to the default at the start
//   Scenario: a model without the trust relations writes no trust tuple, refuses a minimum, and refuses to drop one that is set
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../../src/authz/service.ts';
import { DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import { TRUST_MODEL } from '../../src/authz/trust-model.ts';
import type { LiveRequesters } from '../../src/domain/types.ts';
import type { TrustLevel } from '../../src/domain/trust-stamp.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { testDatabaseUrl } from '../support/database.ts';

const clock = { now: () => new Date('2026-10-17T12:00:00Z') };
const stores: InstanceStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

const PROD = { kind: 'cluster', name: 'prod' } as const;
const read = { operation: 'read', asset: PROD } as const;
const job = (jobId: string) => ({ requester: { kind: 'job', userId: 'u1', jobId }, ...read } as const);

function accessOf(levels: Record<string, TrustLevel | undefined>) {
  const instance = openInstanceStore({ url: testDatabaseUrl(), clock });
  stores.push(instance);
  const fga = createFakeAuthorizationServer();
  const live = (): LiveRequesters[] => [{
    userId: 'u1',
    jobs: Object.entries(levels).map(([jobId, trust]) => ({ jobId, machine: 'kbox', ...(trust ? { trust } : {}) })),
    boxes: [{ machine: 'kbox', template: 'kube' }],
  }];
  const access = createAccess({ repo: instance.access, server: fga, clock, logger: { warn: () => undefined }, jobStatus: () => 'running', requesters: live });
  const held = () => [...fga.storeTuples([...fga.stores.keys()][0]!).keys()];
  return { access, fga, held };
}

describe('trust stamps as OpenFGA tuples (issue #655, part 15)', () => {
  it('writes each live job its level and each level below it; a quarantined job, or one with no verified level, holds none', async () => {
    const { access, held } = accessOf({ ja: 'approved', jo: 'owner', jq: 'quarantined', jn: undefined });
    await access.approve('kube', read, 'Ada');
    const trust = held().filter((t) => t.includes(' holder '));
    expect(trust.filter((t) => t.startsWith('job:u1/ja ')).sort()).toEqual(['job:u1/ja holder trust:approved', 'job:u1/ja holder trust:screened', 'job:u1/ja holder trust:untrusted']);
    expect(trust.filter((t) => t.startsWith('job:u1/jo '))).toHaveLength(5);
    expect(trust.filter((t) => t.startsWith('job:u1/jq ') || t.startsWith('job:u1/jn '))).toEqual([]);
    expect(trust.some((t) => t.endsWith('trust:quarantined'))).toBe(false);
  });

  it('denies a job below a profile\'s minimum trust and says why, allows one at it, and allows again once it is cleared', async () => {
    const { access, held } = accessOf({ ja: 'approved', jt: 'trusted' });
    await access.approve('kube', read, 'Ada');
    expect((await access.decideMint(job('ja'))).allowed).toBe(true);

    await access.setMinTrust(read, 'trusted', 'Ada');
    expect(held()).toEqual(expect.arrayContaining(['trust:trusted min_trust operation_profile:read/cluster/prod', 'job:* trust_gated operation_profile:read/cluster/prod']));
    const below = await access.decideMint(job('ja'));
    expect(below).toMatchObject({ allowed: false, reason: 'job ja is at trust approved, below the minimum trust trusted to read on cluster prod' });
    const at = await access.decideMint(job('jt'));
    expect(at.allowed).toBe(true);
    // The path names the minimum, and the job's level that meets it.
    expect(at.path).toEqual(expect.arrayContaining([
      { subject: 'trust:trusted', relation: 'min_trust', object: 'operation_profile:read/cluster/prod' },
      { subject: 'job:u1/jt', relation: 'holder', object: 'trust:trusted' },
    ]));
    expect(access.view().minTrust).toEqual([{ profile: read, level: 'trusted', setBy: 'Ada', setAt: '2026-10-17T12:00:00.000Z' }]);

    // A new minimum replaces the old one: one per profile.
    await access.setMinTrust(read, 'approved', 'Ada');
    expect(access.view().minTrust).toEqual([expect.objectContaining({ level: 'approved' })]);
    expect((await access.decideMint(job('ja'))).allowed).toBe(true);

    await access.setMinTrust(read, null, 'Ada');
    expect(access.view().minTrust).toEqual([]);
    expect(held().filter((t) => t.includes('min_trust') || t.includes('trust_gated'))).toEqual([]);
    expect((await access.decideMint(job('ja'))).allowed).toBe(true);
  });

  it('gates jobs only: the job\'s box and its user still reach the profile', async () => {
    const { access } = accessOf({ ja: 'screened' });
    await access.approve('kube', read, 'Ada');
    await access.setMinTrust(read, 'owner', 'Ada');
    expect((await access.decideMint(job('ja'))).allowed).toBe(false);
    expect((await access.decideMint({ requester: { kind: 'machine', userId: 'u1', machine: 'kbox' }, ...read })).allowed).toBe(true);
    expect((await access.decideMint({ requester: { kind: 'user', userId: 'u1' }, ...read })).allowed).toBe(true);
  });

  it('shows a job\'s trust in the permission matrix, and no grant below the minimum', async () => {
    const { access } = accessOf({ ja: 'approved', jt: 'trusted' });
    await access.approve('kube', read, 'Ada');
    await access.setMinTrust(read, 'trusted', 'Ada');
    const rows = access.view().requesters.filter((r) => r.requester.kind === 'job');
    expect(rows).toEqual([
      expect.objectContaining({ requester: { kind: 'job', userId: 'u1', jobId: 'ja' }, trust: 'approved', grants: [] }),
      expect.objectContaining({ requester: { kind: 'job', userId: 'u1', jobId: 'jt' }, trust: 'trusted', grants: [expect.objectContaining({ profile: read })] }),
    ]);
  });

  it('tells a trial the level it names, owner when it names none', async () => {
    const { access, fga } = accessOf({});
    await access.approve('kube', read, 'Ada');
    await access.setMinTrust(read, 'trusted', 'Ada');
    expect((await access.tryCheck({ template: 'kube', ...read }, 'Ada')).allowed).toBe(true);
    expect(fga.checks.at(-1)!.contextual).toContainEqual({ subject: expect.stringMatching(/^job:trial\//), relation: 'holder', object: 'trust:owner' });
    const approved = await access.tryCheck({ template: 'kube', ...read, level: 'approved' }, 'Ada');
    expect(approved).toMatchObject({ allowed: false, trial: { by: 'Ada', level: 'approved' } });
  });

  it('with a model without the trust relations: no trust tuple, a minimum refused, mints still decided; a model that drops them is refused while a minimum is set', async () => {
    const { access, held } = accessOf({ ja: 'approved' });
    await access.approve('kube', read, 'Ada');
    await access.setMinTrust(read, 'trusted', 'Ada');
    // The operation profile as the default model wrote it before part 15.
    const edited = DEFAULT_ACCESS_MODEL.replace(TRUST_MODEL, 'type operation_profile\n  relations\n    define approved_for: [template]\n    define requester: requester from approved_for\n');
    expect(edited).not.toMatch(/type trust\b|min_trust/);
    await expect(access.setModel(edited, access.view().model.version, 'Ada')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('minimum trust') });

    await access.setMinTrust(read, null, 'Ada');
    await access.setModel(edited, access.view().model.version, 'Ada');
    expect(held().filter((t) => / holder |min_trust|trust_gated/.test(t))).toEqual([]);
    await expect(access.setMinTrust(read, 'trusted', 'Ada')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('trust#holder') });
    expect((await access.decideMint(job('ja'))).allowed).toBe(true);
  });

  it('upgrades a model the hopper wrote before part 15 to the default at the start', async () => {
    const instance = openInstanceStore({ url: testDatabaseUrl(), clock });
    stores.push(instance);
    instance.access.addModel(DEFAULT_ACCESS_MODEL.replace(TRUST_MODEL, 'type operation_profile\n  relations\n    define approved_for: [template]\n    define requester: requester from approved_for\n'), 'hopper', '2026-10-16T00:00:00.000Z');
    const access = createAccess({ repo: instance.access, server: createFakeAuthorizationServer(), clock, logger: { warn: () => undefined }, jobStatus: () => 'running', requesters: () => [] });
    access.start();
    await access.stop();
    expect(access.view().model.dsl).toBe(DEFAULT_ACCESS_MODEL);
  });
});
