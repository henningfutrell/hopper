// The secret canary check (issue #1957), part 3: the crash paths. Through the crash harness (issue #1954), a hopper is
// killed with SIGKILL while a secret is in its hands — a tunnel's token the provider answered and the mint did not record,
// a job's GitHub write GitHub took with the connected account's token and the hopper did not record — and a second
// hopper on the same database goes on. Then the whole database, both hosts' work dirs, both hosts' output (their logs
// and their crash output) and the fakes' requests are scanned: no canary is anywhere. A host that ends with an unhandled
// rejection that says a canary is found, so the crash output is read.
//
// Feature: a secret appears only where it is kept, also after a crash
//   Scenario: the remote access mint killed after the tunnel's token came, then ended by a second hopper
//   Scenario: a job's GitHub write killed after GitHub took it, then sent again to a second hopper
//   Scenario: a canary in a host's crash output is found
import { afterEach, describe, expect, it } from 'vitest';
import { proxyKillPoint } from '../../src/github-proxy/index.ts';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { canary, databasePlaces, filePlaces, report, scan, type Place } from '../support/secret-canary.ts';
import { waitFor } from '../support/wait.ts';
import { fakeCloudflare } from '../remote-access/fake-providers.ts';
import { endLeases, killedAt, MASTER_KEY, startHost, stopHosts, type CrashHost } from './harness.ts';
import { openSagas, SCENARIO_MS } from './mint-world.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await stopHosts();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A place of captured text. */
const captured = (name: string, value: unknown): Place => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

/** What the scan reads after a crash: the database, and each host's work dir and output. */
const crashPlaces = (url: string, hosts: Record<string, CrashHost>): Place[] => [
  ...databasePlaces(url),
  ...Object.entries(hosts).flatMap(([name, h]) => [...filePlaces(`${name} work dir`, h.workDir), captured(`${name} output`, h.output())]),
];

/** A fresh test database, removed after the test. */
function database(): { dbPath: string; url: string } {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return { dbPath: db.dbPath, url: databaseUrlFor(db.dbPath) };
}

describe('the secret canary check, after a crash (issue #1957)', () => {
  it('the remote access mint killed after the tunnel\'s token came, then ended by a second hopper: no canary is in any place the scan reads', async () => {
    const canaries: Record<string, string> = { 'master key': MASTER_KEY, 'provider credential': canary('credential') };
    const prefix = canary('tunnel');
    const cf = await fakeCloudflare({ token: canaries['provider credential']!, tunnelToken: prefix });
    cleanups.push(() => cf.close());
    const { dbPath, url } = database();
    const host = (killPoint?: string) => startHost({ dbPath, databaseUrl: url, fakes: { cloudflare: cf.url, ngrok: cf.url }, ...(killPoint ? { killPoint } : {}) });

    const point = sagaKillPoint('remote-access-mint-cloudflare', 'token', 'after-do');
    const a = await host(point);
    await a.ui('/ui/api/remote-access', { provider: 'cloudflare', credential: canaries['provider credential'], enabled: true });
    await killedAt(a, point);
    endLeases(url);
    const b = await host();
    await waitFor(async () => {
      const v = await b.get<{ enabled: boolean }>('/api/remote-access');
      return v.enabled && openSagas(url).length === 0 ? v : undefined;
    }, { timeoutMs: 60_000, what: 'the second hopper to end the mint saga' });
    // The minted token: the one tunnel's, which the first hopper had in hand when it was killed.
    const tunnels = [...cf.tunnels.keys()];
    expect(tunnels).toHaveLength(1);
    canaries['tunnel token'] = `${prefix}${tunnels[0]!}`;

    expect(report(scan(canaries, crashPlaces(url, { 'killed host': a, 'second host': b })))).toBe('');
  }, SCENARIO_MS);

  it('a job\'s GitHub write killed after GitHub took it, then sent again to a second hopper: no canary is in any place the scan reads', async () => {
    const token = `ghu_${canary('x').replace(/[^A-Za-z0-9]/g, '')}`;
    const canaries: Record<string, string> = { 'master key': MASTER_KEY, 'account access token': token };
    const github = await createFakeGitHub({ clientId: 'gh-client-id' });
    cleanups.push(() => github.close());
    github.tokens.set(token, 'owner');
    github.issues.push({ repo: 'octo/tools', number: 7, title: 'Ship it', body: 'Please.', author: 'owner', labels: [] });
    const { dbPath, url } = database();

    const point = proxyKillPoint('issue.create', 'after-send');
    const a = await startHost({ dbPath, databaseUrl: url, fakes: { github: github.url }, connectGitHub: ['octo/tools'], githubToken: token, job: 'octo/tools#7', killPoint: point });
    const job = a.job!;
    canaries['proxy token'] = job.proxyToken;
    const sent = { op: 'issue.create', repo: 'octo/tools', title: 'Tidy the docs', body: 'Later.', key: 'canary-resend-key-1' };
    expect((await a.proxy(sent)).status).toBe(0);
    await killedAt(a, point);
    const b = await startHost({ dbPath, databaseUrl: url, fakes: { github: github.url } });
    const again = await b.proxy(sent, job.proxyToken);
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    const places = [
      ...crashPlaces(url, { 'killed host': a, 'second host': b }),
      captured('GitHub requests', github.requests.map(({ auth: _connection, ...r }) => r)),
    ];
    expect(report(scan(canaries, places))).toBe('');
    // The control: GitHub was asked with the connection, before the kill.
    expect(github.requests.some((r) => r.auth.includes(token) && r.method === 'POST' && r.path.endsWith('/issues'))).toBe(true);
  }, SCENARIO_MS);

  it('a canary in a host\'s crash output is found', async () => {
    const planted = canary('planted');
    const { dbPath, url } = database();
    const h = await startHost({ dbPath, databaseUrl: url, fakes: {}, plant: planted });
    const e = await h.exited;
    expect(e.code, h.output()).not.toBe(0);
    expect(report(scan({ planted }, crashPlaces(url, { 'crashed host': h })))).toContain('canary planted found in crashed host output (plain)');
  }, SCENARIO_MS);
});
