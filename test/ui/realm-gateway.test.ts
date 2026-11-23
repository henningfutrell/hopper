// Settings → Sign-in offers a gateway realm (issue #215) as a type with fields of its own: the issuer, how
// its token is checked, the audience, the header the auth gateway forwards it in, the introspection client.
import { describe, expect, it } from 'vitest';
import type { RealmType } from '../../src/domain/types.ts';

interface Field { path: string }
// Browser code, type-checked by ui/tsconfig.json: imported by path.
const model = '../../ui/src/model/realms.ts';
const { REALM_FIELDS, REALM_TYPE_LABELS, draftOf, realmOf } = (await import(model)) as {
  REALM_FIELDS: Record<RealmType, Field[]>; REALM_TYPE_LABELS: { type: RealmType }[];
  draftOf: (r: { name: string; label: string; type: RealmType; settings: Record<string, unknown>; secrets: string[] }) => unknown;
  realmOf: (d: unknown) => Record<string, unknown>;
};

describe('the gateway realm type', () => {
  it('is offered when adding a realm', () => {
    expect(REALM_TYPE_LABELS.map((t) => t.type)).toContain('gateway');
  });

  it('has a field for every setting, none for a secret itself', () => {
    expect(REALM_FIELDS.gateway.map((f) => f.path)).toEqual([
      'issuer', 'check', 'audience', 'header', 'clientId', 'clientSecret',
      'claims.email', 'claims.username', 'claims.name', 'claims.groups', 'trustUnverifiedEmail', 'firstAdmin',
      'roles.provider', 'roles.check.url', 'roles.check.object', 'roles.check.permissions.admin', 'roles.check.permissions.operator', 'roles.check.permissions.viewer',
    ]);
  });

  it('saves the role provider (issue #2986) in roles, beside the role rules, and reads it back', () => {
    const realm = { name: 'edge', label: 'edge', type: 'gateway' as const, secrets: [], settings: {
      issuer: 'https://idp.example.com', audience: ['hopper'],
      roles: { provider: 'check', check: { url: 'https://authz.example.com/check', object: 'app:hopper' }, admin: { subjects: ['s1'] } },
    } };
    expect(realmOf(draftOf(realm))).toEqual({ name: 'edge', type: 'gateway', ...realm.settings });
  });
});
