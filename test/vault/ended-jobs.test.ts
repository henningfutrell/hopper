// What the vault keeps in memory for each job (issue #1402): a denied grant ask, and the mints made for it, go once the
// job is no longer at work, so the vault's memory does not grow with every job that ever ran.
//
// Feature: the vault forgets ended jobs
//   Scenario: a denial of a job that ended goes at the next denial
//   Scenario: the mints of a job that ended go at the next mint
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job } from '../../src/domain/types.ts';
import { holdsProxyToken, proxyToken } from '../../src/github-proxy/token.ts';
import { withVaultGrants } from '../../src/vault/grants.ts';
import { createMinting } from '../../src/vault/mint.ts';
import type { Vault } from '../../src/vault/vault.ts';

const clock = { now: () => new Date('2026-10-16T12:00:00Z') };
const jobsOf = (...ids: string[]) => new Map(ids.map((id) => [id, { id, status: 'running', laneId: 'box-a/lane-1' } as unknown as Job]));

describe('the vault forgets ended jobs (issue #1402)', () => {
  it('a denial of a job that ended goes at the next denial', async () => {
    const jobs = jobsOf('j1', 'j2');
    const denied = new Set<string>();
    const store = {
      events: { append: () => undefined }, jobs: { get: (id: string) => jobs.get(id), opensDoors: () => true }, vaultGrants: { get: () => undefined },
      tx: <T>(f: () => T) => f(), directJobs: { get: () => undefined }, settings: {},
    };
    const vault = withVaultGrants({ view: () => ({ templates: [] }) } as unknown as Vault, { store: store as never, clock, targets: () => [], holds: () => true, denied });
    await vault.forStep({ job: 'j1', name: 's', host: 'win' } as never);
    expect(vault.denyGrant!('j1', 'person')).toEqual({ ok: true });
    expect([...denied]).toEqual(['j1']);
    jobs.set('j1', { ...jobs.get('j1')!, status: 'finished' } as Job);
    await vault.forStep({ job: 'j2', name: 's', host: 'win' } as never);
    expect(vault.denyGrant!('j2', 'person')).toEqual({ ok: true });
    expect([...denied]).toEqual(['j2']);
  });

  it('the mints of a job that ended go at the next mint', async () => {
    const link = mintLinkKey();
    const jobs = jobsOf('j1', 'j2');
    const minted = new Map<string, Set<string>>();
    const credential = { id: 'c1', name: 'cluster-lab', mints: { kind: 'cluster', name: 'lab' } };
    const store = {
      events: { append: () => undefined }, jobs: { get: (id: string) => jobs.get(id) }, tx: <T>(f: () => T) => f(), config: { read: () => undefined }, topology: { list: () => [] },
      vault: { list: () => [credential], get: () => credential, replace: () => undefined, sealed: () => undefined, template: () => undefined },
    };
    const mint = createMinting({
      store: store as never, userId: 'u1', clock, minted,
      targets: () => [{ name: 'box-a', key: 'ka', template: 'kube' }], holds: (p) => holdsProxyToken(link.privateKey, p),
      access: { decideMint: async () => ({ allowed: true, id: 'd1' }), approvedProfiles: () => new Map() } as never,
    });
    const from = async () => ({ minted: { kind: 'kube' as const, token: 't', expirationTimestamp: '2026-10-16T13:00:00Z' }, reach: { kind: 'kube' } as never });
    const ask = (job: string) => ({ mint: 'kube' as const, operation: 'read', asset: 'cluster/lab', token: proxyToken(link.privateKey, 'u1', job) });
    expect(await mint(ask('j1'), 'ka', from)).toHaveProperty('value');
    expect([...minted.keys()]).toEqual(['j1']);
    jobs.set('j1', { ...jobs.get('j1')!, status: 'finished' } as Job);
    expect(await mint(ask('j2'), 'ka', from)).toHaveProperty('value');
    expect([...minted.keys()]).toEqual(['j2']);
  });
});
