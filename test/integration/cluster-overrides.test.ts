// Issue #1766 part 2, through the real composition root, the real HTTP server, the real operator CLI and the real minting
// adapters (STS, EKS and the Kubernetes API faked on loopback): a cluster override, the config record `clusters`, names
// how the vault finds a cluster that has no minting credential of its own. No vault secret names the cluster.
//
// Feature: cluster overrides are config, not vault secrets
//   Scenario: an alias finds the cluster by its EKS name, in the region it names; the mint test says what it used
//     Given only the AWS minting credential AWS_LAB for aws-account/123456789012, with an EKS endpoint
//     And the override lab-view: EKS name utility, region eu-west-1, saved with POST /ui/api/clusters
//     When the operator runs `hopper vault mint-test cluster/lab-view`
//     Then STS gets one AssumeRole on hopper-read, and EKS one DescribeCluster of utility in eu-west-1
//     And the answer names the account, the role hopper-read and the credential AWS_LAB; never a key
//   Scenario: an override that is not one is refused, by the route and by `hopper config set`; a stale version conflicts
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { ClustersView } from '../../src/domain/clusters.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { fakeKubeApi, fakeSts, KUBE_NAMESPACES, KUBE_USER, MINTED_AWS, type FakeApi } from '../support/fake-mint-apis.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const ACCOUNT = '123456789012';
const MINTING_SECRET = 'minting-secret-key-overrides-never-shown';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

/** EKS on loopback: DescribeCluster answers `utility` at the Kubernetes API double, and ResourceNotFoundException for any other name. */
async function fakeEks(server: string): Promise<{ url: string; seen: { path: string; authorization: string }[] }> {
  const seen: { path: string; authorization: string }[] = [];
  const s = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization ?? '' });
    const send = (status: number, body: unknown, type?: string) => res.writeHead(status, { 'content-type': 'application/json', ...(type ? { 'x-amzn-errortype': type } : {}) }).end(JSON.stringify(body));
    if (req.url === '/clusters/utility') return send(200, { cluster: { name: 'utility', endpoint: server, certificateAuthority: { data: 'Q0E=' } } });
    return send(404, { message: 'No cluster found.' }, 'ResourceNotFoundException');
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  cleanups.push(() => { s.close(); s.closeAllConnections(); });
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

async function boot(): Promise<{ a: TestApp; session: string; sts: FakeApi; kube: FakeApi; eks: Awaited<ReturnType<typeof fakeEks>> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const sts = await fakeSts(ACCOUNT);
  const kube = await fakeKubeApi();
  cleanups.push(sts.close, kube.close);
  const eks = await fakeEks(kube.url);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  const session = await t.login();
  const value = JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: MINTING_SECRET, Region: 'us-east-1', Endpoint: sts.url, EksEndpoint: eks.url, SessionName: 'p2zapwin' });
  expect((await t.ui('/ui/api/vault', { action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value }, { token: session })).status).toBe(200);
  return { a: t, session, sts, kube, eks };
}

async function hopper(a: TestApp, argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => stdin, out: (x) => out.push(x), err: (x) => err.push(x) };
  // config writes the database; only the operator actions on the daemon take --url.
  const code = await runCli(argv[0] === 'config' ? argv : [...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const saveClusters = async (a: TestApp, session: string, clusters: unknown[], version?: string) => {
  const at = version ?? (await a.api<ClustersView>('GET', '/api/clusters', undefined, { 'x-hopper-session': session })).body.version;
  return a.ui<ClustersView>('/ui/api/clusters', { clusters, version: at }, { token: session });
};

describe('cluster overrides (issue #1766)', () => {
  it('finds an aliased cluster by its EKS name in the region it names, and the mint test says the account, the role and the credential', async () => {
    const { a, session, sts, kube, eks } = await boot();
    const saved = await saveClusters(a, session, [{ name: 'lab-view', eksName: 'utility', region: 'eu-west-1' }]);
    expect(saved.status).toBe(200);
    expect(saved.body.clusters).toEqual([{ name: 'lab-view', eksName: 'utility', region: 'eu-west-1' }]);

    const r = await hopper(a, ['vault', 'mint-test', 'cluster/lab-view']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({
      kind: 'kube', asset: { kind: 'cluster', name: 'lab-view' }, credential: 'AWS_LAB', server: kube.url, expiresAt: expect.any(String),
      roleArn: `arn:aws:iam::${ACCOUNT}:role/hopper-read`, account: ACCOUNT, sessionName: 'p2zapwin', user: KUBE_USER, namespaces: KUBE_NAMESPACES,
      region: 'eu-west-1', searched: [{ account: ACCOUNT, regions: ['eu-west-1'] }],
    });
    expect(sts.seen).toHaveLength(1);
    expect(new URLSearchParams(sts.seen[0]!.body).get('RoleArn')).toBe(`arn:aws:iam::${ACCOUNT}:role/hopper-read`);
    expect(eks.seen.map((s) => s.path)).toEqual(['/clusters/utility']);
    expect(eks.seen[0]!.authorization).toContain(`Credential=${MINTED_AWS.AccessKeyId}/`);
    expect(eks.seen[0]!.authorization).toContain('/eu-west-1/eks/aws4_request');
    expect(JSON.stringify([r.out, a.user().store.events.since(0, 100_000)])).not.toContain(MINTING_SECRET);
    // No vault secret names the cluster.
    expect(a.user().store.vault.list().map((s) => s.name)).toEqual(['AWS_LAB']);
  });

  it('refuses an override that is not one, by the route and by hopper config set, and an edit against a version that moved', async () => {
    const { a, session } = await boot();
    const bad = await saveClusters(a, session, [{ name: 'utility', writeRole: `arn:aws:iam::${ACCOUNT}:role/edit` }]);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('writeRole is an IAM role name');
    expect((await saveClusters(a, session, [{ name: 'utility', writeRole: 'hopper-identity-edit' }], 'missing')).status).toBe(200);
    expect((await saveClusters(a, session, [], 'missing')).status).toBe(409);

    const version = (await hopper(a, ['config', 'version', 'clusters'])).out.trim();
    const cli = await hopper(a, ['config', 'set', 'clusters', '--if-version', version], JSON.stringify({ clusters: [{ name: 'utility', account: '12' }] }));
    expect(cli.code).not.toBe(0);
    expect(cli.err).toContain('clusters refused, nothing written: cluster utility: account is an AWS account id, 12 digits');
    expect((await hopper(a, ['config', 'get', 'clusters'])).out).toContain('hopper-identity-edit');
  });
});
