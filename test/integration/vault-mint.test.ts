// Issue #580, through the real composition root, the real HTTP server, a real joined client and the real minting
// adapters (an STS and a Kubernetes API server faked on loopback; OpenFGA as a double at its seam): the vault mints a
// short-lived credential for a box's job only after Access (`decideMint`) allows it, at every mint and every renewal.
// The minting credential the hopper mints from never leaves the hopper (design.md "Minting: short-lived credentials").
//
// Feature: the vault mints short-lived credentials only through Access
//   Scenario: a profile the template declares but nobody approved now waits at the first-time gate, and mints nothing
//     Given the minting credentials KUBE_LAB (cluster/lab) and AWS_LAB (aws-account/123456789012)
//     And the template kube, which declares read and write on namespace/lab/web and read on aws-role/123456789012/diag
//     And a job running on a box joined as kube, which takes a job only once kube is approved (issue #602)
//     And the read on namespace/lab/web revoked in Settings → Access while the job runs
//     When the job runs `$HOPPER_SECRET kube read namespace/lab/web`
//     Then it is refused: the profile waits for a person's approval on Settings → Vault
//     And the Kubernetes API is not asked
//   Scenario: once the template is approved, the job gets a short-lived token, and the audit names Access's decision
//     Then the token is a TokenRequest token for the service account hopper-read in namespace web, with its expiry
//     And `vault.minted` carries the id of the allowing decision Settings → Access records
//   Scenario: a write on the same asset is denied and mints nothing
//   Scenario: an AWS role session, read only, through STS
//   Scenario: after a revoke in Settings → Access, the next renewal is denied
//   Scenario: a minting credential is never given out, and a profile the template does not declare is refused
//   Scenario: with the vault in a container of its own (issue #586), Access decides in the hopper and the vault mints
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { HELPER_FILE } from '../../src/client/vault.ts';
import type { AccessView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const KUBE_MINTING_TOKEN = 'minting-token-0123456789-never-on-the-box';
const AWS_MINTING_SECRET = 'minting-secret-key-fedcba-never-on-the-box';
const MINTED_TOKEN = 'minted-token-abc';
const EXPIRES = '2030-01-01T00:10:00Z';
const ACCOUNT = '123456789012';
const WEB = { kind: 'namespace', name: 'lab/web' };
const ROLE = { kind: 'aws-role', name: `${ACCOUNT}/diag` };

let t: TestApp | undefined;
const clients: Client[] = [];
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
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

interface Seen { method: string; url: string; authorization?: string; body: string }

/** A loopback server answering `answer` and keeping every request it got. */
async function fakeServer(answer: (r: Seen) => { status: number; type: string; body: string }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      const r: Seen = { method: req.method ?? '', url: req.url ?? '', body, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) };
      seen.push(r);
      const a = answer(r);
      res.writeHead(a.status, { 'content-type': a.type }).end(a.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.close(); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}

/** A Kubernetes API server that answers every TokenRequest. */
const fakeKube = () => fakeServer((r) => {
  const spec = (JSON.parse(r.body || '{}') as { spec?: unknown }).spec;
  return { status: 201, type: 'application/json', body: JSON.stringify({ kind: 'TokenRequest', apiVersion: 'authentication.k8s.io/v1', spec, status: { token: MINTED_TOKEN, expirationTimestamp: EXPIRES } }) };
});

/** STS: AssumeRole answered, in the query protocol's XML. */
const fakeSts = () => fakeServer(() => ({
  status: 200, type: 'text/xml',
  body: `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIAMINTED</AccessKeyId><SecretAccessKey>minted-secret</SecretAccessKey><SessionToken>minted-session</SessionToken><Expiration>${EXPIRES}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::${ACCOUNT}:assumed-role/diag/hopper</Arn><AssumedRoleId>AROA:hopper</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>r1</RequestId></ResponseMetadata></AssumeRoleResponse>`,
}));

/** `container`: the vault in a container of its own (issue #586), holding the master key; the hopper holds none. */
async function boot(o: { container?: boolean } = {}): Promise<{ a: TestApp; session: string; kube: Awaited<ReturnType<typeof fakeKube>>; sts: Awaited<ReturnType<typeof fakeSts>> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const kube = await fakeKube();
  const sts = await fakeSts();
  const vault = o.container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
  if (vault) cleanups.push(() => { void vault.stop(); });
  const keys = vault ? { secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_VAULT_KEY: VAULT_KEY }, env: { HOPPER_VAULT_URL: vault.url } } : { secrets: { HOPPER_MASTER_KEY: KEY } };
  t = await startTestApp({
    dbPath: db.dbPath, ...keys,
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const session = await t.login();
  // The write profile rates kube high, and so its boxes (issue #605); the blast-radius gate is not under test here.
  await t.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session });
  const edit = async (body: Record<string, unknown>) => expect((await t!.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
  await edit({ action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: kube.url, token: KUBE_MINTING_TOKEN }) });
  await edit({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: AWS_MINTING_SECRET, Region: 'us-east-1', Endpoint: sts.url }) });
  await edit({
    action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: [],
    profiles: [{ operation: 'read', asset: WEB }, { operation: 'write', asset: WEB }, { operation: 'read', asset: ROLE }],
  });
  return { a: t, session, kube, sts };
}

/** A box of `kube` joined and its client started, and a job running on it: the client dir and the job's token file. */
async function boxWithJob(a: TestApp, session: string): Promise<{ dir: string; job: string; token: string }> {
  const dir = temp('hopper-machine-');
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', { template: 'kube' }, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name: 'hopper-sandbox-kube', dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'hopper-sandbox-kube' && m.online), { timeoutMs: 10000, what: 'the box online' });
  const job = (await a.pull({ op: 'sleep', ms: 60000 })).id;
  expect((await a.waitForStatus(job, 'running', 10000)).laneId).toBe('hopper-sandbox-kube/lane-1');
  const token = join(temp('job-credentials-'), 'token');
  writeFileSync(token, `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
  return { dir, job, token };
}

/** The helper, run as a job runs it: its token file, and nothing of the vault in its environment. */
function helper(dir: string, args: string[], tokenFile: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(join(dir, HELPER_FILE), args, { env: { PATH: process.env.PATH, HOPPER_TOKEN_FILE: tokenFile }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const accessOf = async (a: TestApp, session: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body;

/** Nothing the hopper logged or appended carries the minting credentials, and nothing in the box's client dir does. */
function mintingCredentialsNowhere(a: TestApp, dir: string): void {
  const everything = [JSON.stringify(a.user().store.events.since(0, 100_000)), logged.join('\n'), ...readdirSync(dir).filter((f) => f !== 'vault.sock').map((f) => readFileSync(join(dir, f), 'utf8'))];
  for (const text of everything) {
    expect(text).not.toContain(KUBE_MINTING_TOKEN);
    expect(text).not.toContain(AWS_MINTING_SECRET);
  }
}

describe('the vault mints short-lived credentials only through Access', () => {
  it('waits at the first-time gate until approved; then mints a short-lived token, the audit naming Access\'s decision; a write mints nothing', async () => {
    const { a, session, kube } = await boot();
    // A box of a template not approved takes no job (issue #602): approve, then revoke the read while the job runs.
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const { dir, job, token } = await boxWithJob(a, session);
    const read = (await accessOf(a, session)).templates.find((x) => x.template === 'kube')!.approvals.find((p) => p.profile.operation === 'read' && p.profile.asset.kind === 'namespace')!;
    expect((await a.ui('/ui/api/access', { action: 'revoke', approval: read.id }, { token: session })).status).toBe(200);

    const gated = await helper(dir, ['kube', 'read', 'namespace/lab/web'], token);
    expect(gated.code).not.toBe(0);
    expect(gated.stdout).toBe('');
    expect(gated.stderr).toMatch(/waits for a person's approval on Settings → Vault/);
    expect(kube.seen).toHaveLength(0);
    const refused = (await a.events()).find((e) => e.type === 'vault.mint_refused');
    expect(refused).toMatchObject({ jobId: job, data: { mint: { operation: 'read', asset: WEB }, template: 'kube', decision: expect.any(String) } });

    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const minted = await helper(dir, ['kube', 'read', 'namespace/lab/web'], token);
    expect(minted.code).toBe(0);
    expect(JSON.parse(minted.stdout)).toEqual({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: MINTED_TOKEN, expirationTimestamp: EXPIRES } });
    expect(kube.seen).toHaveLength(1);
    expect(kube.seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/namespaces/web/serviceaccounts/hopper-read/token', authorization: `Bearer ${KUBE_MINTING_TOKEN}` });
    expect(JSON.parse(kube.seen[0]!.body)).toMatchObject({ kind: 'TokenRequest', spec: { expirationSeconds: 600 } });

    const event = (await a.events()).find((e) => e.type === 'vault.minted');
    expect(event).toMatchObject({ jobId: job, machineId: 'hopper-sandbox-kube', data: { kind: 'kube', operation: 'read', asset: WEB, template: 'kube', job, expiresAt: EXPIRES, renewal: false } });
    const decision = (await accessOf(a, session)).decisions.find((d) => d.id === (event!.data as { decision: string }).decision);
    expect(decision).toMatchObject({ allowed: true, template: 'kube', operation: 'read', asset: WEB, requester: { kind: 'job', jobId: job } });

    const write = await helper(dir, ['kube', 'write', 'namespace/lab/web'], token);
    expect(write.code).not.toBe(0);
    expect(write.stderr).toMatch(/not approved to write on namespace lab\/web/);
    expect(kube.seen).toHaveLength(1);
    mintingCredentialsNowhere(a, dir);
  });

  it('mints a read-only AWS role session through STS; after a revoke in Settings → Access the next renewal is denied', async () => {
    const { a, session, sts } = await boot();
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const { dir, token } = await boxWithJob(a, session);

    const first = await helper(dir, ['aws', 'read', `aws-role/${ACCOUNT}/diag`], token);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ Version: 1, AccessKeyId: 'ASIAMINTED', SecretAccessKey: 'minted-secret', SessionToken: 'minted-session', Expiration: '2030-01-01T00:10:00.000Z' });
    const asked = new URLSearchParams(sts.seen[0]!.body);
    expect(asked.get('Action')).toBe('AssumeRole');
    expect(asked.get('RoleArn')).toBe(`arn:aws:iam::${ACCOUNT}:role/diag`);
    expect(asked.get('DurationSeconds')).toBe('900');
    expect(asked.get('PolicyArns.member.1.arn')).toBe('arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect(sts.seen[0]!.authorization).toContain('Credential=AKIAMINTING/');

    expect((await helper(dir, ['aws', 'read', `aws-role/${ACCOUNT}/diag`], token)).code).toBe(0);
    const renewals = (await a.events()).filter((e) => e.type === 'vault.minted').map((e) => (e.data as { renewal: boolean }).renewal);
    expect(renewals).toEqual([false, true]);

    const approval = (await accessOf(a, session)).templates.find((x) => x.template === 'kube')!.approvals.find((p) => p.profile.asset.kind === 'aws-role')!;
    expect((await a.ui('/ui/api/access', { action: 'revoke', approval: approval.id }, { token: session })).status).toBe(200);
    const revoked = await helper(dir, ['aws', 'read', `aws-role/${ACCOUNT}/diag`], token);
    expect(revoked.code).not.toBe(0);
    expect(revoked.stderr).toMatch(/waits for a person's approval/);
    expect(sts.seen).toHaveLength(2);
    mintingCredentialsNowhere(a, dir);
  });

  it('never gives out a minting credential; refuses a profile the template does not declare and an asset no minting credential covers', async () => {
    const { a, session, kube } = await boot();
    const scoped = await a.ui<{ error: string }>('/ui/api/vault', { action: 'save-template', name: 'leaky', image: 'localhost/box:1', secrets: ['KUBE_LAB'] }, { token: session });
    expect(scoped.status).toBe(400);
    expect(scoped.body.error).toMatch(/KUBE_LAB is a minting credential/);
    const secrets = (await a.api('GET', '/api/vault')).body.secrets as { name: string; mints?: unknown }[];
    expect(secrets.find((s) => s.name === 'KUBE_LAB')!.mints).toEqual({ kind: 'cluster', name: 'lab' });

    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const { dir, token } = await boxWithJob(a, session);
    const raw = await helper(dir, ['get', 'KUBE_LAB'], token);
    expect(raw.code).not.toBe(0);
    expect(raw.stderr).toMatch(/minting credential/);

    const undeclared = await helper(dir, ['kube', 'read', 'namespace/lab/other'], token);
    expect(undeclared.code).not.toBe(0);
    expect(undeclared.stderr).toMatch(/kube does not declare read on namespace lab\/other/);
    const wrongKind = await helper(dir, ['aws', 'read', 'namespace/lab/web'], token);
    expect(wrongKind.code).not.toBe(0);
    expect(wrongKind.stderr).toMatch(/an aws credential is minted for an aws-role/);
    expect(kube.seen).toHaveLength(0);
    mintingCredentialsNowhere(a, dir);
  });

  it('with the vault in a container of its own, Access decides in the hopper and the vault mints; a revoke still denies the next', async () => {
    const { a, session, kube } = await boot({ container: true });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const { dir, job, token } = await boxWithJob(a, session);
    const minted = await helper(dir, ['kube', 'read', 'namespace/lab/web'], token);
    expect(minted.code).toBe(0);
    expect(JSON.parse(minted.stdout).status).toEqual({ token: MINTED_TOKEN, expirationTimestamp: EXPIRES });
    expect(kube.seen[0]).toMatchObject({ url: '/api/v1/namespaces/web/serviceaccounts/hopper-read/token', authorization: `Bearer ${KUBE_MINTING_TOKEN}` });
    const event = (await a.events()).find((e) => e.type === 'vault.minted');
    expect(event).toMatchObject({ jobId: job, data: { kind: 'kube', decision: expect.any(String), renewal: false } });

    const approval = (await accessOf(a, session)).templates.find((x) => x.template === 'kube')!.approvals.find((p) => p.profile.operation === 'read' && p.profile.asset.kind === 'namespace')!;
    await a.ui('/ui/api/access', { action: 'revoke', approval: approval.id }, { token: session });
    const revoked = await helper(dir, ['kube', 'read', 'namespace/lab/web'], token);
    expect(revoked.code).not.toBe(0);
    expect(revoked.stderr).toMatch(/waits for a person's approval/);
    expect(kube.seen).toHaveLength(1);
    mintingCredentialsNowhere(a, dir);
  });
});
