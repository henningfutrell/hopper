// Issue #854, through the real composition root, the real HTTP server, the real operator CLI and the real minting
// adapters (STS and the Kubernetes API faked on loopback): a cluster minting credential that signs in through EKS, and
// a mint test of a cluster. The hopper mints a token for the cluster, as for a job, and asks the cluster who it is and
// which namespaces it sees: `kubectl auth whoami` and `kubectl get ns`.
//
// Feature: a cluster signs in through EKS, and a mint test shows who the token is in the cluster
//   Scenario: an eks credential mints a token from the role's read session; the mint test answers who it is
//     Given the minting credential AWS_LAB for aws-account/123456789012, with the session name p2zapwin
//     And the minting credential EKS_UTILITY for cluster/utility: EKS sign-in with the role eks-view
//     When the operator runs `hopper vault mint-test cluster/utility`
//     Then STS gets one AssumeRole on the role eks-view: 900 s, the ReadOnlyAccess policy and the session name p2zapwin
//     And the cluster gets an EKS token (k8s-aws-v1.) for `whoami` and `get ns`, and nothing else
//     And the answer is the cluster's user and groups, its namespaces, the role and the session name; never a key
//   Scenario: the eks credential takes the cluster from a vault kubeconfig with EKS exec sign-in
//   Scenario: with the vault in a container of its own (issue #586), the vault mints and asks the cluster
//   Scenario: a token credential mints a TokenRequest token, and the test asks the cluster with it
//   Scenario: the cluster forbids the token: the test says why
//   Scenario: no AWS minting credential for the role's account, or no cluster minting credential: refused
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { fakeKubeApi, fakeSts, KUBE_NAMESPACES, KUBE_USER, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from '../support/fake-mint-apis.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { KEY } from '../support/webhooks.ts';

const ACCOUNT = '123456789012';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/eks-view`;
const MINTING_SECRET = 'minting-secret-key-fedcba-never-shown';
const KUBE_MINTING_TOKEN = 'kube-minting-token-never-shown';
const CA = Buffer.from('-----BEGIN CERTIFICATE-----\nutility\n-----END CERTIFICATE-----\n').toString('base64');

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
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
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

interface Boot { container?: boolean; forbid?: boolean; aws?: boolean; eks?: (kube: string) => Record<string, unknown>; secrets?: (kube: string) => Record<string, string> }

async function boot(o: Boot = {}): Promise<{ a: TestApp; sts: FakeApi; kube: FakeApi }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const sts = await fakeSts(ACCOUNT);
  const kube = await fakeKubeApi(o.forbid ? { forbid: true } : {});
  cleanups.push(sts.close, kube.close);
  const vault = o.container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
  if (vault) cleanups.push(() => { void vault.stop(); });
  const keys = vault ? { secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_VAULT_KEY: VAULT_KEY }, env: { HOPPER_VAULT_URL: vault.url } } : { secrets: { HOPPER_MASTER_KEY: KEY } };
  t = await startTestApp({ dbPath: db.dbPath, ...keys, plugins: { machines: lanes(1) }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  const session = await t.login();
  const set = async (body: Record<string, unknown>) => { expect((await t!.ui('/ui/api/vault', { action: 'set', ...body }, { token: session })).status).toBe(200); };
  if (o.aws !== false) {
    await set({ name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: MINTING_SECRET, Region: 'us-east-1', Endpoint: sts.url, SessionName: 'p2zapwin' }) });
  }
  for (const [name, value] of Object.entries(o.secrets?.(kube.url) ?? {})) await set({ name, value });
  const eks = o.eks?.(kube.url) ?? { type: 'eks', roleArn: ROLE, cluster: 'utility', region: 'eu-west-1', server: kube.url, certificateAuthorityData: CA };
  await set({ name: 'EKS_UTILITY', mints: { kind: 'cluster', name: 'utility' }, value: JSON.stringify(eks) });
  return { a: t, sts, kube };
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

/** No key — a minting credential's, the minted session's, or a minted token — in what the CLI printed, the events or the log. */
function noKeyAnywhere(a: TestApp, printed: string, kube: FakeApi): void {
  const tokens = kube.seen.map((s) => (s.authorization ?? '').replace(/^Bearer /, '')).filter(Boolean);
  const everything = [printed, JSON.stringify(a.user().store.events.since(0, 100_000)), logged.join('\n')].join('\n');
  for (const secret of [MINTING_SECRET, KUBE_MINTING_TOKEN, MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN, ...tokens]) expect(everything).not.toContain(secret);
}

/** The presigned STS URL inside each EKS token the cluster got. */
const eksUrls = (kube: FakeApi): URL[] => kube.seen.map((s) => {
  const token = (s.authorization ?? '').replace(/^Bearer /, '');
  expect(token.startsWith('k8s-aws-v1.')).toBe(true);
  return new URL(Buffer.from(token.slice('k8s-aws-v1.'.length), 'base64url').toString('utf8'));
});

const testedEvents = (a: TestApp) => a.user().store.events.since(0, 100_000).filter((e) => e.type === 'vault.mint_tested');

const ASKED = [
  { method: 'POST', url: '/apis/authentication.k8s.io/v1/selfsubjectreviews' },
  { method: 'GET', url: '/api/v1/namespaces' },
];

describe('a cluster that signs in through EKS, and its mint test (issue #854)', () => {
  it('mints an EKS token from the role\'s read session; the test answers who the token is and the namespaces it sees', async () => {
    const { a, sts, kube } = await boot();
    const r = await hopper(a, ['vault', 'mint-test', 'cluster/utility']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const answer = JSON.parse(r.out) as Record<string, unknown>;
    expect(answer).toEqual({
      kind: 'kube', asset: { kind: 'cluster', name: 'utility' }, credential: 'EKS_UTILITY', server: kube.url, expiresAt: expect.any(String),
      roleArn: ROLE, account: '123456789012', sessionName: 'p2zapwin', user: KUBE_USER, namespaces: KUBE_NAMESPACES,
    });
    expect(Date.parse(answer.expiresAt as string) - Date.now()).toBeLessThanOrEqual(14 * 60_000);

    expect(sts.seen).toHaveLength(1);
    const assume = new URLSearchParams(sts.seen[0]!.body);
    expect(assume.get('Action')).toBe('AssumeRole');
    expect(assume.get('RoleArn')).toBe(ROLE);
    expect(assume.get('RoleSessionName')).toBe('p2zapwin');
    expect(assume.get('DurationSeconds')).toBe('900');
    expect(assume.get('PolicyArns.member.1.arn')).toBe('arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect(sts.seen[0]!.authorization).toContain('Credential=AKIAMINTING/');

    expect(kube.seen.map(({ method, url }) => ({ method, url }))).toEqual(ASKED);
    for (const url of eksUrls(kube)) {
      expect(url.origin).toBe('https://sts.eu-west-1.amazonaws.com');
      expect(url.searchParams.get('Action')).toBe('GetCallerIdentity');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(new RegExp(`^${MINTED_AWS.AccessKeyId}/\\d{8}/eu-west-1/sts/aws4_request$`));
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;x-k8s-aws-id');
      expect(url.searchParams.get('X-Amz-Security-Token')).toBe(MINTED_AWS.SessionToken);
    }
    expect(testedEvents(a)).toEqual([expect.objectContaining({
      data: expect.objectContaining({ asset: { kind: 'cluster', name: 'utility' }, credential: 'EKS_UTILITY', sessionName: 'p2zapwin', user: KUBE_USER.username }),
    })]);
    noKeyAnywhere(a, r.out, kube);
  });

  it('takes the cluster, its server and CA from a vault kubeconfig with EKS exec sign-in', async () => {
    const kubeconfig = (server: string) => [
      'apiVersion: v1', 'kind: Config', 'current-context: utility',
      `clusters: [{ name: utility, cluster: { server: '${server}', certificate-authority-data: ${CA} } }]`,
      'contexts: [{ name: utility, context: { cluster: utility, user: utility } }]',
      'users: [{ name: utility, user: { exec: { apiVersion: client.authentication.k8s.io/v1beta1, command: aws, args: [--region, eu-west-1, eks, get-token, --cluster-name, utility] } } }]',
    ].join('\n');
    const { a, kube } = await boot({ secrets: (url) => ({ 'kube-config': kubeconfig(url) }), eks: () => ({ type: 'eks', roleArn: ROLE, kubeconfig: 'kube-config' }) });
    const r = await hopper(a, ['vault', 'mint-test', 'cluster/utility']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ server: kube.url, user: KUBE_USER });
    expect(eksUrls(kube).map((u) => u.origin)).toEqual(['https://sts.eu-west-1.amazonaws.com', 'https://sts.eu-west-1.amazonaws.com']);
    noKeyAnywhere(a, r.out, kube);
  });

  it('with the vault in a container of its own, the vault mints and asks the cluster', async () => {
    const { a, sts, kube } = await boot({ container: true });
    const r = await hopper(a, ['vault', 'mint-test', 'cluster/utility']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ kind: 'kube', sessionName: 'p2zapwin', user: KUBE_USER, namespaces: KUBE_NAMESPACES });
    expect(sts.seen).toHaveLength(1);
    expect(kube.seen.map(({ method, url }) => ({ method, url }))).toEqual(ASKED);
    noKeyAnywhere(a, r.out, kube);
  });

  it('tests a token credential too: a TokenRequest token for hopper-read, then whoami and get ns with it', async () => {
    const { a, sts, kube } = await boot({ aws: false, eks: (url) => ({ server: url, token: KUBE_MINTING_TOKEN }) });
    const r = await hopper(a, ['vault', 'mint-test', 'cluster/utility']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({
      kind: 'kube', asset: { kind: 'cluster', name: 'utility' }, credential: 'EKS_UTILITY', server: kube.url, expiresAt: '2030-01-01T00:10:00.000Z', user: KUBE_USER, namespaces: KUBE_NAMESPACES,
    });
    expect(kube.seen.map(({ method, url, authorization }) => ({ method, url, authorization }))).toEqual([
      { method: 'POST', url: '/api/v1/namespaces/hopper/serviceaccounts/hopper-read/token', authorization: `Bearer ${KUBE_MINTING_TOKEN}` },
      ...ASKED.map((x) => ({ ...x, authorization: `Bearer ${MINTED_KUBE_TOKEN}` })),
    ]);
    expect(sts.seen).toEqual([]);
  });

  it('says why when the cluster forbids the token', async () => {
    const { a, kube } = await boot({ forbid: true });
    const r = await hopper(a, ['vault', 'mint-test', 'cluster/utility']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/the Kubernetes API answered 403: namespaces is forbidden/);
    expect(testedEvents(a)).toEqual([expect.objectContaining({ data: expect.objectContaining({ credential: 'EKS_UTILITY', reason: expect.stringMatching(/403/) }) })]);
    noKeyAnywhere(a, r.err, kube);
  });

  it('refuses when no AWS minting credential mints for the role\'s account, or none mints for the cluster', async () => {
    const { a, sts, kube } = await boot({ aws: false });
    const noAws = await hopper(a, ['vault', 'mint-test', 'cluster/utility']);
    expect(noAws.code).toBe(2);
    expect(noAws.err).toMatch(/EKS sign-in assumes arn:aws:iam::123456789012:role\/eks-view: no minting credential mints for aws-account 123456789012/);
    const noCluster = await hopper(a, ['vault', 'mint-test', 'cluster/prod']);
    expect(noCluster.err).toMatch(/no minting credential mints for cluster prod/);
    const namespace = await hopper(a, ['vault', 'mint-test', 'namespace/utility/shop']);
    expect(namespace.err).toMatch(/aws-role\/<account>\/<role> or cluster\/<name>/);
    expect(sts.seen).toEqual([]);
    expect(kube.seen).toEqual([]);
  });
});
