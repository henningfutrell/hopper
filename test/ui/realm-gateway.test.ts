// Settings → Sign-in offers a gateway realm (issue #215) as a type with fields of its own: the issuer, how
// its token is checked, the audience, the header the auth gateway forwards it in, the introspection client.
import { describe, expect, it } from 'vitest';
import type { RealmType } from '../../src/domain/types.ts';

interface Field { path: string }
// Browser code, type-checked by ui/tsconfig.json: imported by path.
const model = '../../ui/src/model/realms.ts';
const { REALM_FIELDS, REALM_TYPE_LABELS } = (await import(model)) as { REALM_FIELDS: Record<RealmType, Field[]>; REALM_TYPE_LABELS: { type: RealmType }[] };

describe('the gateway realm type', () => {
  it('is offered when adding a realm', () => {
    expect(REALM_TYPE_LABELS.map((t) => t.type)).toContain('gateway');
  });

  it('has a field for every setting, none for a secret itself', () => {
    expect(REALM_FIELDS.gateway.map((f) => f.path)).toEqual([
      'issuer', 'check', 'audience', 'header', 'clientId', 'clientSecretEnv',
      'claims.email', 'claims.username', 'claims.name', 'claims.groups', 'trustUnverifiedEmail',
    ]);
  });
});
