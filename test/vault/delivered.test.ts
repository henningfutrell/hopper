// The vault secrets the vault delivered to a job (issue #1957): a checkpoint of the job is scrubbed of their values. The
// names come from the job's delivery events; each is read now, as a delivery reads it.
//
// Feature: the values delivered to a job
//   Scenario: each of the user's own secrets the job's delivery events name, once; another job's, a minting credential and a gone one are not
//   Scenario: with the shared secrets, the shared ones delivered to the job too
import { describe, expect, it } from 'vitest';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { deliveredValues } from '../../src/vault/delivered.ts';
import { withSharedSecrets } from '../../src/vault/shared-delivery.ts';
import type { Vault } from '../../src/vault/vault.ts';

const delivery = (type: string, name: string, jobId: string) => ({ type, jobId, data: { name } });
const events = [
  delivery('vault.delivered', 'DB_PASSWORD', 'j1'), delivery('vault.step_delivered', 'DB_PASSWORD', 'j1'), delivery('vault.step_delivered', 'API_KEY', 'j1'),
  delivery('vault.delivered', 'aws-lab', 'j1'), delivery('vault.delivered', 'GONE', 'j1'), delivery('vault.delivered', 'shared/team-token', 'j1'),
  delivery('vault.delivered', 'OTHER', 'j2'),
];
const store = {
  events: { recent: (_limit: number, types: string[], jobId: string) => events.filter((e) => types.includes(e.type) && e.jobId === jobId) },
  vault: { get: (name: string) => (['DB_PASSWORD', 'API_KEY', 'OTHER'].includes(name) ? { name } : name === 'aws-lab' ? { name, mints: { kind: 'aws-account' } } : undefined) },
};
const valueOf = async (s: VaultSecret) => ({ value: `value of ${s.name}` });

describe('the values delivered to a job (issue #1957)', () => {
  it('each of the user\'s own secrets the job\'s delivery events name, once; another job\'s, a minting credential and a gone one are not', async () => {
    expect(await deliveredValues(store as never, valueOf).deliveredTo('j1')).toEqual(['value of DB_PASSWORD', 'value of API_KEY']);
  });

  it('with the shared secrets, the shared ones delivered to the job too', async () => {
    const own = deliveredValues(store as never, valueOf);
    const shared = { read: async (row: string) => ({ value: `shared ${row}` }), list: () => [] };
    const vault = withSharedSecrets({ view: () => ({ templates: [] }), deliveredTo: own.deliveredTo } as unknown as Vault, { shared: shared as never, userId: 'u1', store: store as never, targets: () => [], holds: () => true });
    expect(await vault.deliveredTo('j1')).toEqual(['value of DB_PASSWORD', 'value of API_KEY', 'shared shared/team-token']);
  });
});
