// Issue #1905, through the real composition root, the real HTTP server and the real database: a running job reads the
// infrastructure topology with its own proxy token (`GET /job/topology`, design.md "The infrastructure topology"), as its
// starting map of accounts, VPCs, clusters and load balancers. `/api/topology` stays a person's read.
//
// Feature: a job reads the topology
//   Scenario: a running job reads the same graph a person reads, and nothing is recorded
//   Scenario: no token, a token that is no job's, and the token of a job that ended are refused
//   Scenario: the topology skill tells a job to read it at HOPPER_URL, never at 127.0.0.1
import { afterEach, describe, expect, it } from 'vitest';
import { awsTopology } from '../../src/domain/topology-discover.ts';
import type { TopologyGraph } from '../../src/domain/topology.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { JOB_TOPOLOGY_PATH } from '../../src/http/job-topology.ts';
import { skillOf } from '../../src/skills/catalog.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { aws } from '../support/topology-answers.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath });
  const a = t;
  const session = await a.login();
  const minted = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'topology collector', holder: 'ci', role: 'operator', scopes: ['topology:report'] }, { token: session });
  const token = (minted.body as { token: string }).token;
  const sent = await fetch(`${a.url}/ui/api/topology/report`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sources: [{ source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology(aws) }] }),
  });
  expect(sent.status).toBe(200);
  return { a, session };
}

const tokenOf = (a: TestApp, job: string): string => proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);
const read = (a: TestApp, bearer?: string) => fetch(`${a.url}/job/topology`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});

describe('a job reads the topology (issue #1905)', () => {
  it('a running job reads the graph a person reads, and nothing is recorded', async () => {
    const { a, session } = await boot();
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    await a.waitForStatus(job.id, 'running', 10000);
    const before = (await a.events()).length;

    const res = await read(a, tokenOf(a, job.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const g = (await res.json()) as TopologyGraph;
    const person = (await a.api<TopologyGraph>('GET', '/api/topology', undefined, { 'x-hopper-session': session })).body;
    expect(g).toEqual(person);
    expect(g.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(['aws-account', 'vpc', 'load-balancer']));
    expect((await a.events()).length).toBe(before);
  });

  it('refuses no token, a token that is no job\'s, and the token of a job that ended', async () => {
    const { a } = await boot();
    const none = await read(a);
    expect(none.status).toBe(401);
    expect(await none.text()).toMatch(/^no: the token is not a job's of this hopper/);
    expect((await read(a, 'not-a-token')).status).toBe(401);

    const job = await a.pull({ op: 'sleep', ms: 200 });
    await a.waitForStatus(job.id, 'finished', 10000);
    const ended = await read(a, tokenOf(a, job.id));
    expect(ended.status).toBe(401);
    expect(await ended.text()).toMatch(new RegExp(`^no: job ${job.id} is finished, not at work`));
  });

  it('the topology skill tells a job to read it at HOPPER_URL with its token file, never at 127.0.0.1', () => {
    const text = skillOf('topology')!.text;
    expect(text).toContain(`"$HOPPER_URL${JOB_TOPOLOGY_PATH}"`);
    expect(text).toContain('$HOPPER_TOKEN_FILE');
    expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
  });
});
