// Allowed hosts (issue #1024, design.md "Reaching the UI across a tailnet"): the hopper answers to its host's tailnet names
// and addresses, found at runtime, and to the hosts the admin allowed in Settings, as it answers to a LAN name — a read of
// /api/ still needs a sign-in or a token.
//   Scenario: on a tailnet, the MagicDNS name with the port reads /api/health with a session, and 401 without one
//   Scenario: the admin allows a host; it is answered at once, kept across a restart, and a change is an event
import { afterEach, describe, expect, it } from 'vitest';
import type { AllowedHostsView } from '../../src/domain/allowed-hosts.ts';
import type { TailnetSelf } from '../../src/http/tailnet.ts';
import { rawRequest } from '../support/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(o: { self?: TailnetSelf; dbPath?: string } = {}): Promise<TestApp> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  t = await startTestApp({ dbPath, seams: { tailnet: async () => o.self } });
  return t;
}

const health = (a: TestApp, host: string, token?: string) =>
  rawRequest(a.url, { path: '/api/health', headers: { host, ...(token ? { 'x-hopper-session': token } : {}) } });
const port = (a: TestApp): string => new URL(a.url).port;

describe('allowed hosts', () => {
  it('on a tailnet, the MagicDNS name and the tailnet address with the port read /api/health with a session, and 401 without one', async () => {
    const a = await boot({ self: { names: ['box.example.ts.net', 'box'], addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'] } });
    const token = await a.login();
    for (const host of [`box.example.ts.net:${port(a)}`, `100.101.102.103:${port(a)}`, `[fd7a:115c:a1e0::1]:${port(a)}`]) {
      expect((await health(a, host, token)).status, host).toBe(200);
      expect((await health(a, host)).status, host).toBe(401);
    }
    expect((await health(a, `other.example.ts.net:${port(a)}`, token)).status).toBe(421);
    const view = (await a.api('GET', '/api/allowed-hosts', undefined, { 'x-hopper-session': token })).body as AllowedHostsView;
    expect(view).toMatchObject({ hosts: [], tailnet: { on: true, names: ['box.example.ts.net', 'box', '100.101.102.103', 'fd7a:115c:a1e0::1'] } });
  });

  it('a host the admin allows is answered at once and kept across a restart; a change is an event; a bad host is 400', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    let a = await boot({ dbPath: db.dbPath });
    let token = await a.login();
    const host = `hopper.example.net:${port(a)}`;
    expect((await health(a, host, token)).status).toBe(421);

    const r = await a.ui<AllowedHostsView>('/ui/api/allowed-hosts', { hosts: [' Hopper.example.net ', 'hopper.example.net', '192.0.2.40'] }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ hosts: ['hopper.example.net', '192.0.2.40'], tailnet: { on: false, names: [] } });
    expect((await health(a, host, token)).status).toBe(200);
    expect((await health(a, host)).status).toBe(401);
    expect((await a.events('types=allowed_hosts.changed')).map((e) => e.data)).toEqual([{ from: [], to: ['hopper.example.net', '192.0.2.40'], by: expect.any(String) }]);

    for (const bad of [['hopper.example.net:4790'], ['http://hopper.example.net'], ['localhost'], ['127.0.0.2'], ['999.1.1.1'], ['a b']]) {
      expect((await a.ui('/ui/api/allowed-hosts', { hosts: bad }, { token })).status, bad[0]).toBe(400);
    }

    await a.stop();
    t = undefined;
    a = await boot({ dbPath: db.dbPath });
    token = await a.login();
    expect((await health(a, `hopper.example.net:${port(a)}`, token)).status).toBe(200);
    await a.ui('/ui/api/allowed-hosts', { hosts: [] }, { token });
    expect((await health(a, `hopper.example.net:${port(a)}`, token)).status).toBe(421);
  });
});
