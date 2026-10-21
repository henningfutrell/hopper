// Grants and API tokens in the UI (ui/src/model/api-tokens.ts, issues #718, #881), pure: the roles a person may give a
// grant — theirs and the ones below —, the line each listed grant and exchanged token shows, and the scopes a person
// ticks (issue #909): a box per scope of the registry, a preset's wildcards, and a box grant when a box action is ticked.
import { describe, expect, it } from 'vitest';
import { apiTokenLine, boxPermissions, deviceAskLine, deviceCodeOfHash, grantLine, mintableRoles, presetOfScopes, scopeTicked, toggleScope, typedLimits } from '../../ui/src/model/api-tokens.ts';
import type { ScopeRegistry } from '../../ui/src/model/wire.ts';

const permission = (scope: string, box = false, parent?: string) => ({ scope, description: scope, routes: [], role: 'viewer' as const, box, ...(parent ? { parent } : {}) });
const registry: ScopeRegistry = {
  sections: [
    { id: 'jobs', title: 'Jobs', description: '', permissions: [permission('jobs:approve', true), permission('jobs:cancel'), permission('jobs:read')] },
    { id: 'intake', title: 'Intake', description: '', permissions: [permission('sources:intake', true), permission('sources:intake.approve', true, 'sources:intake'), permission('sources:intake.assign', true, 'sources:intake'), permission('sources:read')] },
  ],
  presets: [
    { id: 'read-only', label: 'Read only', description: '', scopes: ['*:read'], box: false },
    { id: 'agent-intake', label: 'Agent', description: '', scopes: ['*:read', 'sources:intake'], box: true },
  ],
};
const known = ['jobs:approve', 'jobs:cancel', 'jobs:read', 'sources:intake', 'sources:intake.approve', 'sources:intake.assign', 'sources:read'];

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
    expect(grantLine({ ...g, jkt: 'k'.repeat(43) })).toMatch(/^operator · box · bound to its agent's key · made /);
    // Issue #892: a limited grant says what it acts on.
    expect(grantLine({ ...g, limits: { repos: ['acme/app', 'acme/api'], sources: ['github'] } })).toMatch(/^operator · box · only acme\/app, acme\/api · only the job sources github · made /);
    expect(grantLine({ ...g, box: false, lastUsedAt: '2026-10-11T10:00:00Z', lastUsedFrom: '10.0.0.2', endsAt: null })).toMatch(/^operator · made .+ · last used .+ from 10\.0\.0\.2 · no fixed end$/);
  });

  it('a box is ticked when a pattern covers its scope', () => {
    expect(scopeTicked(['*:read'], 'jobs:read')).toBe(true);
    expect(scopeTicked(['*:read'], 'jobs:cancel')).toBe(false);
    expect(scopeTicked(['jobs:*'], 'jobs:cancel')).toBe(true);
    expect(scopeTicked(['*'], 'sources:intake')).toBe(true);
    expect(scopeTicked([], 'jobs:read')).toBe(false);
  });

  it('a tick adds the scope; a clear under a wildcard keeps the rest the wildcard covered', () => {
    expect(toggleScope(['*:read'], 'sources:intake', true, known)).toEqual(['*:read', 'sources:intake']);
    expect(toggleScope(['*:read'], 'jobs:read', true, known)).toEqual(['*:read']);
    expect(toggleScope(['*:read', 'sources:intake'], 'sources:intake', false, known)).toEqual(['*:read']);
    expect(toggleScope(['*:read', 'sources:intake'], 'jobs:read', false, known)).toEqual(['sources:read', 'sources:intake']);
    expect(toggleScope(['*'], 'jobs:approve', false, known)).toEqual(['jobs:cancel', 'jobs:read', 'sources:intake', 'sources:read']);
  });

  it('an action\'s box is ticked by its route\'s; a clear of one action keeps the others (issue #909)', () => {
    expect(scopeTicked(['sources:intake'], 'sources:intake.approve')).toBe(true);
    expect(scopeTicked(['sources:intake.approve'], 'sources:intake')).toBe(false);
    expect(toggleScope(['*:read'], 'sources:intake.approve', true, known)).toEqual(['*:read', 'sources:intake.approve']);
    expect(toggleScope(['sources:intake.approve'], 'sources:intake', true, known)).toEqual(['sources:intake']);
    expect(toggleScope(['sources:intake'], 'sources:intake.assign', false, known)).toEqual(['sources:intake.approve']);
    expect(toggleScope(['sources:intake', 'sources:intake.approve'], 'sources:intake', false, known)).toEqual([]);
    expect(boxPermissions(['sources:intake'], registry).map((p) => p.scope)).toEqual(['sources:intake']);
    expect(boxPermissions(['sources:intake.approve'], registry).map((p) => p.scope)).toEqual(['sources:intake.approve']);
  });

  it('a ticked box action makes it a box grant, and a preset is named while its scopes stand as they are', () => {
    expect(boxPermissions(['*:read'], registry)).toEqual([]);
    expect(boxPermissions(['*:read', 'sources:intake'], registry).map((p) => p.scope)).toEqual(['sources:intake']);
    expect(presetOfScopes(['sources:intake', '*:read'], registry)).toBe('agent-intake');
    expect(presetOfScopes(['*:read', 'jobs:cancel'], registry)).toBeUndefined();
  });

  it('a device grant request\'s line says what it asks for and who asked; a link holds its user code (issue #892)', () => {
    const v = { userCode: 'BCDF-GHJK', ask: { label: 'Grok Bot', preset: 'agent-intake' }, from: '203.0.113.5', createdAt: '2026-10-16T10:00:00Z', expiresAt: '2026-10-16T10:10:00Z' };
    const line = deviceAskLine(v, 'operator', registry);
    expect(line).toMatch(/^operator \(your role\) · box · preset agent-intake · lives 90 days at most · asked from 203\.0\.113\.5 · request ends /);
    expect(deviceAskLine({ ...v, ask: { label: 'x', role: 'viewer', scopes: ['*:read'], days: null } }, 'admin')).toMatch(/^viewer · scopes \*:read · no fixed end · /);
    expect(deviceAskLine({ ...v, ask: { label: 'x', role: 'viewer', scopes: ['*:read'], jkt: 'k'.repeat(43) } }, 'admin')).toMatch(/^viewer · bound to the asking agent's key · scopes /);
    expect(deviceAskLine({ ...v, ask: { label: 'x', role: 'viewer', scopes: ['*:read'], limits: { repos: ['acme/app'] } } }, 'admin')).toMatch(/^viewer · scopes \*:read · only acme\/app · /);
    expect(deviceCodeOfHash('#users-access/api-tokens/BCDF-GHJK')).toBe('BCDF-GHJK');
    expect(deviceCodeOfHash('#users-access/api-tokens')).toBe('');
  });

  it('the limits a person types: repositories and job sources, by commas or spaces (issue #892)', () => {
    expect(typedLimits('acme/app, acme/api  acme/x', '')).toEqual({ repos: ['acme/app', 'acme/api', 'acme/x'] });
    expect(typedLimits('', 'github,manual')).toEqual({ sources: ['github', 'manual'] });
    expect(typedLimits(' ', ' , ')).toBeUndefined();
  });
});
