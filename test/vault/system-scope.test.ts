// Issue #657: the vault's system scope. A system secret (`system/<name>`, the hopper's own use for one user, such as their
// TypeSafe API key) sits in the vault's table, sealed like any other, but it is none of the vault's own secrets: the
// vault's view does not list it, no template may hold it, and a job's ask for it is refused. Access decides the ask, and
// a model edit that would allow it still gives nothing.
//
// Feature: the vault's system scope
//   Scenario: the view lists no system secret; a template that names one is refused
//   Scenario: a job on a box asks for a system secret: Access is asked, and the ask is refused and recorded
//   Scenario: even when Access allows it, a system secret is never given to a job
//   Scenario: every kind of system secret (issue #658) is refused to a job, Access asked for each
import { describe, expect, it } from 'vitest';
import type { SystemSecretAsk, VaultAccess } from '../../src/domain/access.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { Template, VaultSecret } from '../../src/domain/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { mintLinkKey } from '../../src/client/link.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createVaultService, vaultContext } from '../../src/vault/service.ts';
import { KEY } from '../support/webhooks.ts';

const sealer = createSealer(KEY);
const SYSTEM: VaultSecret = { id: 's1', name: 'system/typesafe-api-key', setBy: 'Ada', createdAt: '2026-10-10T00:00:00Z', changedBy: 'Ada', changedAt: '2026-10-10T00:00:00Z' };
const PLAIN: VaultSecret = { id: 'p1', name: 'KUBE_TOKEN', setBy: 'Ada', createdAt: '2026-10-10T00:00:00Z', changedBy: 'Ada', changedAt: '2026-10-10T00:00:00Z' };
const KUBE: Template = {
  name: 'kube', image: 'localhost/box:1', secrets: ['KUBE_TOKEN'], savedBy: 'Ada', savedAt: '2026-10-10T00:00:00Z',
  approval: { image: 'localhost/box:1', secrets: ['KUBE_TOKEN', 'system/typesafe-api-key'], by: 'Ada', at: '2026-10-10T00:00:00Z' },
};
const link = mintLinkKey();
const job = { id: 'j1', status: 'running', laneId: 'kbox/lane-1' } as Job;

function vaultWith(allow: boolean, extra: VaultSecret[] = []) {
  const secrets = [SYSTEM, PLAIN, ...extra];
  const events: NewEvent[] = [];
  const asks: SystemSecretAsk[] = [];
  const store = {
    vault: {
      list: () => secrets, get: (name: string) => secrets.find((s) => s.name === name), add: () => true, replace: () => true,
      sealed: (id: string) => sealer.seal(`value-of-${id}`, vaultContext(id)), remove: () => false,
      templates: () => [KUBE], template: (name: string) => (name === 'kube' ? KUBE : undefined), saveTemplate: () => {},
    },
    events: { append: (e: NewEvent) => { events.push(e); return e; } },
    tx: <T>(fn: () => T): T => fn(),
    jobs: { get: (id: string) => (id === job.id ? job : undefined) },
    settings: { getBlastRadius: () => undefined },
  };
  const access = {
    approvedProfiles: () => [], revokeProfile: async () => {}, approve: async () => {}, decideMint: async () => { throw new Error('not here'); },
    decideSystemSecret: async (ask: SystemSecretAsk) => { asks.push(ask); return allow ? { allowed: true, reason: 'allowed' } : { allowed: false, reason: 'job:u1/j1 may not read system_secret:u1/typesafe-api-key' }; },
  } as unknown as VaultAccess;
  const vault = createVaultService({
    store: store as never, keys: { sealer }, clock: { now: () => new Date('2026-10-10T00:00:00Z') }, idGen: () => 'id-1',
    logger: { warn: () => {} }, holds: () => true, access, userId: 'u1',
    targets: () => [{ name: 'kbox', key: 'k1', template: 'kube' }],
  });
  return { vault, events, asks };
}

describe('the vault\'s system scope (issue #657)', () => {
  it('the view lists no system secret; a template that names one is refused', async () => {
    const { vault } = vaultWith(false);
    expect(vault.view().secrets.map((s) => s.name)).toEqual(['KUBE_TOKEN']);
    const r = await vault.saveTemplate({ name: 'kube', image: 'localhost/box:1', secrets: ['KUBE_TOKEN', 'system/typesafe-api-key'] }, 'Ada');
    expect(r).toEqual({ ok: false, code: 'invalid', error: expect.stringContaining('system/typesafe-api-key is in the vault\'s system scope') });
    expect(vault.templateScopes()[0]!.scope.secrets.map((s) => s.name)).toEqual(['KUBE_TOKEN']);
  });

  it('a job on a box asks for a system secret: Access is asked, and the ask is refused and recorded', async () => {
    const { vault, events, asks } = vaultWith(false);
    const token = proxyToken(link.privateKey, 'u1', job.id);
    const r = await vault.deliver({ name: 'system/typesafe-api-key', token }, 'k1');
    expect(r).toEqual({ refused: expect.stringContaining('may not read system_secret') });
    expect(asks).toEqual([{ requester: { kind: 'job', userId: 'u1', jobId: 'j1' }, owner: 'u1', name: 'typesafe-api-key', action: 'read' }]);
    expect(events.map((e) => e.type)).toEqual(['vault.refused']);
    expect(JSON.stringify(events)).not.toContain('value-of-');
    // A plain secret in the approved scope is still given.
    expect(await vault.deliver({ name: 'KUBE_TOKEN', token }, 'k1')).toEqual({ value: 'value-of-p1' });
  });

  it('even when Access allows it, a system secret is never given to a job', async () => {
    const { vault } = vaultWith(true);
    const r = await vault.deliver({ name: 'system/typesafe-api-key', token: proxyToken(link.privateKey, 'u1', job.id) }, 'k1');
    expect(r).toEqual({ refused: expect.stringContaining('system scope') });
  });

  // Issue #658: every kind of the hopper's own secret, the GitHub connection's tokens, a webhook's signing secret and a
  // sign-in realm's secret too: Access is asked for each, and the job gets none, whatever it answers.
  it('a job is refused every kind of system secret, and Access is asked for each', async () => {
    const rows = ['connected-account.github.access-token', 'connected-account.github.refresh-token', 'webhook.w1.signing-secret', 'sign-in.corp.clientSecret']
      .map((n, i) => ({ ...SYSTEM, id: `s${i + 2}`, name: `system/${n}` }));
    for (const allow of [false, true]) {
      const { vault, asks, events } = vaultWith(allow, rows);
      const token = proxyToken(link.privateKey, 'u1', job.id);
      for (const row of rows) expect(await vault.deliver({ name: row.name, token }, 'k1'), row.name).toHaveProperty('refused');
      expect(asks.map((a) => [a.name, a.action, a.requester.kind])).toEqual(rows.map((r) => [r.name.slice('system/'.length), 'read', 'job']));
      expect(events.map((e) => e.type)).toEqual(rows.map(() => 'vault.refused'));
      expect(JSON.stringify(events)).not.toContain('value-of-');
    }
  });
});
