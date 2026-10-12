// Issue #909: an agent approves what waits with its grant's API token, but a high-risk infra plan and a write, sync or
// apply profile need a person. For an API token the hopper does not approve such an item: it records the ask
// (`approval.confirmation_asked`, which the webhook subscriptions and notifiers that take it send on), answers 202 with
// what waits, and shows the ask on the item. A person approves it in the UI, and that is the confirmation
// (design.md "A person confirms what an agent asks"). Real daemon, real HTTP server; OpenFGA is a double at its seam.
//
// Feature: a person confirms a high-risk approval that an agent asks for
//   Background:
//     Given a grant for Grok Bot with infra-plans:edit and vault:edit.approve-profile, as a box grant
//   Scenario: the agent approves a low-risk plan at once
//   Scenario: the agent asks to approve a high-risk plan: nothing is approved, a person is asked once, Infra shows the ask,
//     and the person's approval confirms it
//   Scenario: the agent asks to approve an apply profile: nothing is approved, a person is asked, the vault shows the ask,
//     and the person's approval confirms it; a read profile the agent approves at once
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { rawRequest } from '../support/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };

async function agent(a: TestApp, path: string, token: string, body: unknown): Promise<Answer> {
  const r = await rawRequest(a.url, { method: 'POST', path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined };
}

const ACCOUNT = '123456789012';
const ROLE = { kind: 'aws-role', name: `${ACCOUNT}/deploy` } as const;
const COMMIT = 'a'.repeat(40);
/** `terraform show -json` of a plan that adds one security group rule, or destroys a database. */
const tfJson = (address: string, type: string, actions: string[]) => JSON.stringify({
  format_version: '1.2', planned_values: {}, resource_changes: [{
    address, mode: 'managed', type, provider_name: 'registry.terraform.io/hashicorp/aws',
    change: { actions, before: actions.includes('create') ? null : { name: 'a' }, after: actions.includes('delete') ? null : { name: 'a', tags_all: { 'map-migrated': 'migXWT2TUR4TJ' } }, after_unknown: {} },
  }],
});

async function boot(): Promise<{ a: TestApp; session: string; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  const a = t;
  const session = await a.login();
  await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session });
  const r = await a.ui<{ token: string }>('/ui/api/api-tokens', {
    action: 'mint', label: 'Grok Bot', holder: 'grok-bot', scopes: ['*:read', 'infra-plans:edit', 'vault:edit.approve-profile'], box: true,
  }, { token: session });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { a, session, token: r.body.token };
}

function record(a: TestApp, target: string, json: string): string {
  const plan = a.user().githubProxy.infraPlans.record({ id: 'job-1' } as Job, {
    tool: 'terraform', asset: ROLE, target, repo: 'octo/infra', ref: 'issue-1', commit: COMMIT, text: 'Plan: 1 to change.', json,
  });
  if ('no' in plan) throw new Error(plan.no);
  return plan.id;
}

const asks = (a: TestApp) => a.user().store.events.recent(50, ['approval.confirmation_asked']);

describe('a person confirms a high-risk approval an agent asks for (issue #909)', () => {
  it('the agent approves a low-risk plan at once', async () => {
    const { a, token } = await boot();
    const id = record(a, 'uat-network', tfJson('aws_security_group.a', 'aws_security_group', ['create']));
    const r = await agent(a, '/ui/api/infra-plans', token, { action: 'approve', plan: id });
    expect(r.status, r.text).toBe(200);
    expect(r.body.plan.approval).toMatchObject({ plan: id });
    expect(asks(a)).toEqual([]);
  });

  it('the agent asks to approve a high-risk plan; a person confirms it', async () => {
    const { a, session, token } = await boot();
    const id = record(a, 'prod-db', tfJson('aws_db_instance.prod', 'aws_db_instance', ['delete']));
    const r = await agent(a, '/ui/api/infra-plans', token, { action: 'approve', plan: id });
    expect(r.status, r.text).toBe(202);
    expect(r.body.waiting).toMatch(/^a person confirms this: approve plan .* for prod-db \(high risk\)/);
    expect(a.user().githubProxy.infraPlans.approval(id)).toBeUndefined();
    // Asked again at once: still waiting, and the person is not asked twice.
    expect((await agent(a, '/ui/api/infra-plans', token, { action: 'approve', plan: id })).status).toBe(202);
    const asked = asks(a);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ jobId: 'job-1', data: { kind: 'infra-plan', ref: id, plan: id, asker: 'Grok Bot' } });

    const listed = await a.api('GET', '/api/infra-plans', undefined, { 'x-hopper-session': session });
    expect(listed.body.plans[0]).toMatchObject({ id, asked: { asker: 'Grok Bot', at: asked[0]!.at } });

    // The person's approval, through the UI session, is the confirmation.
    const confirmed = await a.ui<{ plan: { approval: { by: string } } }>('/ui/api/infra-plans', { action: 'approve', plan: id }, { token: session });
    expect(confirmed.status).toBe(200);
    expect(a.user().githubProxy.infraPlans.approval(id)).toBeDefined();
    // Approved: the agent's ask is no longer shown, and a new one is the ordinary 409.
    const after = await a.api('GET', '/api/infra-plans', undefined, { 'x-hopper-session': session });
    expect(after.body.plans[0].asked).toBeUndefined();
    expect((await agent(a, '/ui/api/infra-plans', token, { action: 'approve', plan: id })).status).toBe(409);
    // Not found stays not found.
    expect((await agent(a, '/ui/api/infra-plans', token, { action: 'approve', plan: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('the agent asks to approve an apply profile; a person confirms it; a read profile it approves at once', async () => {
    const { a, session, token } = await boot();
    const edit = async (body: Record<string, unknown>) => expect((await a.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
    await edit({ action: 'save-template', name: 'deploy', image: 'localhost/box-terraform:1', secrets: [], profiles: [{ operation: 'read', asset: ROLE }, { operation: 'apply', asset: ROLE }] });
    const pending = async () => (await a.api('GET', '/api/vault', undefined, { 'x-hopper-session': session })).body;

    const read = await agent(a, '/ui/api/vault', token, { action: 'approve-profile', name: 'deploy', operation: 'read', asset: ROLE });
    expect(read.status, read.text).toBe(200);

    const apply = await agent(a, '/ui/api/vault', token, { action: 'approve-profile', name: 'deploy', operation: 'apply', asset: ROLE });
    expect(apply.status, apply.text).toBe(202);
    expect(apply.body.waiting).toMatch(/^a person confirms this: approve apply on aws-role 123456789012\/deploy for template deploy/);
    let vault = await pending();
    expect(vault.templates[0].pending.profiles).toEqual([{ operation: 'apply', asset: ROLE }]);
    expect(vault.asks).toEqual([{ template: 'deploy', operation: 'apply', asset: ROLE, asker: 'Grok Bot', at: expect.any(String) }]);
    expect(asks(a)[0]).toMatchObject({ data: { kind: 'vault-profile', ref: 'deploy:apply/aws-role/123456789012/deploy', template: 'deploy', operation: 'apply', asset: ROLE, asker: 'Grok Bot' } });

    await edit({ action: 'approve-profile', name: 'deploy', operation: 'apply', asset: ROLE });
    vault = await pending();
    expect(vault.templates[0].pending.profiles).toEqual([]);
    expect(vault.asks).toBeUndefined();
    // A profile the template does not declare: the vault's own 404, no ask.
    expect((await agent(a, '/ui/api/vault', token, { action: 'approve-profile', name: 'deploy', operation: 'write', asset: ROLE })).status).toBe(404);
    expect(asks(a)).toHaveLength(1);
  });
});
