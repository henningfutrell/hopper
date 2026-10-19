// Topology discovery (issue #1781 part 3, design.md "The infrastructure topology") under the crash harness (issue #1954):
// a first hopper keeps a minting credential for an AWS account and one for its cluster, a person asks for Discover now,
// and the hopper is killed at a kill point of the `topology-discovery` saga. A second hopper on the same database ends the
// saga. STS and the Kubernetes API are loopback fakes in the test process, so what they were asked outlives the hopper;
// each host reads with the crash reader (test/crash/topology-reader.ts).
import { expect } from 'vitest';
import type { TopologyGraph } from '../../src/domain/topology.ts';
import { topologyDiscoverySaga, TOPOLOGY_DISCOVERY_SAGA } from '../../src/infra-plans/topology-discovery.ts';
import { killPointsOf } from '../../src/sagas/kill-points.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { fakeKubeApi, fakeSts, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from '../support/fake-mint-apis.ts';
import { aws, CLUSTER } from '../support/topology-answers.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, startHost, type CrashHost } from './harness.ts';

const ACCOUNT = aws.account;
const MINTING_SECRET = 'crash-minting-secret-never-shown';
const KUBE_MINTING_TOKEN = 'crash-kube-minting-token-never-shown';
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

/** Every kill point of the `topology-discovery` saga, in step order. */
export const TOPOLOGY_KILL_POINTS: string[] = killPointsOf(topologyDiscoverySaga({ discovery: () => undefined }));

export interface TopologyWorld {
  url: string;
  sts: FakeApi;
  kubeApi: FakeApi;
  host(o?: { killPoint?: string }): Promise<CrashHost>;
  close(): Promise<void>;
}

/** The fakes and a fresh database. */
export async function topologyWorld(): Promise<TopologyWorld> {
  const sts = await fakeSts(ACCOUNT);
  const kubeApi = await fakeKubeApi();
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  return {
    url, sts, kubeApi,
    host: (o = {}) => startHost({ dbPath: db.dbPath, databaseUrl: url, fakes: {}, topology: true, ...(o.killPoint ? { killPoint: o.killPoint } : {}) }),
    close: async () => { sts.close(); kubeApi.close(); db.cleanup(); },
  };
}

/** The minting credentials of the account (its STS the fake) and of the cluster `prod` (its API server the fake). */
export async function keepMintingCredentials(w: TopologyWorld, h: CrashHost): Promise<void> {
  const set = async (body: Record<string, unknown>) => { expect((await h.ui('/ui/api/vault', { action: 'set', ...body })).status).toBe(200); };
  await set({ name: 'AWS_PROD', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: MINTING_SECRET, Region: aws.region, Endpoint: w.sts.url }) });
  await set({ name: 'KUBE_PROD', mints: { kind: 'cluster', name: 'prod' }, value: JSON.stringify({ server: w.kubeApi.url, token: KUBE_MINTING_TOKEN }) });
}

/** The `topology-discovery` sagas, by key and state. */
export function discoverySagas(url: string): { key: string; state: string }[] {
  const db = openDb(url);
  try { return db.all('SELECT key, state FROM sagas WHERE kind = ?', TOPOLOGY_DISCOVERY_SAGA) as { key: string; state: string }[]; } finally { db.close(); }
}

/** The account and its cluster, each one source, read by topology discovery. */
function readOnce(g: TopologyGraph): void {
  expect(g.sources.map((s) => [s.key, s.reporter, s.lastRead.ok])).toEqual([
    [`aws/${ACCOUNT}/${aws.region}`, 'topology discovery', true], [`kubernetes/${CLUSTER}`, 'topology discovery', true],
  ]);
  expect(g.nodes.filter((n) => n.id === CLUSTER)).toHaveLength(1);
}

/** No key — a minting credential's, the minted session's, or a minted token — in what a host wrote. */
function noKeyIn(h: CrashHost): void {
  for (const secret of [MINTING_SECRET, KUBE_MINTING_TOKEN, MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN]) expect(h.output()).not.toContain(secret);
}

/**
 * A first host killed at `point` while it discovers what a person asked for, a second that goes on: the person's run ends
 * done there, the graph holds the account and its cluster once each, no saga of discovery stays open, no Secret is left at
 * the cluster, and no host wrote a key.
 */
export async function killedThenDiscovered(w: TopologyWorld, point: string): Promise<CrashHost> {
  const a = await w.host({ killPoint: point });
  await keepMintingCredentials(w, a);
  void a.ui('/ui/api/topology/discover', {});
  await killedAt(a, point);
  expect(discoverySagas(w.url).filter((s) => s.key.includes('/asked/'))).toEqual([{ key: expect.any(String), state: 'running' }]);
  endLeases(w.url);
  const b = await w.host();
  await waitFor(() => (discoverySagas(w.url).every((s) => s.state !== 'running' && s.state !== 'compensating') ? true : undefined),
    { timeoutMs: 60_000, what: 'the second hopper to end every topology discovery' });
  expect(discoverySagas(w.url).filter((s) => s.key.includes('/asked/')).map((s) => s.state)).toEqual(['done']);
  readOnce(await b.get<TopologyGraph>('/api/topology'));
  const secrets = (method: string) => w.kubeApi.seen.filter((s) => s.method === method && s.url.includes('/secrets')).length;
  expect(secrets('POST')).toBe(secrets('DELETE'));
  noKeyIn(a);
  noKeyIn(b);
  return b;
}
