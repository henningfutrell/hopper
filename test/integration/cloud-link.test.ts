// The cloud link (issue #467, design.md "The cloud link"): the hopper's admin links this install to an account at
// hopper.io, and unlinks it, in Settings, while it runs. A real daemon over the real database.
//   Scenario: a link and an unlink during a running job apply at once, end no job and are each an event
//   Scenario: the cloud link key (part 2) is minted at the link and rotated during a running job, which it does not end; not
//     linked, a rotation is 409; only the admin rotates
//   Scenario: a link is kept across a restart; a second link is 409; a bad account is 400; only the admin links
//   Scenario: an install that never links connects to nothing outside this machine, so not to hopper.io
import { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOUD_LINK_KEY, type CloudLinkView } from '../../src/domain/cloud-link.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(dbPath?: string): Promise<TestApp> {
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  t = await startTestApp({ dbPath });
  return t;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Every host this process opens a socket or a fetch to while `run` runs but this machine.
 * `Socket.prototype.connect` is the one place every TCP and TLS connection of this process passes (net, tls, http,
 * https, undici), so the daemon's main thread cannot reach hopper.io past it. Child processes and worker threads are not
 * watched: the database's worker (src/store/db.ts) connects only to the database HOPPER_DATABASE_URL names.
 */
async function outsideHosts(run: () => Promise<void>): Promise<{ outside: string[]; ports: Set<string> }> {
  const outside: string[] = [];
  const ports = new Set<string>();
  const note = (host: string | undefined, port?: unknown): void => {
    if (host === undefined) return;
    if (port !== undefined) ports.add(String(port));
    if (!LOCAL_HOSTS.has(host)) outside.push(host);
  };
  const connect = Socket.prototype.connect;
  const fetch = globalThis.fetch;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    // connect(options), connect([options, cb]) as tls and http pass it, connect(port, host), connect(path)
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') {
      const o = first as { host?: string; port?: unknown; path?: string };
      if (o.path === undefined) note(o.host ?? 'localhost', o.port);
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      note(typeof args[1] === 'string' ? args[1] : 'localhost', first);
    }
    return (connect as (...a: unknown[]) => Socket).apply(this, args);
  } as typeof connect;
  globalThis.fetch = (input, init) => {
    note(new URL(input instanceof Request ? input.url : String(input)).hostname);
    return fetch(input, init);
  };
  try {
    await run();
  } finally {
    Socket.prototype.connect = connect;
    globalThis.fetch = fetch;
  }
  return { outside, ports };
}

const view = async (a: TestApp, token: string): Promise<CloudLinkView> => (await a.api('GET', '/api/cloud-link', undefined, { 'x-hopper-session': token })).body as CloudLinkView;

describe('the cloud link', () => {
  it('a link and an unlink during a running job apply at once, end no job and are each an event', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'sleep', ms: 30_000 });
    await a.waitForStatus(job.id, 'running');
    expect(await view(a, token)).toEqual({ link: null });

    const linked = await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: ' Octo-Cat ' }, { token });
    expect(linked.status).toBe(200);
    expect(linked.body.link).toMatchObject({ account: 'octo-cat', state: 'pending', installId: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(await view(a, token)).toEqual(linked.body);
    expect((await a.job(job.id)).status).toBe('running');

    const key = linked.body.link!.linkKey!;
    expect(key).toEqual({ secret: CLOUD_LINK_KEY, publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), createdAt: expect.any(String) });
    const rotated = await a.ui<CloudLinkView>('/ui/api/cloud-link/rotate-key', {}, { token });
    expect(rotated.status).toBe(200);
    expect(rotated.body.link!.linkKey!.publicKey).not.toBe(key.publicKey);
    expect(await view(a, token)).toEqual(rotated.body);
    expect((await a.job(job.id)).status).toBe('running');

    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link/unlink', {}, { token })).body).toEqual({ link: null });
    expect((await a.ui<CloudLinkView>('/ui/api/cloud-link/unlink', {}, { token })).body).toEqual({ link: null });
    expect((await a.job(job.id)).status).toBe('running');
    const installId = linked.body.link!.installId;
    expect((await a.events('types=cloud_link.linked,cloud_link.unlinked')).map((e) => [e.type, e.data])).toEqual(expect.arrayContaining([
      ['cloud_link.linked', { installId, account: 'octo-cat', by: expect.any(String) }],
      ['cloud_link.unlinked', { installId, account: 'octo-cat', by: expect.any(String) }],
    ]));
    expect((await a.events('types=cloud_link.linked,cloud_link.unlinked'))).toHaveLength(2);
    expect((await a.ui('/ui/api/cloud-link/rotate-key', {}, { token })).status).toBe(409);
  });

  it('a link is kept across a restart; a second link is 409; a bad account is 400; only the admin links', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    let a = await boot(db.dbPath);
    let token = await a.login();
    for (const bad of [{}, { account: '' }, { account: 'a b' }, { account: 'x'.repeat(40) }, { account: 'octo', extra: 1 }]) {
      expect((await a.ui('/ui/api/cloud-link', bad, { token })).status, JSON.stringify(bad)).toBe(400);
    }
    const first = (await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'octo' }, { token })).body;
    expect((await a.ui('/ui/api/cloud-link', { account: 'other' }, { token })).status).toBe(409);

    await a.stop();
    a = await boot(db.dbPath);
    token = await a.login();
    expect(await view(a, token)).toEqual(first);

    const other = await a.addUser('octo2');
    const otherToken = await a.login(other.id);
    expect((await a.ui('/ui/api/cloud-link/unlink', {}, { token: otherToken })).status).toBe(403);
    expect((await a.ui('/ui/api/cloud-link/rotate-key', {}, { token: otherToken })).status).toBe(403);
    expect((await a.ui('/ui/api/cloud-link/rotate-key', { extra: 1 }, { token })).status).toBe(400);
    expect((await a.api('GET', '/api/cloud-link', undefined, { 'x-hopper-session': otherToken })).status).toBe(403);
    expect(await view(a, token)).toEqual(first);
  });

  it('an install that never links connects to nothing outside this machine, so not to hopper.io', async () => {
    let daemonPort = '';
    const { outside, ports } = await outsideHosts(async () => {
      const a = await boot();
      daemonPort = new URL(a.url).port;
      const token = await a.login();
      expect(await view(a, token)).toEqual({ link: null });
      const job = await a.pull({ op: 'sleep', ms: 300 });
      await a.waitForStatus(job.id, 'finished');
      await new Promise((r) => setTimeout(r, 1000));
      await a.stop();
      t = undefined;
    });
    // The watch saw this process's own connections to the daemon, so it sees the daemon's.
    expect(ports).toContain(daemonPort);
    expect(outside).toEqual([]);
  });
});
