// Issue #2367: every store call blocks the event loop, so the vault's view reads access's approvals, the blast radius
// rules and the vault's secrets once for every template, not once for each template. A hopper with many templates
// stalled for seconds on one sandbox request: 5,128 access_tuples and 5,145 settings reads.
//
// Feature: the vault's view reads the store once
//   Scenario: the view of 20 templates reads the approvals, the rules and the secrets once each
//   Scenario: the template scopes read the rules and the secrets once each
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { Template, VaultSecret } from '../../src/domain/vault.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createVaultService } from '../../src/vault/service.ts';
import { KEY } from '../support/webhooks.ts';

const AT = '2026-10-10T00:00:00Z';
const READ: OperationProfile = { operation: 'read', asset: { kind: 'cluster', name: 'prod' } };
const secrets: VaultSecret[] = [{ id: 'p1', name: 'KUBE_TOKEN', scope: 'read the prod cluster', setBy: 'Ada', createdAt: AT, changedBy: 'Ada', changedAt: AT }];
const templates: Template[] = Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, image: 'localhost/box:1', secrets: ['KUBE_TOKEN'], profiles: [READ], savedBy: 'Ada', savedAt: AT }));

function vaultCounting() {
  const reads = { approvals: 0, rules: 0, secret: 0, secrets: 0 };
  const store = {
    vault: {
      list: () => { reads.secrets++; return secrets; }, get: (name: string) => { reads.secret++; return secrets.find((s) => s.name === name); },
      templates: () => templates, template: (name: string) => templates.find((t) => t.name === name),
    },
    events: { append: () => {} },
    tx: <T>(fn: () => T): T => fn(),
    settings: { getBlastRadius: () => { reads.rules++; return undefined; } },
  };
  const access = { approvedProfiles: () => { reads.approvals++; return new Map([['t3', [READ]]]); } };
  const vault = createVaultService({
    store: store as never, keys: { sealer: createSealer(KEY) }, clock: { now: () => new Date(AT) }, idGen: () => 'id-1',
    logger: { warn: () => {} }, holds: () => true, access: access as never, userId: 'u1',
  });
  return { vault, reads };
}

describe('the vault\'s view reads the store once (issue #2367)', () => {
  it('the view of 20 templates reads the approvals, the rules and the secrets once each', () => {
    const { vault, reads } = vaultCounting();
    const view = vault.view();
    expect(view.templates).toHaveLength(20);
    expect(view.templates.find((t) => t.name === 't3')!.pending.profiles).toEqual([]);
    expect(view.templates.find((t) => t.name === 't4')!.pending.profiles).toEqual([READ]);
    expect(reads).toEqual({ approvals: 1, rules: 1, secret: 0, secrets: 2 });
  });

  it('the template scopes read the rules and the secrets once each', () => {
    const { vault, reads } = vaultCounting();
    const scopes = vault.templateScopes();
    expect(scopes).toHaveLength(20);
    expect(scopes[0]!.scope.secrets).toEqual([{ name: 'KUBE_TOKEN', scope: 'read the prod cluster' }]);
    expect(reads).toEqual({ approvals: 0, rules: 1, secret: 0, secrets: 1 });
  });
});
