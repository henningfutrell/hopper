// API tokens in the UI (ui/src/model/api-tokens.ts, issue #718), pure: the roles a person may give a token — theirs and the
// ones below —, and the line each listed token shows: its role, whether it is a box token (issue #795), its end, and whether it was used.
import { describe, expect, it } from 'vitest';
import { apiTokenLine, mintableRoles } from '../../ui/src/model/api-tokens.ts';

describe('API tokens model', () => {
  it('a person gives a token their role or a lower one', () => {
    expect(mintableRoles('admin')).toEqual(['viewer', 'operator', 'admin']);
    expect(mintableRoles('operator')).toEqual(['viewer', 'operator']);
    expect(mintableRoles('viewer')).toEqual(['viewer']);
    expect(mintableRoles(undefined)).toEqual([]);
  });

  it('a token\'s line says its role, its end, and whether it was used', () => {
    const t = { id: '0123456789abcdef', label: 'Grok Bot', role: 'operator' as const, box: false, startedAt: '2026-10-10T10:00:00Z', expiresAt: '2026-10-10T10:15:00Z', lastUsedAt: '2026-10-10T10:00:00Z' };
    expect(apiTokenLine(t)).toMatch(/^operator · ends .+ · not used yet$/);
    expect(apiTokenLine({ ...t, lastUsedAt: '2026-10-10T10:05:00Z' })).toMatch(/^operator · ends .+ · last used .+$/);
    // Issue #795: a box token says so; it alone may do box actions.
    expect(apiTokenLine({ ...t, box: true })).toMatch(/^operator · box token · ends .+ · not used yet$/);
  });
});
