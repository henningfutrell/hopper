// A hopper.io account's instances (issue #465 items 1, 3 and 5, docs/design.md "Instances at hopper.io"): many
// registrations per account, one per instance id. The owner reads them, names them and removes them at hopper.io;
// the instance's hello keeps its last-seen time, and its unlink notice removes it. Transport-free, as cloud/link.ts:
// the cloud link's connection (issue #464) is not built.
//
// Feature: a hopper.io account owner keeps the instances they registered
//   Scenario: an account holds many instances; an instance that registers again under another account moves, never twice
//   Scenario: a hello of a registered instance keeps its last-seen time; an unknown instance's keeps nothing
//   Scenario: the owner lists only their own instances, with the id, the name, when registered and when last seen (R3)
//   Scenario: the owner names an instance; another account's instance, a bad name and another Origin change nothing
//   Scenario: the owner removes an instance; its next hello is answered `unregister`
//   Scenario: the instance's unlink notice removes its registration, and only its own
//   Scenario: the page shows the instances, the name escaped (T3)
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudLinkAnswers } from '../../cloud/link.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { PUBLIC, registerAs, rows, setUp, stopAll, type Set } from './harness.ts';

afterEach(stopAll);

const ADA = '1001';
const GRACE = '1002';
const INSTANCE = '7f0c2a4e1d1b4c55';
const OTHER = '0b9e8d7c6a5f4e3d';
const t0 = new Date('2026-10-17T12:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const cookie = (session: string) => ({ cookie: `${SESSION_COOKIE}=${session}` });

async function withAccounts(s: Set) {
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.signedIn({ githubUserId: GRACE, login: 'grace' });
  await s.store.openSession('ada-session', ADA, new Date());
  await s.store.openSession('grace-session', GRACE, new Date());
  return createCloudLinkAnswers({ store: s.store, requests: s.requests });
}
const instances = async (s: Set, session: string) =>
  (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: cookie(session) })).json().instances as Record<string, unknown>[];
const post = (s: Set, url: string, session: string, payload = '', origin = PUBLIC) =>
  s.server.inject({ method: 'POST', url, headers: { ...form, origin, ...cookie(session) }, payload });
const kinds = async (s: Set, githubUserId: string) => (await s.store.records(githubUserId, later(10_000))).map((r) => r.kind);

describe("a hopper.io account's instances", () => {
  it('holds many instances; one that registers under another account moves there, never twice', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, ADA, OTHER, t0);
    expect((await instances(s, 'ada-session')).map((i) => i.installId).sort()).toEqual([OTHER, INSTANCE]);
    expect(await kinds(s, ADA)).toEqual(['instance_registered', 'instance_registered']);

    await registerAs(s, link, GRACE, INSTANCE, later(1000));
    expect((await instances(s, 'ada-session')).map((i) => i.installId)).toEqual([OTHER]);
    expect((await instances(s, 'grace-session')).map((i) => i.installId)).toEqual([INSTANCE]);
    expect(await kinds(s, ADA)).toEqual(['instance_moved', 'instance_registered', 'instance_registered']);
    expect(await kinds(s, GRACE)).toEqual(['instance_registered']);
    const all = JSON.parse(await rows(s.databaseUrl)) as { r: Record<string, unknown> }[][];
    expect(all[4]!.filter((x) => x.r.install_id === INSTANCE)).toHaveLength(1);
  });

  it('keeps the last-seen time at a hello of a registered instance, and keeps the name when it registers again', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    expect((await instances(s, 'ada-session'))[0]).toEqual({ installId: INSTANCE, registeredAt: t0.toISOString() });

    await link.hello({ installId: INSTANCE, account: 'ada', now: later(5000) });
    await link.hello({ installId: '1111222233334444', account: 'ada', now: later(5000) });
    expect(await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', 'name=Kitchen+box')).toMatchObject({ statusCode: 303 });
    await registerAs(s, link, ADA, INSTANCE, later(6000));
    expect((await instances(s, 'ada-session'))[0]).toEqual({
      installId: INSTANCE, name: 'Kitchen box', registeredAt: t0.toISOString(), seenAt: later(5000).toISOString(),
    });
    expect(await kinds(s, ADA)).toEqual(['instance_renamed', 'instance_registered']);

    await registerAs(s, link, GRACE, INSTANCE, later(7000));
    expect((await instances(s, 'grace-session'))[0]).toEqual({ installId: INSTANCE, registeredAt: later(7000).toISOString() });
  });

  it('lists only the signed-in account\'s instances, and nothing without a session', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, GRACE, OTHER, t0);
    expect(await instances(s, 'ada-session')).toEqual([]);
    expect((await s.server.inject({ method: 'GET', url: '/api/account/instances' })).statusCode).toBe(401);
  });

  it('names only its own instance, with a name of 1 to 64 characters and no control character, from hopper.io itself', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, GRACE, OTHER, t0);

    expect((await post(s, `/account/instances/${OTHER}/name`, 'ada-session', 'name=Mine')).statusCode).toBe(404);
    expect((await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', `name=${'x'.repeat(65)}`)).statusCode).toBe(400);
    expect((await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', 'name=a%0Ab')).statusCode).toBe(400);
    expect((await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', 'name=Mine', 'https://elsewhere.example')).statusCode).toBe(403);
    expect((await post(s, '/account/instances/not-an-id/name', 'ada-session', 'name=Mine')).statusCode).toBe(404);
    expect((await post(s, `/account/instances/${INSTANCE}/name`, 'no-session', 'name=Mine')).statusCode).toBe(401);
    expect((await instances(s, 'ada-session'))[0]!.name).toBeUndefined();
    expect((await instances(s, 'grace-session'))[0]!.name).toBeUndefined();

    await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', 'name=++Desk++');
    expect((await instances(s, 'ada-session'))[0]!.name).toBe('Desk');
    await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', 'name=+');
    expect((await instances(s, 'ada-session'))[0]!.name).toBeUndefined();
  });

  it('removes its own instance at hopper.io; the next hello is answered unregister', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, GRACE, OTHER, t0);

    expect((await post(s, `/account/instances/${OTHER}/remove`, 'ada-session')).statusCode).toBe(404);
    expect((await post(s, `/account/instances/${INSTANCE}/remove`, 'ada-session', '', 'https://elsewhere.example')).statusCode).toBe(403);
    expect(await instances(s, 'grace-session')).toHaveLength(1);

    expect((await post(s, `/account/instances/${INSTANCE}/remove`, 'ada-session')).statusCode).toBe(303);
    expect(await instances(s, 'ada-session')).toEqual([]);
    expect(await kinds(s, ADA)).toEqual(['instance_removed', 'instance_registered']);
    expect(await link.hello({ installId: INSTANCE, account: 'ada', now: later(1000) })).toBe(JSON.stringify({ type: 'unregister', account: 'ada' }));
    expect(await link.hello({ installId: OTHER, account: 'grace', now: later(1000) })).toBeUndefined();
  });

  it("removes the registration at the instance's unlink notice, and only the instance's own", async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, GRACE, OTHER, t0);
    const notice = (installId: string, account: string) => JSON.stringify({ type: 'unlinked', installId, account });

    for (const [installId, text] of [
      [INSTANCE, notice(OTHER, 'grace')],
      [INSTANCE, notice(INSTANCE, 'grace')],
      [INSTANCE, JSON.stringify({ type: 'unlinked', installId: INSTANCE, account: 'ada', extra: 1 })],
      [INSTANCE, 'not json'],
      [INSTANCE, notice(INSTANCE, 'a'.repeat(2000))],
    ] as const) expect(await link.unlinked({ installId, notice: text, now: later(1000) })).toBe(false);
    expect(await instances(s, 'ada-session')).toHaveLength(1);

    expect(await link.unlinked({ installId: INSTANCE, notice: notice(INSTANCE, 'ada'), now: later(1000) })).toBe(true);
    expect(await instances(s, 'ada-session')).toEqual([]);
    expect(await instances(s, 'grace-session')).toHaveLength(1);
    expect(await kinds(s, ADA)).toEqual(['instance_unlinked', 'instance_registered']);
    expect(await link.hello({ installId: INSTANCE, account: 'ada', now: later(2000) })).toBeUndefined();
  });

  it('shows the instances on the page, the name escaped', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await post(s, `/account/instances/${INSTANCE}/name`, 'ada-session', `name=${encodeURIComponent('<b>box</b>')}`);
    const home = await s.server.inject({ method: 'GET', url: '/', headers: cookie('ada-session') });
    expect(home.body).toContain(INSTANCE);
    expect(home.body).toContain('&#60;b&#62;box&#60;/b&#62;');
    expect(home.body).not.toContain('<b>box</b>');
    expect(home.body).toContain(`action="/account/instances/${INSTANCE}/remove"`);
  });
});
