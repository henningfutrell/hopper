// Two hopper hosts on one database (issue #1627, design.md "Sweep leases: one host per sweep"): each due webhook
// delivery is sent once, a tool sign-in one host runs is not failed by the other while that host lives, a send's dedupe
// key asked on one host is a duplicate on the other and after a restart, and each sweep runs on one host at a time.
//
// Feature: two hosts on one database
//   Scenario: each delivery is sent once
//     Given hosts A and B on one database, each with its webhook dispatcher running
//     When A records 30 events for a subscription
//     Then the receiver gets each delivery once, and every delivery is delivered
//   Scenario: no sign-in of the other host fails
//     Given host A runs a tool sign-in, and host B runs none
//     When host B sweeps its sign-ins
//     Then A's sign-in still waits for its code
//     When host A stops
//     Then host B's next sweep fails it: nothing runs it any more
//   Scenario: the outbound dedupe is the database's
//     Given a send with a dedupe key asked on host A
//     Then the same send asked on host B, or on A after a restart, is a duplicate
//   Scenario: one host per sweep
//     Given hosts A and B asking the lease of one sweep
//     Then only A holds it while A lives, and B takes it once A stops
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore, UserStore } from '../../src/domain/ports.ts';
import { ADMIN_ID, type ToolSignIn, type WebhookSubscription } from '../../src/domain/types.ts';
import { createLogins } from '../../src/logins/service.ts';
import { createSignIns } from '../../src/logins/sign-ins.ts';
import { createOutbound, createOutboundGuard } from '../../src/outbound/index.ts';
import { createHostLeases, LEASE_ASK_MS, type HostLeases } from '../../src/sagas/index.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { createWebhookDispatcher } from '../../src/webhooks/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { waitFor } from '../support/wait.ts';
import { startReceiver, type Receiver } from '../webhooks/receiver.ts';

const clock = { now: () => new Date() };
const quiet = { info: () => {}, warn: () => {} };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** One host: its own connections to the shared database, the admin's store, and its sweep leases. */
function host(url: string, name: string): { instance: InstanceStore; store: UserStore; leases: HostLeases } {
  const instance = openInstanceStore({ url, clock });
  const store = instance.userStore(instance.users.get(ADMIN_ID)!);
  const leases = createHostLeases({ repo: instance.sweepLeases, owner: `test/${name}/${Math.random().toString(36).slice(2, 8)}`, clock, logger: quiet });
  cleanups.push(() => { leases.stop(); store.close(); instance.close(); });
  return { instance, store, leases };
}

const twoHosts = () => {
  const url = installFromBefore(testDatabaseUrl());
  return { a: host(url, 'a'), b: host(url, 'b') };
};

describe('two hosts on one database', () => {
  it('sends each due webhook delivery once', async () => {
    const { a, b } = twoHosts();
    const receiver: Receiver = await startReceiver((_n, res) => { res.statusCode = 200; res.end('ok'); });
    cleanups.push(() => receiver.close());
    const sub = a.store.webhooks.add({ name: 'hook', url: receiver.url, events: ['*'], active: true })!;
    const secretOf = (_s: WebhookSubscription): string => 'shh';
    for (const h of [a, b]) {
      const outbound = createOutbound({ guard: createOutboundGuard({ clock, logger: quiet, keys: h.instance.outboundKeys }), clock });
      const dispatcher = createWebhookDispatcher({ store: h.store, clock, secretOf, outbound, baseMs: 20, sweepMs: 5 });
      dispatcher.start();
      cleanups.push(async () => { await dispatcher.stop(); outbound.stop(); });
    }
    for (let i = 0; i < 30; i++) a.store.events.append({ type: 'job.queued', data: { n: i } });

    await waitFor(() => a.store.webhooks.listDeliveries({ subscriptionId: sub.id }).filter((d) => d.status === 'delivered').length === 30);
    await new Promise((r) => setTimeout(r, 100));
    const ids = receiver.received.map((r) => r.headers['x-hopper-delivery']);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(a.store.webhooks.listDeliveries({ subscriptionId: sub.id }).every((d) => d.attempts === 1)).toBe(true);
  });

  it('fails no sign-in the other host runs, and fails it once that host stopped', async () => {
    const { a, b } = twoHosts();
    let cancelled = false;
    const run: ToolSignIn = { machineId: 'box', tool: 'claude', url: 'https://claude.ai/oauth/authorize?code=x', paste: async () => ({ ok: true }), cancel: () => { cancelled = true; } };
    const source = { name: 'claude-plan', poll: async () => [], signIn: async () => run };
    const signInsOf = (h: ReturnType<typeof host>, sources: typeof source[]) => {
      const s = createSignIns({ logins: createLogins({ store: h.store, clock }), sources: () => sources, clock, sweepMs: 60_000, hosts: h.leases });
      cleanups.push(() => s.stop());
      return s;
    };
    const onA = signInsOf(a, [source]);
    const onB = signInsOf(b, []);

    const started = await onA.start('claude-plan');
    if (!started.ok) throw new Error(started.message);
    onB.sweep();
    expect(b.store.logins.get(started.login.id)?.status).toBe('pending');
    onA.sweep();
    expect(a.store.logins.get(started.login.id)?.status).toBe('pending');
    expect(cancelled).toBe(false);

    a.leases.stop();
    onB.sweep();
    const login = b.store.logins.get(started.login.id)!;
    expect(login.status).toBe('failed');
    expect(login.reason).toMatch(/start it again/);
  });

  it('dedupes a send by its key across hosts and restarts', () => {
    const { a, b } = twoHosts();
    const guard = (h: ReturnType<typeof host>) => createOutboundGuard({ clock, logger: quiet, keys: h.instance.outboundKeys });
    const send = { sender: 'webhook' as const, name: 'hook', url: 'http://127.0.0.1:9/hook', kind: 'job.queued', key: 'sub:event-1' };
    expect(guard(a).ask(send)).toBe('ok');
    expect(guard(b).ask(send)).toBe('duplicate');
    expect(guard(a).ask(send)).toBe('duplicate');
    expect(guard(b).ask({ ...send, key: 'sub:event-2' })).toBe('ok');
  });

  it('runs each sweep on one host at a time', async () => {
    const { a, b } = twoHosts();
    const onA = a.leases.lease('admin/failures'), onB = b.leases.lease('admin/failures');
    expect(onA.hold()).toEqual({ held: true, taken: true });
    expect(onB.hold()).toEqual({ held: false, taken: false });
    expect(onA.hold()).toEqual({ held: true, taken: false });
    expect(b.leases.live(a.leases.owner)).toBe(true);
    a.leases.stop();
    expect(b.leases.live(a.leases.owner)).toBe(false);
    // B asks the database again a second after its last ask (issue #1662).
    await new Promise((r) => setTimeout(r, LEASE_ASK_MS));
    expect(onB.hold()).toEqual({ held: true, taken: true });
    expect(onA.hold()).toEqual({ held: false, taken: false });
  });
});
