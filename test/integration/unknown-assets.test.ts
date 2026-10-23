// Issue #2067: a need on a cluster the vault cannot find. The real daemon, the real operator CLI; the container runtime
// and OpenFGA are doubles at their ports.
//
// Feature: an unknown asset
//   Scenario: a request for an unknown cluster is refused at once, with the known clusters
//     Given the topology lists the EKS clusters staging-eks and central-eks
//     When the operator asks for a template of read/cluster/stage
//     Then the answer is "no cluster stage; known: staging-eks, central-eks", with the needs to ask for
//     And no template is saved, so nothing waits
//     When the operator asks for read/cluster/staging-eks
//     Then the template is saved
//   Scenario: a template saved before with an unknown asset shows "unknown asset" in hopper template list
//   Scenario: a template of a short cluster name (issue #2168) is no unknown asset, and says the cluster it resolves to
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { TopologySource } from '../../src/domain/topology.ts';
import type { TemplateView } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const AT = '2026-10-19T00:00:00.000Z';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) },
    seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: createFakeContainerRuntime() },
  });
  const source: TopologySource = {
    key: 'aws/111111111111/us-east-1', source: { kind: 'aws', account: '111111111111', region: 'us-east-1' }, reporter: 'topology discovery', lastRead: { at: AT, ok: true },
    lastGood: { at: AT, links: [], nodes: ['staging-eks', 'central-eks'].map((name) => ({ id: `arn:aws:eks:us-east-1:111111111111:cluster/${name}`, kind: 'cluster' as const, name })) },
  };
  t.user().store.topology.put(source);
  return t;
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const templates = async (a: TestApp) => JSON.parse((await hopper(a, ['template', 'list'])).out) as (TemplateView & { unknownAsset?: string })[];

describe('an unknown asset (issue #2067)', () => {
  it('a request for an unknown cluster is refused at once with the known clusters, and nothing waits', async () => {
    const a = await boot();
    const r = await hopper(a, ['template', 'request', '--needs', 'read/cluster/stage']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('no cluster stage; known: staging-eks, central-eks');
    expect(r.err).toContain('--needs "read/cluster/staging-eks"');
    expect(await templates(a)).toEqual([]);

    expect((await hopper(a, ['template', 'request', '--needs', 'read/cluster/staging-eks'])).code).toBe(0);
    expect((await templates(a)).map((x) => x.profiles)).toEqual([[{ operation: 'read', asset: { kind: 'cluster', name: 'staging-eks' } }]]);
  });

  it('a template saved before with an unknown asset shows unknown asset in hopper template list', async () => {
    const a = await boot();
    expect((await hopper(a, ['template', 'save', 'old', '--image', IMAGE, '--profile', 'read/cluster/pipeline'])).code).toBe(0);
    const [old] = await templates(a);
    expect(old!.unknownAsset).toBe('unknown asset: no cluster pipeline; known: staging-eks, central-eks');
    expect(old!.unknownAssets).toEqual([{ asset: { kind: 'cluster', name: 'pipeline' }, cluster: 'pipeline', known: ['staging-eks', 'central-eks'] }]);
  });

  it('a template of a short cluster name is no unknown asset, and names the cluster it resolves to (issue #2168)', async () => {
    const a = await boot();
    expect((await hopper(a, ['template', 'save', 'short', '--image', IMAGE, '--profile', 'read/cluster/staging'])).code).toBe(0);
    const [short] = await templates(a);
    expect(short!.unknownAssets).toBeUndefined();
    expect(short!.shortClusters).toEqual([{ cluster: 'staging', to: 'staging-eks' }]);
  });
});
