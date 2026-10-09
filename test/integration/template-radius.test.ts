// Issue #584, through the real composition root and the real HTTP server, with OpenFGA as a double at the
// AuthorizationServer seam. A template's operation profiles and its credential scope feed its blast radius; a
// high-radius profile (write, sync, apply) needs its own explicit approval at the vault's gate, which writes the access
// approval; an approval for read does not approve write; a widening rates the template again and opens the gate again.
// The rating and its reasons show next to the template on Settings → Vault and Settings → Access.
//
// Feature: template scope and high-radius profiles feed blast radius
//   Scenario: a template with only a read profile is rated low
//     Given the template kube declares read on cluster x
//     When an admin approves kube
//     Then kube is rated low on Settings → Vault and on Settings → Access
//     And a read check for kube on cluster x is allowed
//   Scenario: adding a write profile raises the rating, and the gate asks for an explicit approval
//     Given kube is approved for read on cluster x
//     When an admin adds write on cluster x to kube
//     Then kube is rated high, with the write profile as the reason, waiting for approval
//     And approving the template again does not approve the write
//     And a write check is denied
//     When an admin approves write on cluster x for kube, explicitly
//     Then a write check is allowed
//   Scenario: a revoke in Settings → Access opens the gate again; narrowing or removing a template revokes
//   Scenario: a profile the model cannot hold, or an explicit approval of a profile kube does not declare, is refused
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessDecisionRecord, AccessView, OperationProfile, TemplateView } from '../../src/domain/types.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const CLUSTER_X = { kind: 'cluster', name: 'x' } as const;
const READ: OperationProfile = { operation: 'read', asset: CLUSTER_X };
const WRITE: OperationProfile = { operation: 'write', asset: CLUSTER_X };

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY }, plugins: { machines: lanes(1) }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  apps.push(a);
  return { a, token: await a.login() };
}

const vault = (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<{ templates: TemplateView[] }>('/ui/api/vault', body, { token });
const save = (a: TestApp, token: string, profiles: OperationProfile[], secrets: string[] = []) =>
  vault(a, token, { action: 'save-template', name: 'kube', image: IMAGE, secrets, profiles });
const vaultTemplate = async (a: TestApp, token: string): Promise<TemplateView> =>
  ((await a.api<{ templates: TemplateView[] }>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates).find((t) => t.name === 'kube')!;
const access = async (a: TestApp, token: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body;
const accessTemplate = async (a: TestApp, token: string) => (await access(a, token)).templates.find((t) => t.template === 'kube');
const check = async (a: TestApp, token: string, operation: string) =>
  (await a.ui<AccessDecisionRecord>('/ui/api/access', { action: 'check', template: 'kube', operation, asset: CLUSTER_X }, { token })).body;

describe('template scope and high-radius profiles feed blast radius (issue #584)', () => {
  it('a template with only a read profile is rated low; adding a write profile raises it, and the gate asks for an explicit approval before a write check is allowed', async () => {
    const { a, token } = await boot();
    expect((await save(a, token, [READ])).status).toBe(200);
    expect(await vaultTemplate(a, token)).toMatchObject({ profiles: [READ], pending: { profiles: [READ] }, radius: { level: 'low', profiles: [{ profile: READ, level: 'low', approved: false }] } });
    expect((await check(a, token, 'read')).allowed).toBe(false);

    expect((await vault(a, token, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect(await vaultTemplate(a, token)).toMatchObject({ pending: { profiles: [] }, radius: { level: 'low', reasons: ['read on cluster x: read only'] } });
    expect(await accessTemplate(a, token)).toMatchObject({ radius: { level: 'low', reasons: ['read on cluster x: read only'] }, approvals: [{ profile: READ }] });
    expect((await check(a, token, 'read')).allowed).toBe(true);

    // The widening: write on the same asset.
    expect((await save(a, token, [READ, WRITE])).status).toBe(200);
    const widened = await vaultTemplate(a, token);
    expect(widened).toMatchObject({ pending: { profiles: [WRITE] }, radius: { level: 'high', reasons: ['write on cluster x: it changes the asset; waits for an explicit approval'] } });
    expect(await accessTemplate(a, token)).toMatchObject({ radius: { level: 'high', profiles: [{ profile: READ, approved: true }, { profile: WRITE, level: 'high', approved: false }] } });

    // Approving the template again approves what is low; an approval for read does not approve write.
    expect((await vault(a, token, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await vaultTemplate(a, token)).pending.profiles).toEqual([WRITE]);
    expect((await check(a, token, 'write')).allowed).toBe(false);

    expect((await vault(a, token, { action: 'approve-profile', name: 'kube', ...WRITE })).status).toBe(200);
    expect((await vaultTemplate(a, token)).pending.profiles).toEqual([]);
    expect((await vaultTemplate(a, token)).radius.reasons).toEqual(['write on cluster x: it changes the asset; approved']);
    expect((await check(a, token, 'write')).allowed).toBe(true);
    const types = (await a.events()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['template.saved', 'vault.approved', 'template.profile_approved']));
  });

  it('a vault secret in the scope counts in the rating', async () => {
    const { a, token } = await boot();
    await vault(a, token, { action: 'set', name: 'KUBE_TOKEN', scope: 'lab cluster', value: 'KUBE_TOKEN-value-0123456789' });
    await save(a, token, [READ], ['KUBE_TOKEN']);
    expect((await vaultTemplate(a, token)).radius).toMatchObject({ level: 'medium', reasons: ['vault secret KUBE_TOKEN (lab cluster): what it reaches is not discovered; counted as write'] });
    expect((await accessTemplate(a, token))!.radius.level).toBe('medium');
  });

  it('a revoke in Settings → Access opens the gate again; narrowing or removing the template revokes its approvals', async () => {
    const { a, token } = await boot();
    await save(a, token, [READ, WRITE]);
    await vault(a, token, { action: 'approve-template', name: 'kube' });
    await vault(a, token, { action: 'approve-profile', name: 'kube', ...WRITE });
    const write = (await accessTemplate(a, token))!.approvals.find((x) => x.profile.operation === 'write')!;
    expect((await a.ui('/ui/api/access', { action: 'revoke', approval: write.id }, { token })).status).toBe(200);
    expect((await vaultTemplate(a, token)).pending.profiles).toEqual([WRITE]);
    expect((await check(a, token, 'write')).allowed).toBe(false);

    await vault(a, token, { action: 'approve-profile', name: 'kube', ...WRITE });
    expect((await check(a, token, 'write')).allowed).toBe(true);
    await save(a, token, [READ]);
    expect((await check(a, token, 'write')).allowed).toBe(false);
    expect((await accessTemplate(a, token))!.approvals.map((x) => x.profile)).toEqual([READ]);

    expect((await vault(a, token, { action: 'remove-template', name: 'kube' })).status).toBe(200);
    expect((await check(a, token, 'read')).allowed).toBe(false);
    expect(await accessTemplate(a, token)).toBeUndefined();
  });

  it('a profile the model cannot hold, or an explicit approval of a profile the template does not declare, is refused', async () => {
    const { a, token } = await boot();
    expect((await save(a, token, [{ operation: 'read', asset: { kind: 'cluster', name: 'a b' } }])).status).toBe(400);
    expect((await save(a, token, [{ operation: 'delete', asset: CLUSTER_X } as unknown as OperationProfile])).status).toBe(400);
    await save(a, token, [READ]);
    expect((await vault(a, token, { action: 'approve-profile', name: 'kube', ...WRITE })).status).toBe(404);
    expect((await vault(a, token, { action: 'approve-profile', name: 'none', ...READ })).status).toBe(404);
    // A save that names no profiles keeps the ones declared.
    await vault(a, token, { action: 'save-template', name: 'kube', image: IMAGE, secrets: [] });
    expect((await vaultTemplate(a, token)).profiles).toEqual([READ]);
  });
});
