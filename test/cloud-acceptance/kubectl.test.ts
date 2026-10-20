// Issue #1956 (acceptance criterion 8): kubectl with a token the vault minted, against a real Kubernetes API (kind,
// support/kind.ts). The hopper is the crash harness's (test/crash/harness.ts): the real composition root in a process
// of its own, its need boxes on the real container runtime, under the sandbox flags, from the image the hopper makes for
// the template (the box image with kubectl), on the host's network, where the cluster's API server listens. The minting
// credential is a `token` one: a service account that may only make tokens and the Secrets they are bound to. A need
// step's read token is a TokenRequest token of `hopper-read`, bound to a Secret of its own (issue #1371); the cluster's
// RBAC (the `view` role) decides what it may do, and the step's end deletes the Secret. Not part of `npm test`:
// `npm run test:cloud`.
//
// Feature: a minted read token lists, and nothing more; it stops working when its sandbox ends
//   Scenario: a need step reads the cluster with kubectl
//     Given a job at work whose template reads the cluster, and a minting credential of type token for it
//     When a need step runs kubectl with the token the vault minted for it
//     Then the token is hopper-read's, bound to a Secret of its own, for 10 minutes at most, and the box holds no minting token
//     And it lists pods, and is forbidden to delete a pod, exec in it, create a Secret or read one
//     And the cluster's workload is the same as before
//     When the step's box ended
//     Then the Secret the token was bound to is gone, and the cluster refuses the same token (within its token cache's time)
//     And no need box and no home volume is left at the runtime
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { boxImage } from '../../src/sandbox/box-image.ts';
import { KUBE_CLUSTER_NAMESPACE, KUBE_TOKEN_SECONDS, MINT_BINDING_LABEL } from '../../src/domain/minting.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { startHost, stopHosts, type CrashHost } from '../crash/harness.ts';
import { BOX_BASE, runtime, runtimeSocket } from './support/box.ts';
import { APP_NAMESPACE, READ_ACCOUNT, SEED_POD, SEED_SECRET, startCluster, type Cluster } from './support/kind.ts';
import { leftAtRuntime, removeLeft, step, tarOf } from './support/need-step.ts';

const REPO = 'octo/cluster';
const CLUSTER = 'acceptance';
const TEMPLATE = 'cluster-read-step';
const READ = `read/cluster/${CLUSTER}`;
const TOOLS = ['kubectl'] as const;
/** The most a step takes: the hopper makes the template's image when it is missing. */
const STEP_MS = 300_000;

let cluster: Cluster;
let dir: string;
let world: { github: FakeForge; url: string; cleanup(): void } | undefined;

beforeAll(async () => {
  cluster = await startCluster();
  // The image the hopper makes for the template, built once: a hopper builds it again only when it is missing.
  await boxImage(runtime(), BOX_BASE, TOOLS, undefined);
}, 1_200_000);
afterAll(async () => { await cluster?.end(); });
afterEach(async () => {
  await stopHosts();
  if (world) await removeLeft(world.url);
  await world?.github.close();
  world?.cleanup();
  world = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A fresh database, the fake GitHub with the job's issue, and a hopper with the job at work, the minting credential and the template approved. */
async function setUp(): Promise<CrashHost> {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Read the cluster', body: 'Please.', author: 'owner', labels: [] });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  world = { github, url, cleanup: db.cleanup };
  const h = await startHost({ dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, ...runtimeSocket(), connectGitHub: [REPO], job: `${REPO}#7` });
  const vault = async (body: Record<string, unknown>) => { const r = await h.ui('/ui/api/vault', body); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  await vault({ action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: CLUSTER }, value: JSON.stringify({ type: 'token', server: cluster.server, token: cluster.mintingToken, certificateAuthorityData: cluster.certificateAuthorityData }) });
  await vault({ action: 'save-template', name: TEMPLATE, image: BOX_BASE, tools: TOOLS, secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: CLUSTER } }] });
  await vault({ action: 'approve-template', name: TEMPLATE });
  return h;
}

/** One route of the command: its output between two marks, then its exit code. */
const route = (name: string, command: string): string =>
  `echo "== route ${name}"; ${command} 2>&1; echo "== exit ${name}=$?"`;

function routes(log: string): Map<string, { exit: number; out: string }> {
  const out = new Map<string, { exit: number; out: string }>();
  for (const m of log.matchAll(/^== route (\S+)\r?\n([\s\S]*?)^== exit \1=(\d+)/gm)) out.set(m[1]!, { exit: Number(m[3]), out: m[2]! });
  return out;
}

/** The workload of the namespace `app`, by kind, name and uid: a delete or a create changes it. */
async function workload(): Promise<string> {
  const r = await cluster.admin(['get', 'pods,secrets,configmaps', '-n', APP_NAMESPACE, '-o', 'jsonpath={range .items[*]}{.kind}/{.metadata.name}/{.metadata.uid}{"\\n"}{end}']);
  expect(r.code, r.stderr).toBe(0);
  return r.stdout.split('\n').filter(Boolean).sort().join('\n');
}

/** The Secrets the hopper bound tokens to, in the namespace `hopper`. */
async function bindings(): Promise<string[]> {
  const r = await cluster.admin(['get', 'secrets', '-n', KUBE_CLUSTER_NAMESPACE, '-l', MINT_BINDING_LABEL, '-o', 'name']);
  expect(r.code, r.stderr).toBe(0);
  return r.stdout.split('\n').filter(Boolean);
}

/** The claims of a service account token (a JWT). */
const claimsOf = (token: string): { sub: string; iat: number; exp: number; 'kubernetes.io'?: { secret?: { name: string; uid: string } } } =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as ReturnType<typeof claimsOf>;

describe('kubectl in a need box with a minted read token, against a kind cluster (issue #1956, criterion 8)', () => {
  it('lists but cannot delete, exec or create secrets; the bound token stops working when the step ends', async () => {
    const h = await setUp();
    dir = mkdtempSync(join(tmpdir(), 'hopper-acceptance-kubectl-'));
    const before = await workload();
    expect(before).toMatch(new RegExp(`^Pod/${SEED_POD}/`, 'm'));
    expect(await bindings()).toEqual([]);

    const command = [
      route('whoami', 'kubectl auth whoami -o jsonpath="{.status.userInfo.username}"; echo'),
      route('list', `kubectl get pods -n ${APP_NAMESPACE} -o name`),
      route('delete', `kubectl delete pod ${SEED_POD} -n ${APP_NAMESPACE} --wait=false`),
      route('exec', `kubectl exec ${SEED_POD} -n ${APP_NAMESPACE} -- true`),
      route('create-secret', `kubectl create secret generic planted-by-step -n ${APP_NAMESPACE} --from-literal=k=v`),
      route('read-secret', `kubectl get secret ${SEED_SECRET} -n ${APP_NAMESPACE} -o name`),
      route('bound', `kubectl get secrets -n ${KUBE_CLUSTER_NAMESPACE} -o name`),
      route('environment', 'env | sort; cat "$KUBECONFIG"; echo'),
      'kubectl config view --raw -o jsonpath="{.users[0].user.token}" > token',
    ].join('\n');
    const ran = await step(h, { needs: READ, key: 'acceptance-kubectl-0001', command, output: ['token'] }, tarOf(dir, ['.']), STEP_MS);
    expect({ exit: ran.exit, problem: ran.problem }, ran.log).toEqual({ exit: 0, problem: undefined });
    const got = routes(ran.log);
    const of = (k: string) => {
      const v = got.get(k);
      expect(v, `${k}\n${ran.log}`).toBeDefined();
      return v!;
    };
    execFileSync('tar', ['-xf', '-', '-C', dir], { input: ran.outputs });
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();

    // The token: hopper-read's, bound to a Secret of its own, for 10 minutes at most. The box holds no minting token.
    const claims = claimsOf(token);
    expect(claims.sub).toBe(`system:serviceaccount:${KUBE_CLUSTER_NAMESPACE}:${READ_ACCOUNT}`);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(KUBE_TOKEN_SECONDS);
    expect(claims['kubernetes.io']?.secret?.name).toMatch(/^hopper-mint-/);
    expect(of('whoami').exit, of('whoami').out).toBe(0);
    expect(of('whoami').out.trim()).toBe(claims.sub);
    expect(of('environment').exit).toBe(0);
    expect(ran.log).not.toContain(cluster.mintingToken);
    expect(ran.log, 'the log masks the minted token').not.toContain(token);

    // It lists; the cluster forbids every write, the exec and the read of a Secret.
    expect(of('list').exit, of('list').out).toBe(0);
    expect(of('list').out).toContain(`pod/${SEED_POD}`);
    for (const k of ['delete', 'exec', 'create-secret', 'read-secret', 'bound']) {
      expect(of(k).exit, `${k}: ${of(k).out}`).not.toBe(0);
      expect(of(k).out, k).toMatch(/Forbidden|forbidden/);
    }
    expect(await workload()).toBe(before);

    // The step's box ended: the Secret goes, and the cluster refuses the same token.
    await waitFor(async () => ((await bindings()).length === 0 ? true : undefined), { timeoutMs: 60_000, intervalMs: 500, what: 'the binding Secret to be deleted' });
    // The API server keeps a token it authenticated for a short time (its token cache, 10 s by default), so the refusal
    // comes within that time after the Secret goes, not on the same instant.
    const after = await waitFor(async () => {
      const r = await cluster.as(token, ['get', 'pods', '-n', APP_NAMESPACE, '-o', 'name']);
      return r.code === 0 ? undefined : r;
    }, { timeoutMs: 60_000, intervalMs: 1_000, what: 'the cluster to refuse the token' });
    expect(`${after.stdout}${after.stderr}`).toMatch(/Unauthorized/);
    expect(await workload()).toBe(before);

    // The need box and its home volume are burned after the step.
    await waitFor(async () => ((await leftAtRuntime(world!.url)).length === 0 ? true : undefined), { timeoutMs: 60_000, intervalMs: 500, what: 'no need box or home left at the runtime' });
  }, 900_000);
});
