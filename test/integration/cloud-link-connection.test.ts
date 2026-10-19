// The cloud link's connection, end to end (issue #2039, docs/design.md "The cloud link's connection"): the real instance
// daemon and the real hopper.io server (cloud/) on loopback, hopper.io behind a TLS front whose key the instance pins.
//   Scenario: an instance links, the owner enters its registration code at hopper.io, and it is registered on both sides;
//     its machines show under it; a second registration keeps one entry; Settings shows the connection
//   Scenario: a removal at hopper.io and an unlink on the instance each remove it on the other side, and delete nothing on
//     the instance
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudLinkView } from '../../src/domain/cloud-link.ts';
import { PUBLIC, setUp, stopAll } from '../cloud/harness.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { tlsFront } from '../support/cloud-tls.ts';
import { waitFor } from '../support/wait.ts';

const ADA = '1001';
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const cookie = `${SESSION_COOKIE}=ada-session`;
const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  await stopAll();
});

async function world() {
  const s = await setUp();
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.openSession('ada-session', ADA, new Date());
  await s.server.listen({ host: '127.0.0.1', port: 0 });
  const front = await tlsFront((s.server.server.address() as { port: number }).port);
  stops.push(() => front.close());
  const db = tempDbPath();
  stops.push(db.cleanup);
  const a: TestApp = await startTestApp({ dbPath: db.dbPath, seams: { cloudLink: { url: front.url, pins: [front.cert.pin], ca: front.cert.cert } } });
  stops.push(() => a.stop());
  const token = await a.login();
  return {
    s, a, token,
    view: async () => (await a.api('GET', '/api/cloud-link', undefined, { 'x-hopper-session': token })).body as CloudLinkView,
    instances: async () => (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: { cookie } })).json().instances as Record<string, unknown>[],
    enter: async (installId: string) => {
      const { code } = (await a.ui<{ code: string }>('/ui/api/cloud-link/registration-code', {}, { token })).body;
      return s.server.inject({ method: 'POST', url: '/account/instances/register', headers: { ...form, origin: PUBLIC, cookie }, payload: `installId=${installId}&code=${code}` });
    },
  };
}

describe('the cloud link\'s connection, end to end', () => {
  it('an instance links and registers on both sides; its machines show under it; a second registration keeps one entry', async () => {
    const w = await world();
    await w.a.addThisMachine();
    const linked = await w.a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'ada' }, { token: w.token });
    const installId = linked.body.link!.installId;
    await waitFor(async () => (await w.view()).connection?.state === 'connected', { what: 'connected', timeoutMs: 10_000 });

    expect((await w.enter(installId)).statusCode).toBe(303);
    await waitFor(async () => (await w.view()).link?.state === 'registered', { what: 'registered on the instance' });
    await waitFor(async () => {
      const [i] = await w.instances();
      return i?.connected === true && (i.state as { machines?: unknown[] } | undefined)?.machines?.length === 1;
    }, { what: 'the instance and its machine at hopper.io', timeoutMs: 10_000 });
    const [at] = await w.instances();
    expect(at).toMatchObject({ installId, connected: true });
    const machineKey = (at!.state as { machines: { key: string }[] }).machines[0]!.key;
    expect(machineKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(machineKey).not.toContain('local');

    expect((await w.enter(installId)).statusCode).toBe(303);
    await waitFor(async () => (await w.a.events('types=cloud_link.registered')).length === 2, { what: 'the second registration' });
    expect(await w.instances()).toHaveLength(1);
    const types = (await w.a.events('types=cloud_link.connected,cloud_link.disconnected,cloud_link.connection_refused')).map((e) => e.type);
    expect(types).toEqual(['cloud_link.connected']);
  });

  it('a removal at hopper.io and an unlink on the instance each remove it on the other side, and delete nothing on the instance', async () => {
    const w = await world();
    const job = await w.a.pull({ op: 'sleep', ms: 30_000 });
    await w.a.waitForStatus(job.id, 'running');
    const installId = (await w.a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'ada' }, { token: w.token })).body.link!.installId;
    await waitFor(async () => (await w.view()).connection?.state === 'connected', { what: 'connected', timeoutMs: 10_000 });
    expect((await w.enter(installId)).statusCode).toBe(303);
    await waitFor(async () => (await w.instances()).length === 1, { what: 'registered at hopper.io' });

    // Removed at hopper.io: the instance is pending again, its key revoked; the link and the job stay.
    const removed = await w.s.server.inject({ method: 'POST', url: `/account/instances/${installId}/remove`, headers: { ...form, origin: PUBLIC, cookie } });
    expect(removed.statusCode).toBe(303);
    await waitFor(async () => (await w.view()).connection?.state === 'revoked', { what: 'revoked' });
    expect((await w.view()).link).toMatchObject({ installId, account: 'ada', state: 'pending' });
    expect((await w.a.job(job.id)).status).toBe('running');
    expect((await w.a.events('types=cloud_link.revoked')).map((e) => e.data)).toEqual([{ installId, account: 'ada', by: 'hopper.io' }]);

    // A new key connects, and registers again.
    expect((await w.a.ui('/ui/api/cloud-link/rotate-key', {}, { token: w.token })).status).toBe(200);
    await waitFor(async () => (await w.view()).connection?.state === 'connected', { what: 'connected again' });
    expect((await w.enter(installId)).statusCode).toBe(303);
    await waitFor(async () => (await w.instances()).length === 1, { what: 'registered again' });

    // Unlinked on the instance: hopper.io drops it; nothing else on the instance changes.
    expect((await w.a.ui<CloudLinkView>('/ui/api/cloud-link/unlink', {}, { token: w.token })).body).toEqual({ link: null });
    await waitFor(async () => (await w.instances()).length === 0, { what: 'removed at hopper.io' });
    expect((await w.a.job(job.id)).status).toBe('running');
    expect((await w.a.events('types=cloud_link.disconnected')).length).toBeGreaterThan(0);
  });
});
