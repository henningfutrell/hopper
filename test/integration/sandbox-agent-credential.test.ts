// Issue #708 (part 10: inherited sign-in), through the real composition root and the real HTTP server: a box of an
// approved template starts with its agent already signed in. The template names one of its secrets as its agent
// credential, a long-lived Claude token (`claude setup-token`); a launch whose scope holds it gets it in the box's
// environment as CLAUDE_CODE_OAUTH_TOKEN, which the box's herdr and every job pane in it inherit. The sign-in in the box
// (`/login`, kept in its home volume) is the fallback, not the default. The container runtime is a double at its port.
//
// Feature: a launched box's agent is signed in from the vault
//   Scenario: a box of an approved template that names an agent credential starts signed in
//     Given the vault secret CLAUDE, a Claude token, and the approved template kube with CLAUDE as its agent credential
//     When a box of kube is launched
//     Then the box's environment holds CLAUDE_CODE_OAUTH_TOKEN, the token
//     And its sandbox record names the agent credential, never the token
//     And the vault records that it gave it, never the token; no log line holds it
//   Scenario: a launch that leaves the agent credential out of its secrets starts a box that is not signed in
//   Scenario: an agent credential not approved yet refuses the launch, and nothing is made
//   Scenario: a value that is not a Claude token refuses the launch, and nothing is made
//   Scenario: with the vault in a container of its own (issue #586), the box starts signed in just the same
//   Scenario: the template keeps its agent credential through a save that does not name one, and loses it on null
//   Scenario: an agent credential that is not one of the template's secrets, or a shared secret, is refused
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxesView } from '../../src/domain/machines.ts';
import type { VaultView } from '../../src/domain/vault.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { KEY } from '../support/webhooks.ts';

const TOKEN = 'sk-ant-oat01-agent-credential-0123456789abcdef_never-in-a-log';
const KUBE = 'kube-token-0123456789abcdef-agent-credential';

let t: TestApp | undefined;
const stops: (() => Promise<void>)[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const s of stops.splice(0)) await s();
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** `container`: the vault in a container of its own (issue #586). */
async function boot(o: { container?: boolean } = {}): Promise<{ a: TestApp; session: string; runtime: FakeContainerRuntime }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const vault = o.container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
  if (vault) stops.push(() => vault.stop());
  const keys = vault ? { secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_VAULT_KEY: VAULT_KEY }, env: { HOPPER_VAULT_URL: vault.url } } : { secrets: { HOPPER_MASTER_KEY: KEY } };
  const runtime = createFakeContainerRuntime();
  t = await startTestApp({
    dbPath: db.dbPath, ...keys,
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { containerRuntime: runtime, startCheckMs: 1000 },
  });
  return { a: t, session: await t.login(), runtime };
}

const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<VaultView & { error?: string }>('/ui/api/vault', body, { token: session });
const ok = async (a: TestApp, session: string, body: Record<string, unknown>): Promise<VaultView> => {
  const r = await edit(a, session, body);
  expect(r.status, r.body.error).toBe(200);
  return r.body;
};
const launch = (a: TestApp, session: string, params: Record<string, unknown> = {}) =>
  a.ui<{ container: string; error?: string }>('/ui/api/machines/sandbox', { template: 'kube', params }, { token: session });

/** The template kube, giving KUBE_TOKEN and CLAUDE, with CLAUDE (holding `value`) as its agent credential; approved unless `approve` is false. */
async function kubeTemplate(a: TestApp, session: string, o: { value?: string; approve?: boolean } = {}): Promise<void> {
  await ok(a, session, { action: 'set', name: 'KUBE_TOKEN', value: KUBE });
  await ok(a, session, { action: 'set', name: 'CLAUDE', value: o.value ?? TOKEN });
  await ok(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN', 'CLAUDE'], agentCredential: 'CLAUDE' });
  if (o.approve !== false) await ok(a, session, { action: 'approve-template', name: 'kube' });
}

/** Nothing the hopper logged, appended or answered in its sandbox view carries the token. */
async function nowhere(a: TestApp, session: string): Promise<void> {
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(TOKEN);
  expect(logged.join('\n')).not.toContain(TOKEN);
  expect(JSON.stringify((await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body)).not.toContain(TOKEN);
}

describe('a launched box\'s agent is signed in from the vault', () => {
  for (const container of [false, true]) {
    it(`a box of an approved template that names an agent credential starts signed in${container ? ', with the vault in a container of its own' : ''}`, async () => {
      const { a, session, runtime } = await boot({ container });
      await kubeTemplate(a, session);
      const r = await launch(a, session);
      expect(r.status, r.body.error).toBe(200);

      expect(runtime.boxes.get(r.body.container)!.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      const view = (await a.api<SandboxesView>('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body;
      expect(view.boxes.find((b) => b.name === r.body.container)).toMatchObject({ agentCredential: 'CLAUDE' });
      expect((await a.events()).find((e) => e.type === 'vault.agent_credential_given')).toMatchObject({
        machineId: r.body.container, data: { name: 'CLAUDE', template: 'kube', box: r.body.container },
      });
      await nowhere(a, session);
    });
  }

  it('a launch that leaves the agent credential out of its secrets starts a box that is not signed in', async () => {
    const { a, session, runtime } = await boot();
    await kubeTemplate(a, session);
    const r = await launch(a, session, { secrets: ['KUBE_TOKEN'] });
    expect(r.status, r.body.error).toBe(200);
    expect(runtime.boxes.get(r.body.container)!.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const view = (await a.api<SandboxesView>('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body;
    expect(view.boxes.find((b) => b.name === r.body.container)!.agentCredential).toBeUndefined();
    expect((await a.events()).some((e) => e.type === 'vault.agent_credential_given')).toBe(false);
  });

  it('an agent credential not approved yet refuses the launch, and nothing is made', async () => {
    const { a, session, runtime } = await boot();
    await ok(a, session, { action: 'set', name: 'KUBE_TOKEN', value: KUBE });
    await ok(a, session, { action: 'set', name: 'CLAUDE', value: TOKEN });
    await ok(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN'] });
    await ok(a, session, { action: 'approve-template', name: 'kube' });
    await ok(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN', 'CLAUDE'], agentCredential: 'CLAUDE' });

    const r = await launch(a, session);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/kube is not approved for its agent credential CLAUDE: approve it on Access requests/);
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect(a.app.instance.sandboxes.list()).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.refused')).toMatchObject({ data: { name: 'CLAUDE', template: 'kube' } });
  });

  it('a value that is not a Claude token refuses the launch, and nothing is made', async () => {
    const { a, session, runtime } = await boot();
    const json = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'sk-ant-ort01-y' } });
    await kubeTemplate(a, session, { value: json });
    const r = await launch(a, session);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/CLAUDE is not a Claude token: set it to what `claude setup-token` prints/);
    expect(r.body.error).not.toContain('refreshToken');
    expect(runtime.boxes.size).toBe(0);
    expect(a.app.instance.sandboxes.list()).toEqual([]);
  });

  it('the template keeps its agent credential through a save that does not name one, and loses it on null', async () => {
    const { a, session } = await boot();
    await kubeTemplate(a, session, { approve: false });
    const kube = (v: VaultView) => v.templates.find((x) => x.name === 'kube')!;
    expect(kube(await ok(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:2', secrets: ['KUBE_TOKEN', 'CLAUDE'] })).agentCredential).toBe('CLAUDE');
    expect(kube(await ok(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:2', secrets: ['KUBE_TOKEN'], agentCredential: null })).agentCredential).toBeUndefined();
  });

  it('an agent credential that is not one of the template\'s secrets, or a shared secret, is refused', async () => {
    const { a, session } = await boot();
    await kubeTemplate(a, session, { approve: false });
    const out = await edit(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN'] });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/the agent credential CLAUDE is not one of the template's secrets/);
    const shared = await edit(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN'], agentCredential: 'shared/CLAUDE' });
    expect(shared.status).toBe(400);
    expect(shared.body.error).toMatch(/a shared secret is never an agent credential/);
  });
});
