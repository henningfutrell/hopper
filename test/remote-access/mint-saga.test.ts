// The remote access mint as a saga (issue #1609, design.md "Remote access: the mint as a saga"): remote access and its
// saga coordinator on the real database, the providers' APIs loopback fakes. A hopper stopped after each provider call
// leaves the mint to the next one: after its start one tunnel and one DNS record exist (at ngrok one credential and one
// domain), and remote access is on; after an abort none exist, and remote access is off.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteAccessProvider } from '../../src/domain/remote-access.ts';
import type { InstanceStore } from '../../src/domain/ports.ts';
import { CREDENTIAL_SECRET, createRemoteAccess, TOKEN_SECRET, type RemoteAccess } from '../../src/http/remote-access.ts';
import { cloudflareProvider } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { createSagaCoordinator, type SagaCoordinator } from '../../src/sagas/coordinator.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import type { SystemSecrets } from '../../src/vault/system.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';
import { fakeCloudflare, fakeNgrok, type Fake, type FakeCloudflare, type FakeNgrok } from './fake-providers.ts';

const temp = useTempStore();
const quiet = { info: () => {}, warn: () => {} };
const CF = 'c'.repeat(40);
const NG = 'n'.repeat(40);

/** The instance's system secrets, shared by every hopper of the test. */
function secretsOf(kept: Map<string, string>): Pick<SystemSecrets, 'open' | 'meta' | 'keep' | 'drop' | 'problem'> {
  return {
    open: (name) => kept.get(name),
    meta: () => undefined,
    keep: (name, value) => { kept.set(name, value); return { ok: true } as ReturnType<SystemSecrets['keep']>; },
    drop: (name) => kept.delete(name),
    problem: () => undefined,
  };
}

describe('the remote access mint as a saga (issue #1609)', () => {
  const stores: InstanceStore[] = [], coordinators: SagaCoordinator[] = [], remotes: RemoteAccess[] = [], fakes: Fake[] = [];
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((c) => c.stop()));
    await Promise.all(remotes.splice(0).map((r) => r.stop()));
    for (const s of stores.splice(0)) s.close();
    for (const f of fakes.splice(0)) await f.close();
  });

  interface World { url: string; cf: FakeCloudflare; ng: FakeNgrok; secrets: Map<string, string> }
  const world = async (): Promise<World> => {
    const cf = await fakeCloudflare({ token: CF });
    const ng = await fakeNgrok({ key: NG });
    fakes.push(cf, ng);
    return { url: temp.url(), cf, ng, secrets: new Map([[CREDENTIAL_SECRET.cloudflare, CF], [CREDENTIAL_SECRET.ngrok, NG]]) };
  };

  /** One hopper start: its store, its remote access and its saga coordinator, on the shared database. */
  const hopper = (w: World, owner: string) => {
    const clock = fixedClock();
    const store = openInstanceStore({ url: w.url, clock });
    stores.push(store);
    const held: { c?: SagaCoordinator } = {};
    const ra = createRemoteAccess({
      settings: store.settings, secrets: secretsOf(w.secrets), events: { append: () => {} }, tunnelApis: {},
      providers: { cloudflare: cloudflareProvider({ base: w.cf.url }), ngrok: ngrokProvider({ base: w.ng.url }) },
      port: () => 4790, env: {}, publicUrl: undefined, now: () => clock.now(), logger: quiet,
      mints: { begin: (kind, key, data) => held.c!.begin(kind, key, data), drive: (id) => held.c!.drive(id), abort: (id, reason) => held.c!.abort(id, reason), open: () => store.sagas.open() },
      instanceId: store.settings.instanceId(),
    });
    remotes.push(ra);
    const c = held.c = createSagaCoordinator({ repo: store.sagas, definitions: ra.sagas, owner, clock, idGen: randomUUID, logger: quiet });
    coordinators.push(c);
    return { store, ra, c };
  };

  /** Turns remote access on at `provider` on a first hopper, which stops after the `n`th provider call; the second goes on. */
  const stoppedAt = async (w: World, provider: RemoteAccessProvider, n: number) => {
    const a = hopper(w, 'host-a');
    const hung = (provider === 'cloudflare' ? w.cf : w.ng).hang(n);
    const changed = a.ra.change({ provider, enabled: true }, 'admin');
    await hung;
    await a.c.stop();
    // The change answers what is minted so far: nothing yet.
    expect((await changed).provisioned).toBeUndefined();
    return hopper(w, 'host-b');
  };

  it('with no stop, one change mints the tunnel at Cloudflare and keeps it', async () => {
    const w = await world();
    const a = hopper(w, 'host-a');
    const view = await a.ra.change({ provider: 'cloudflare', enabled: true }, 'admin');
    expect(view).toMatchObject({ enabled: true, provisioned: { provider: 'cloudflare', domain: 'hopper.example.com' } });
    expect([...w.cf.tunnels.values()].map((t) => t.name)).toEqual([`hopper-${a.store.settings.instanceId()}`]);
    expect([w.cf.tunnels.size, w.cf.records.size]).toEqual([1, 1]);
    expect(w.secrets.get(TOKEN_SECRET.cloudflare)).toBe('cf-tunnel-token-tun1');
    expect(a.store.sagas.open()).toEqual([]);
  });

  // The calls: the zones, the tunnel looked up, made, its ingress, its token, the DNS record looked up, made.
  for (let n = 1; n <= 7; n++) {
    it(`Cloudflare: stopped after call ${n}, the next start mints one tunnel and one DNS record, and remote access is on`, async () => {
      const w = await world();
      const b = await stoppedAt(w, 'cloudflare', n);
      await b.c.pass();
      expect([w.cf.tunnels.size, w.cf.records.size]).toEqual([1, 1]);
      const [tunnelId] = [...w.cf.tunnels.keys()];
      expect([...w.cf.records.values()].map((r) => r.content)).toEqual([`${tunnelId}.cfargotunnel.com`]);
      expect(b.ra.view()).toMatchObject({ enabled: true, provisioned: { provider: 'cloudflare', domain: 'hopper.example.com' } });
      expect(w.secrets.get(TOKEN_SECRET.cloudflare)).toBe(`cf-tunnel-token-${tunnelId}`);
      expect(b.store.sagas.open()).toEqual([]);
    });

    it(`Cloudflare: stopped after call ${n}, then aborted, no tunnel and no DNS record are left, and remote access is off`, async () => {
      const w = await world();
      const b = await stoppedAt(w, 'cloudflare', n);
      const [saga] = b.store.sagas.open();
      expect(b.c.abort(saga!.id, 'the test aborts it')).toBe(true);
      expect((await b.c.drive(saga!.id))?.state).toBe('compensated');
      expect([w.cf.tunnels.size, w.cf.records.size]).toEqual([0, 0]);
      expect(b.ra.view()).toMatchObject({ enabled: false });
      expect(b.ra.view().provisioned).toBeUndefined();
      expect(w.secrets.has(TOKEN_SECRET.cloudflare)).toBe(false);
    });
  }

  // The calls: the credentials looked up, one made, the domains looked up, the instance's own reserved.
  for (let n = 1; n <= 4; n++) {
    it(`ngrok: stopped after call ${n}, the next start mints one credential and one domain, and remote access is on`, async () => {
      const w = await world();
      const b = await stoppedAt(w, 'ngrok', n);
      await b.c.pass();
      expect([w.ng.credentials.size, w.ng.domains.size]).toEqual([1, 1]);
      const [credentialId] = [...w.ng.credentials.keys()];
      expect(b.ra.view()).toMatchObject({ enabled: true, provisioned: { provider: 'ngrok', domain: `hopper-${b.store.settings.instanceId()}.ngrok.app` } });
      expect(w.secrets.get(TOKEN_SECRET.ngrok)).toBe(w.ng.credentials.get(credentialId!));
      expect(b.store.sagas.open()).toEqual([]);
    });

    it(`ngrok: stopped after call ${n}, then aborted, no credential and no domain are left`, async () => {
      const w = await world();
      const b = await stoppedAt(w, 'ngrok', n);
      const [saga] = b.store.sagas.open();
      b.c.abort(saga!.id, 'the test aborts it');
      expect((await b.c.drive(saga!.id))?.state).toBe('compensated');
      expect([w.ng.credentials.size, w.ng.domains.size]).toEqual([0, 0]);
      expect(b.ra.view().enabled).toBe(false);
    });
  }

  it('a change on the next start goes on with the mint a stop left first, then turns it off: nothing is left', async () => {
    const w = await world();
    const b = await stoppedAt(w, 'cloudflare', 3);
    expect(await b.ra.change({ enabled: false }, 'admin')).toMatchObject({ enabled: false });
    expect([w.cf.tunnels.size, w.cf.records.size]).toEqual([0, 0]);
    expect(b.store.sagas.open()).toEqual([]);
  });

  it('a mint begun but not asked for by the settings (a stop between the two) undoes itself', async () => {
    const w = await world();
    const a = hopper(w, 'host-a');
    const [kind] = a.ra.sagas.map((d) => d.kind);
    const saga = a.c.begin(kind!, 'k1', { port: 4790, name: `hopper-${a.store.settings.instanceId()}`, by: 'admin' });
    expect((await a.c.drive(saga.id))?.state).toBe('compensated');
    expect([w.cf.tunnels.size, w.cf.records.size]).toEqual([0, 0]);
    expect(a.ra.view().enabled).toBe(false);
  });
});
