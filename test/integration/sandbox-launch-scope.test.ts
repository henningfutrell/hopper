// Issue #708, through the real composition root, the real HTTP server and a real joined client: a box the hopper
// launches gets only what its launch named. The launch's `secrets` are a subset of the template's approved scope, and
// its `profile` is one of the template's operation profiles; the sandbox record keeps both, and the vault gives that
// box's jobs nothing outside them, whatever the template gives (design.md "Sandbox boxes the hopper launches"). The
// container runtime is a double at its port; the box joins with the join line the hopper put in its environment, as
// its client does.
//
// Feature: a launched box gets only what its launch named
//   Scenario: a box launched with some of the template's secrets is given those, and refused the others
//     Given the vault secrets KUBE_TOKEN and AWS_KEY, the approved template kube that gives both
//     And a box launched from kube with the secrets KUBE_TOKEN, joined, a job running on it
//     When the job runs `$HOPPER_SECRET get KUBE_TOKEN`, then `$HOPPER_SECRET get AWS_KEY`
//     Then it gets KUBE_TOKEN
//     And AWS_KEY is refused: the box was launched with KUBE_TOKEN only; the refusal is recorded without a value
//   Scenario: a box launched with no secrets named is given every secret the template gave at launch
//   Scenario: with the vault in a container of its own (issue #586), the launch narrows the delivery just the same
//   Scenario: a box launched for one operation profile is minted only that profile; Access is not asked for another
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { AccessView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const KUBE = 'kube-token-0123456789abcdef-launch-scope';
const AWS = 'aws-key-fedcba9876543210-launch-scope';
const MINTED = 'minted-token-launch-scope';
const ACCOUNT = '123456789012';
const WEB = { kind: 'namespace', name: 'lab/web' };
const ROLE = { kind: 'aws-role', name: `${ACCOUNT}/diag` };
const HERDR = new URL('../herdr/fake-herdr-bin.mjs', import.meta.url).pathname;

let t: TestApp | undefined;
const box = boxes();
const clients: Client[] = [];
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
  for (const c of clients.splice(0)) await c.stop();
  await box.end();
  await t?.stop();
  t = undefined;
  for (const s of stops.splice(0)) await s();
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** A Kubernetes API server that answers every TokenRequest, and keeps each one. */
async function fakeKube(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '');
    req.resume();
    req.on('end', () => res.writeHead(201, { 'content-type': 'application/json' })
      .end(JSON.stringify({ kind: 'TokenRequest', apiVersion: 'authentication.k8s.io/v1', status: { token: MINTED, expirationTimestamp: '2030-01-01T00:10:00Z' } })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** `container`: the vault in a container of its own (issue #586). `access`: Access with an OpenFGA double, for mints. */
async function boot(o: { container?: boolean; access?: boolean } = {}): Promise<{ a: TestApp; session: string; runtime: FakeContainerRuntime }> {
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
    seams: { containerRuntime: runtime, startCheckMs: 1000, ...(o.access ? { authorizationServer: createFakeAuthorizationServer() } : {}) },
  });
  const session = await t.login();
  return { a: t, session, runtime };
}

const edit = async (a: TestApp, session: string, body: Record<string, unknown>): Promise<void> => {
  const r = await a.ui<{ error?: string }>('/ui/api/vault', body, { token: session });
  expect(r.status, r.body.error).toBe(200);
};

/** The template kube, giving KUBE_TOKEN and AWS_KEY, approved. */
async function kubeTemplate(a: TestApp, session: string): Promise<void> {
  await edit(a, session, { action: 'set', name: 'KUBE_TOKEN', value: KUBE });
  await edit(a, session, { action: 'set', name: 'AWS_KEY', value: AWS });
  await edit(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN', 'AWS_KEY'] });
  await edit(a, session, { action: 'approve-template', name: 'kube' });
}

/** Launch a box of kube with `params`; its client joins with the line the hopper gave it and runs. Its client dir. */
async function launched(a: TestApp, session: string, runtime: FakeContainerRuntime, params: Record<string, unknown>): Promise<string> {
  const r = await a.ui<{ container: string; error?: string }>('/ui/api/machines/sandbox', { template: 'kube', params }, { token: session });
  expect(r.status, r.body.error).toBe(200);
  const name = r.body.container;
  const { HOPPER_JOIN: line, HOPPER_CLIENT_NAME: client } = runtime.boxes.get(name)!.spec.env;
  const dir = box.temp('hopper-box-');
  await joinHopper({ line: line!, name: client!, dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
  return dir;
}

/** Nothing the hopper logged or appended carries `value`, and nothing in the box's client dir does. */
function nowhere(a: TestApp, dir: string, value: string): void {
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
  for (const f of readdirSync(dir)) if (f !== 'vault.sock') expect(readFileSync(join(dir, f), 'utf8')).not.toContain(value);
}

describe('a launched box gets only what its launch named', () => {
  for (const container of [false, true]) {
    it(`a box launched with some of the template's secrets is given those and refused the others${container ? ', with the vault in a container of its own' : ''}`, async () => {
      const { a, session, runtime } = await boot({ container });
      await kubeTemplate(a, session);
      const dir = await launched(a, session, runtime, { secrets: ['KUBE_TOKEN'] });
      const job = await runningJob(a, 'hopper-sandbox-kube');
      const token = box.tokenFileOf(a, job);

      expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: KUBE });
      const refused = await helper(dir, ['get', 'AWS_KEY'], token);
      expect(refused.code).not.toBe(0);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/hopper-sandbox-kube was launched with KUBE_TOKEN only: AWS_KEY is not given to it/);
      expect((await a.events()).find((e) => e.type === 'vault.refused')).toMatchObject({
        machineId: 'hopper-sandbox-kube', data: { name: 'AWS_KEY', template: 'kube', machine: 'hopper-sandbox-kube', job, reason: expect.stringMatching(/launched with KUBE_TOKEN only/) },
      });
      nowhere(a, dir, AWS);
    });
  }

  it('a box launched with no secrets named is given every secret the template gave at launch', async () => {
    const { a, session, runtime } = await boot();
    await kubeTemplate(a, session);
    const dir = await launched(a, session, runtime, {});
    const token = box.tokenFileOf(a, await runningJob(a, 'hopper-sandbox-kube'));
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: KUBE });
    expect(await helper(dir, ['get', 'AWS_KEY'], token)).toMatchObject({ code: 0, stdout: AWS });
  });

  it('a box launched for one operation profile is minted only that profile; Access is not asked for another', async () => {
    const { a, session, runtime } = await boot({ access: true });
    const kube = await fakeKube();
    await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session });
    await edit(a, session, { action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: kube.url, token: 'minting-token-launch-scope' }) });
    await edit(a, session, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: [], profiles: [{ operation: 'read', asset: WEB }, { operation: 'read', asset: ROLE }] });
    await edit(a, session, { action: 'approve-template', name: 'kube' });
    const dir = await launched(a, session, runtime, { profile: 'read/namespace/lab/web' });
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const token = box.tokenFileOf(a, job);

    const other = await helper(dir, ['aws', 'read', `aws-role/${ACCOUNT}/diag`], token);
    expect(other.code).not.toBe(0);
    expect(other.stdout).toBe('');
    expect(other.stderr).toMatch(/hopper-sandbox-kube was launched for read on namespace lab\/web only/);
    const refused = (await a.events()).find((e) => e.type === 'vault.mint_refused');
    expect(refused).toMatchObject({ jobId: job, data: { mint: { operation: 'read', asset: ROLE }, template: 'kube' } });
    expect((refused!.data as { decision?: string }).decision).toBeUndefined();
    const decisions = async () => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body.decisions;
    expect((await decisions()).filter((d) => d.asset.kind === 'aws-role')).toEqual([]);

    const minted = await helper(dir, ['kube', 'read', 'namespace/lab/web'], token);
    expect(minted.code, minted.stderr).toBe(0);
    expect(JSON.parse(minted.stdout)).toMatchObject({ status: { token: MINTED } });
    expect(kube.seen).toHaveLength(1);
  });
});
