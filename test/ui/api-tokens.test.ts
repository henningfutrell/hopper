// Grants and API tokens in the UI (ui/src/model/api-tokens.ts, issues #718, #881), pure: the roles a person may give a
// grant — theirs and the ones below —, the line each listed grant and exchanged token shows, and the scopes a person types.
import { describe, expect, it } from 'vitest';
import { apiTokenLine, grantLine, mintableRoles, parseScopes } from '../../ui/src/model/api-tokens.ts';

describe('API tokens model', () => {
  it('a person gives a grant their role or a lower one', () => {
    expect(mintableRoles('admin')).toEqual(['viewer', 'operator', 'admin']);
    expect(mintableRoles('operator')).toEqual(['viewer', 'operator']);
    expect(mintableRoles('viewer')).toEqual(['viewer']);
    expect(mintableRoles(undefined)).toEqual([]);
  });

  it('an exchanged token\'s line says its role, its end, and whether it was used', () => {
    const t = { id: '0123456789abcdef', label: 'Grok Bot', role: 'operator' as const, box: false, startedAt: '2026-10-10T10:00:00Z', expiresAt: '2026-10-10T10:15:00Z', lastUsedAt: '2026-10-10T10:00:00Z' };
    expect(apiTokenLine(t)).toMatch(/^operator · ends .+ · not used yet$/);
    expect(apiTokenLine({ ...t, lastUsedAt: '2026-10-10T10:05:00Z' })).toMatch(/^operator · ends .+ · last used .+$/);
    // Issue #795: a box token says so; it alone may do box actions.
    expect(apiTokenLine({ ...t, box: true })).toMatch(/^operator · box token · ends .+ · not used yet$/);
  });

  it('a grant\'s line says its role, box flag, when it was made and used, from where, and its end', () => {
    const g = { id: '0123456789abcdef', label: 'Grok Bot', holder: 'grok-bot', role: 'operator' as const, box: true, scopes: ['*:read'], createdAt: '2026-10-10T10:00:00Z', endsAt: '2027-01-08T10:00:00Z', idleEndsAt: '2026-11-09T10:00:00Z' };
    expect(grantLine(g)).toMatch(/^operator · box · made .+ · not used yet · ends .+$/);
    expect(grantLine({ ...g, box: false, lastUsedAt: '2026-10-11T10:00:00Z', lastUsedFrom: '10.0.0.2', endsAt: null })).toMatch(/^operator · made .+ · last used .+ from 10\.0\.0\.2 · no fixed end$/);
  });

  it('scopes are typed apart by spaces or commas, once each', () => {
    expect(parseScopes(' *:read, questions:answer  sources:intake,*:read ')).toEqual(['*:read', 'questions:answer', 'sources:intake']);
    expect(parseScopes('  ')).toEqual([]);
  });
});
