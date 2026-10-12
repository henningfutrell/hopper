// Issue #718, acceptance: an agent with no UI session asks the hopper for the template its work needs, over the API
// with an API token, as a running job does with `sandbox-template` (issue #716, design.md "Templates on request"). The
// hopper writes the template from the needs — the box image, the tools the needs use, no vault secret, one operation
// profile per need — through the same path as a job's request, and approves it with no person only when every need is a
// read inside the user's read policy. A template of read needs only then takes the read-only check (issue #716, item 4)
// before its first box. Real daemon, real HTTP server, real CLI; OpenFGA and the container runtime are doubles at their
// ports, and the runtime's check box runs the check's real script with fake cloud tools under a read-only credential.
//
// Feature: an agent asks the hopper for a template over the API
//   Scenario: read needs inside the read policy are approved with no person, checked read-only, and a box of it launches
//     Given the read policy holds cluster/lab and aws-role/123456789012/*
//     And minting credentials for cluster lab and aws-account 123456789012, so the read-only check box gets its read
//       credentials (issue #797)
//     And an agent holds an API token of the admin
//     When the agent posts `request-template` with the needs "read/cluster/lab read/aws-role/123456789012/readonly"
//     Then the answer is the vault's view, with `request`: the template's name, not ready, waiting for the read-only check
//     And the vault holds the template: the box image, the tools its needs use, no secret, the two read profiles,
//       approved by the read policy
//     And a box of it is refused until the check passed
//     When the check pass runs, and every write is refused while every read works
//     Then the same needs again, in another order, get the same template, ready, with the skills its box loads
//     And the agent launches a box of it with the same token
//   Scenario: a write need waits for a person: the template is saved, nothing of it approved, and no box launches
//   Scenario: needs the hopper cannot read are refused, saying how to write them; a viewer's token is refused for its role
//   Scenario: the operator CLI asks for a template
//   Scenario: the template request on the page (issue #708, part 9): the template the needs would make is shown, and nothing is saved
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import { TOOLS_IMAGE } from '../../src/sandbox/tools.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { fakeKubeApi, fakeSts } from '../support/fake-mint-apis.ts';
import { rawRequest } from '../support/http.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const BOX = 'ghcr.io/henningfutrell/hopper:box-claude';
const LAB_READ = { operation: 'read', asset: { kind: 'cluster', name: 'lab' } } as const;
const LAB_WRITE = { operation: 'write', asset: { kind: 'cluster', name: 'lab' } } as const;
const AWS_READ = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } } as const;

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function boot(policy?: string[]): Promise<{ a: TestApp; runtime: FakeContainerRuntime; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const cloud = createFakeCloudTools('read-only');
  cleanups.push(cloud.cleanup);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = cloud.runScript;
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) },
    seams: { containerRuntime: runtime, authorizationServer: createFakeAuthorizationServer() },
  });
  const session = await t.login();
  if (policy) expect((await t.ui('/ui/api/vault', { action: 'set-read-policy', assets: policy }, { token: session })).status).toBe(200);
  // The read-only check box's read credentials (issue #797): minted from these, against an STS and a Kubernetes API on loopback.
  const kube = await fakeKubeApi();
  const sts = await fakeSts('123456789012');
  cleanups.push(kube.close, sts.close);
  expect((await t.ui('/ui/api/vault', { action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: kube.url, token: 'minting' }) }, { token: session })).status).toBe(200);
  expect((await t.ui('/ui/api/vault', { action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: '123456789012' }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: 'minting', Endpoint: sts.url }) }, { token: session })).status).toBe(200);
  return { a: t, runtime, session };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };

/** A request as an agent sends it: the token in Authorization, JSON, no UI session, no Origin. */
async function agent(a: TestApp, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> {
  const r = await rawRequest(a.url, {
    method, path, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined };
}

async function apiToken(a: TestApp, session: string, role = 'admin', box = false): Promise<string> {
  const r = await a.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'grok-bot', role, box }, { token: session });
  expect(r.status).toBe(200);
  return r.body.token;
}

const asked = async (a: TestApp, token: string): Promise<TemplateView[]> =>
  ((await agent(a, 'GET', '/api/vault', token)).body as VaultView).templates.filter((x) => x.name.startsWith('asked-'));

describe('an agent asks the hopper for a template over the API (issue #718)', () => {
  it('read needs inside the read policy are approved with no person, checked read-only, and a box of it launches', async () => {
    const { a, runtime, session } = await boot(['cluster/lab', 'aws-role/123456789012/*']);
    const token = await apiToken(a, session, 'admin', true);

    const r = await agent(a, 'POST', '/ui/api/vault', token, { action: 'request-template', needs: 'read/cluster/lab read/aws-role/123456789012/readonly' });
    expect(r.status, r.text).toBe(200);
    const [made] = await asked(a, token);
    expect(made).toMatchObject({
      image: BOX, tools: ['aws', 'helm', 'kubectl'], secrets: [], profiles: [LAB_READ, AWS_READ],
      approval: { by: 'the read policy' }, pending: { secrets: [], image: false, profiles: [] },
    });
    expect(made!.readOnly).toBe(true);
    expect(r.body.request).toMatchObject({ template: made!.name, ready: false });
    expect(r.body.request.text).toContain(`waiting: template ${made!.name} is approved; waiting for the read-only check`);
    expect(r.body.templates).toEqual(expect.arrayContaining([expect.objectContaining({ name: made!.name })]));
    const early = await agent(a, 'POST', '/ui/api/machines/sandbox', token, { template: made!.name, params: {} });
    expect(early.status, early.text).toBe(409);

    // The read-only check: every write refused, every read works.
    await a.app.sandboxes.check();
    const [checked] = await asked(a, token);
    expect(checked!.check).toMatchObject({ state: 'passed' });
    expect(checked!.check!.probes.every((p) => p.passed)).toBe(true);

    const again = await agent(a, 'POST', '/ui/api/vault', token, { action: 'request-template', needs: 'read/aws-role/123456789012/readonly, read/cluster/lab' });
    expect(again.body.request).toMatchObject({ template: made!.name, ready: true });
    expect(again.body.request.text).toContain('approved by the read policy');
    expect(again.body.request.text).toContain('sh "$HOPPER_SKILL" kube-diagnostics cluster/lab');
    expect((await asked(a, token)).length).toBe(1);

    const launch = await agent(a, 'POST', '/ui/api/machines/sandbox', token, { template: made!.name, params: {} });
    expect(launch.status, launch.text).toBe(200);
    expect(runtime.boxes.get(launch.body.container as string)?.spec.image).toMatch(new RegExp(`^${TOOLS_IMAGE}:`));
  });

  it('a write need waits for a person: the template is saved, nothing of it approved, and no box launches', async () => {
    const { a, session } = await boot(['cluster/*']);
    const token = await apiToken(a, session, 'admin', true);
    const r = await agent(a, 'POST', '/ui/api/vault', token, { action: 'request-template', needs: 'read/cluster/lab write/cluster/lab' });
    expect(r.status, r.text).toBe(200);
    const [made] = await asked(a, token);
    expect(made).toMatchObject({ profiles: [LAB_READ, LAB_WRITE], pending: { image: true } });
    expect(made!.approval).toBeUndefined();
    expect(r.body.request).toMatchObject({ template: made!.name, ready: false });
    expect(r.body.request.text).toMatch(/^waiting: template asked-[0-9a-f]+ waits for a person in Settings → Vault/);
    expect(r.body.request.text).toContain('write on cluster lab changes the asset');
    expect((await agent(a, 'POST', '/ui/api/machines/sandbox', token, { template: made!.name, params: {} })).status).not.toBe(200);
  });

  it('needs the hopper cannot read are refused, saying how; a viewer\'s token is refused for its role', async () => {
    const { a, session } = await boot(['cluster/*']);
    const token = await apiToken(a, session);
    for (const needs of ['', 'read cluster lab', 'delete/cluster/lab', 'read/planet/mars']) {
      const r = await agent(a, 'POST', '/ui/api/vault', token, { action: 'request-template', needs });
      expect(r.status, `${needs}: ${r.text}`).toBe(400);
      expect(r.text).toContain('read/cluster/NAME');
    }
    expect(await asked(a, token)).toEqual([]);
    const viewer = await apiToken(a, session, 'viewer');
    const refused = await agent(a, 'POST', '/ui/api/vault', viewer, { action: 'request-template', needs: 'read/cluster/lab' });
    expect(refused.status).toBe(403);
    expect(await asked(a, token)).toEqual([]);
  });

  it('the operator CLI asks for a template', async () => {
    const { a } = await boot(['cluster/*']);
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
    const hopper = async (argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await runCli([...argv, '--url', a.url], io);
      return { code, out: out.join(''), err: err.join('') };
    };
    const r = await hopper(['template', 'request', '--needs', 'read/cluster/lab']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ template: expect.stringMatching(/^asked-[0-9a-f]{12}$/), ready: false, text: expect.stringContaining('read-only check') });
    expect(await hopper(['template', 'request'])).toMatchObject({ code: 2, err: expect.stringContaining('--needs') });
  });

  it('the template request on the page: the template the needs would make is shown before it is made, and nothing is saved (issue #708)', async () => {
    const { a, session } = await boot(['cluster/lab']);
    const token = await apiToken(a, session);
    const shown = await agent(a, 'POST', '/ui/api/vault', token, { action: 'preview-template', needs: 'read/cluster/lab' });
    expect(shown.status, shown.text).toBe(200);
    expect(shown.body.preview).toEqual({
      template: expect.stringMatching(/^asked-[0-9a-f]{12}$/), image: BOX, tools: ['helm', 'kubectl'],
      needs: ['read on cluster lab'], readOnly: true, approvedBy: 'the read policy', waits: [],
    });
    const wide = await agent(a, 'POST', '/ui/api/vault', token, { action: 'preview-template', needs: 'read/cluster/lab write/cluster/lab' });
    expect(wide.body.preview).toMatchObject({ approvedBy: 'a person', waits: ['write on cluster lab changes the asset'] });
    expect(await asked(a, token)).toEqual([]);

    const made = await agent(a, 'POST', '/ui/api/vault', token, { action: 'request-template', needs: 'read/cluster/lab' });
    expect(made.body.request.template).toBe(shown.body.preview.template);
    const again = await agent(a, 'POST', '/ui/api/vault', token, { action: 'preview-template', needs: 'read/cluster/lab' });
    expect(again.body.preview).toMatchObject({ template: shown.body.preview.template, exists: 'same' });

    const words = await agent(a, 'POST', '/ui/api/vault', token, { action: 'preview-template', needs: 'kubectl get pods on cluster lab' });
    expect(words.body.preview).toMatchObject({ template: shown.body.preview.template, needs: ['read on cluster lab'], exists: 'same' });
    const vague = await agent(a, 'POST', '/ui/api/vault', token, { action: 'preview-template', needs: 'look at the pods' });
    expect(vague.status).toBe(400);
    expect(vague.text).toContain('names no asset');

    const bad = await agent(a, 'POST', '/ui/api/vault', token, { action: 'preview-template', needs: 'delete/cluster/lab' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('the operation is one of');
    const viewer = await apiToken(a, session, 'viewer');
    expect((await agent(a, 'POST', '/ui/api/vault', viewer, { action: 'preview-template', needs: 'read/cluster/lab' })).status).toBe(403);
  });
});
