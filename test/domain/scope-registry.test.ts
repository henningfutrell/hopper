// The scope registry (issue #909, src/domain/scope-registry.ts), pure: every route's scope in a section with its plain
// description, routes, least role and box flag; an area no section names under Other; the presets and their box flag.
// Against the real API reference too: every route has a scope a section names, and every preset names real scopes.
import { describe, expect, it } from 'vitest';
import { presetOf, scopeRegistry, SCOPE_SECTIONS, type RegistryRoute } from '../../src/domain/scope-registry.ts';
import { scopeAllows } from '../../src/domain/token-scopes.ts';
import { registryRoutes } from '../../src/http/scopes.ts';
import { isBoxAction } from '../../src/http/ui/box-actions.ts';

const routes: RegistryRoute[] = [
  { method: 'get', path: '/api/sources', summary: 'Job sources and their sync status' },
  { method: 'post', path: '/ui/api/sources/:name/intake', summary: 'Approve a request', role: 'operator' },
  { method: 'get', path: '/api/jobs', summary: 'List jobs' },
  { method: 'get', path: '/api/jobs/:id', summary: 'One job' },
  { method: 'post', path: '/ui/api/jobs/:id/cancel', summary: 'Cancel a job', role: 'operator' },
  { method: 'post', path: '/ui/api/jobs/:id/grant-vault', summary: 'Grant a job the vault', role: 'operator' },
  { method: 'post', path: '/ui/api/brand-new/thing', summary: 'Something new', role: 'admin' },
  { method: 'post', path: '/ui/auth/token/refresh', summary: 'Refresh' },
  { method: 'post', path: '/ui/api/vault', summary: 'Edit the vault', role: 'admin', actions: { field: 'action', values: ['approve-template', 'set'] } },
];
const box = (route: string) => route === '/ui/api/sources/:name/intake';

describe('the scope registry', () => {
  const registry = scopeRegistry(routes, box);
  const permission = (scope: string) => registry.sections.flatMap((s) => s.permissions).find((p) => p.scope === scope);

  it('each scope once, with its routes, its routes\' summaries, the least role and the box flag', () => {
    expect(permission('jobs:read')).toEqual({ scope: 'jobs:read', description: 'List jobs; One job', routes: ['GET /api/jobs', 'GET /api/jobs/:id'], role: 'viewer', box: false });
    expect(permission('sources:intake')).toEqual({ scope: 'sources:intake', description: 'Approve a request', routes: ['POST /ui/api/sources/:name/intake'], role: 'operator', box: true });
  });

  it('puts each scope in its area\'s section, a vault grant under the vault, and a new area under Other', () => {
    const of = (id: string) => registry.sections.find((s) => s.id === id)?.permissions.map((p) => p.scope);
    expect(of('intake')).toEqual(['sources:intake', 'sources:read']);
    expect(of('jobs')).toEqual(['jobs:cancel', 'jobs:read']);
    expect(of('other')).toEqual(['brand-new:thing']);
    expect(registry.sections.map((s) => s.id)).toEqual(['jobs', 'intake', 'vault', 'other']);
  });

  it('a route that does one of several actions has a scope for each, under its own (issue #909)', () => {
    expect(registry.sections.find((s) => s.id === 'vault')?.permissions.map((p) => p.scope)).toEqual(['jobs:grant-vault', 'vault:edit', 'vault:edit.approve-template', 'vault:edit.set']);
    expect(permission('vault:edit.approve-template')).toEqual({
      scope: 'vault:edit.approve-template', description: 'Approve template (Edit the vault)', routes: ['POST /ui/api/vault (action: approve-template)'], role: 'admin', parent: 'vault:edit', box: false,
    });
    expect(permission('vault:edit')).not.toHaveProperty('parent');
  });

  it('a route with no scope is in no section', () => {
    expect(registry.sections.flatMap((s) => s.permissions).flatMap((p) => p.routes)).not.toContain('POST /ui/auth/token/refresh');
  });

  it('a preset is a box grant when its scopes cover a box action', () => {
    expect(presetOf(registry, 'read-only')).toMatchObject({ scopes: ['*:read'], box: false });
    expect(presetOf(registry, 'agent-intake')).toMatchObject({ scopes: ['*:read', 'sources:intake'], box: true });
    expect(presetOf(registry, 'full-admin')).toMatchObject({ scopes: ['*'], box: true });
    expect(presetOf(registry, 'nope')).toBeUndefined();
  });
});

describe('the registry of the API reference', () => {
  const registry = scopeRegistry(registryRoutes(), isBoxAction);
  const all = registry.sections.flatMap((s) => s.permissions);

  it('names every area in a section of its own: none is left under Other', () => {
    expect(registry.sections.find((s) => s.id === 'other')?.permissions.map((p) => p.scope) ?? []).toEqual([]);
    expect(SCOPE_SECTIONS.flatMap((s) => s.areas).length).toBe(new Set(SCOPE_SECTIONS.flatMap((s) => s.areas)).size);
  });

  it('gives every approval a scope a grant may hold', () => {
    const scopes = all.map((p) => p.scope);
    for (const s of ['sources:intake', 'jobs:approve', 'jobs:grant-vault', 'infra-plans:edit', 'vault:edit', 'questions:answer', 'pull-requests:merge'])
      expect(scopes).toContain(s);
    expect(all.find((p) => p.scope === 'sources:intake')).toMatchObject({ box: true, role: 'operator' });
  });

  it('gives each action of an approval route a scope of its own (issue #909)', () => {
    const scopes = all.map((p) => p.scope);
    for (const s of ['sources:intake.approve', 'sources:intake.assign', 'vault:edit.approve-template', 'vault:edit.give-credential', 'vault:edit.decline-credential', 'vault:edit.set'])
      expect(scopes).toContain(s);
    expect(all.find((p) => p.scope === 'sources:intake.approve')).toMatchObject({ parent: 'sources:intake', box: true, role: 'operator' });
  });

  it('every preset names real scopes, and agent-intake reads every route the Needs you list reads', () => {
    for (const p of registry.presets) for (const s of p.scopes) expect(all.some((q) => scopeAllows([s], q.scope)), `${p.id}: ${s}`).toBe(true);
    const intake = presetOf(registry, 'agent-intake')!;
    for (const read of ['sources:read', 'vault:read', 'queue:read', 'sections:read', 'scopes:read']) expect(scopeAllows(intake.scopes, read)).toBe(true);
    expect(intake.box).toBe(true);
    expect(presetOf(registry, 'agent-approvals')!.scopes).not.toContain('infra-plans:edit');
  });
});
