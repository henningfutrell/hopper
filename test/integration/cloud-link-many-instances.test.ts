// Many instances under one hopper.io account, end to end (issue #465, docs/design.md "Many instances under one hopper.io
// account"): two real instance daemons and the real hopper.io server (cloud/) on loopback, hopper.io behind a TLS front
// whose key both instances pin.
//   Scenario: two instances on this one box link to one account and register; hopper.io shows both, each connected, each
//     with this box as its own machine under its own opaque key (items 1, 4, 6)
//   Scenario: an instance stopped and started again on the same database keeps its instance id; it connects again, and a
//     registration again keeps one entry for it (item 3)
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

interface Machine { key: string; online: boolean }
interface AtHopperIo { installId: string; connected: boolean; state?: { machines: Machine[] } }

async function world() {
  const s = await setUp();
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.openSession('ada-session', ADA, new Date());
  await s.server.listen({ host: '127.0.0.1', port: 0 });
  const front = await tlsFront((s.server.server.address() as { port: number }).port);
  stops.push(() => front.close());
  const seams = { cloudLink: { url: front.url, pins: [front.cert.pin], ca: front.cert.cert } };

  /** An instance on its own database; `dbPath` names one an earlier instance used. */
  const instance = async (dbPath?: string) => {
    let path = dbPath;
    if (!path) {
      const db = tempDbPath();
      stops.push(db.cleanup);
      path = db.dbPath;
    }
    const a: TestApp = await startTestApp({ dbPath: path, seams });
    let stopped = false;
    const stop = async () => { if (!stopped) { stopped = true; await a.stop(); } };
    stops.push(stop);
    const token = await a.login();
    const view = async () => (await a.api('GET', '/api/cloud-link', undefined, { 'x-hopper-session': token })).body as CloudLinkView;
    return {
      a, token, stop, view,
      connected: () => waitFor(async () => (await view()).connection?.state === 'connected', { what: 'connected', timeoutMs: 10_000 }),
      link: async () => (await a.ui<CloudLinkView>('/ui/api/cloud-link', { account: 'ada' }, { token })).body.link!.installId,
      /** The owner enters this instance's registration code at hopper.io, and the instance says it is registered. */
      register: async (installId: string) => {
        const { code } = (await a.ui<{ code: string }>('/ui/api/cloud-link/registration-code', {}, { token })).body;
        const r = await s.server.inject({ method: 'POST', url: '/account/instances/register', headers: { ...form, origin: PUBLIC, cookie }, payload: `installId=${installId}&code=${code}` });
        expect(r.statusCode).toBe(303);
        await waitFor(async () => (await view()).link?.state === 'registered', { what: 'registered on the instance' });
      },
    };
  };
  const instances = async () => (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: { cookie } })).json().instances as AtHopperIo[];
  const shown = (ids: string[]) => waitFor(async () => {
    const all = await instances();
    return all.length === ids.length && ids.every((id) => {
      const i = all.find((x) => x.installId === id);
      return i?.connected === true && i.state?.machines.length === 1;
    });
  }, { what: `${ids.length} instances, connected, each with its machine`, timeoutMs: 10_000 });
  return { s, instance, instances, shown };
}

describe('many instances under one hopper.io account, end to end', { timeout: 60_000 }, () => {
  it('two instances on one box register to one account; each shows connected, with the box as its own machine', async () => {
    const w = await world();
    const one = await w.instance();
    const two = await w.instance();
    const ids = [await one.link(), await two.link()];
    expect(ids[0]).not.toBe(ids[1]);
    await one.connected();
    await two.connected();

    await one.register(ids[0]!);
    await two.register(ids[1]!);
    await w.shown(ids);

    const all = await w.instances();
    expect(all.map((i) => i.installId).sort()).toEqual([...ids].sort());
    const keys = all.map((i) => i.state!.machines[0]!.key);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // One box under two instances: once under each, by a key each instance makes with its own cloud link key; no merge.
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('an instance started again on the same database keeps its instance id, and a registration again keeps one entry', async () => {
    const w = await world();
    const first = await w.instance();
    const other = await w.instance();
    const id = await first.link();
    const otherId = await other.link();
    await first.connected();
    await other.connected();
    await first.register(id);
    await other.register(otherId);
    await w.shown([id, otherId]);

    // A new container on the same database: the link, its key and its registration stay.
    const dbPath = first.a.dbPath;
    await first.stop();
    await waitFor(async () => (await w.instances()).find((i) => i.installId === id)?.connected === false, { what: 'not connected' });
    const again = await w.instance(dbPath);
    expect((await again.view()).link).toMatchObject({ installId: id, account: 'ada', state: 'registered' });
    await again.connected();
    await w.shown([id, otherId]);

    await again.register(id);
    await waitFor(async () => (await again.a.events('types=cloud_link.registered')).length === 2, { what: 'the second registration' });
    await w.shown([id, otherId]);
    expect(await w.instances()).toHaveLength(2);
  });
});
