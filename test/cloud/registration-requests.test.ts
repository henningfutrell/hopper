// Entering a registration code at hopper.io (issue #465 item 2, docs/design.md "Registration requests at hopper.io"). The
// instance admin mints a code on the instance; the account owner enters it at hopper.io with the instance's id. hopper.io
// keeps it in memory only, as a **registration request**, for REQUEST_MS, and gives it as `register` only to that instance
// while the instance's link names the owner's account. Only the instance's `registered` answer to that request makes a
// registration. Transport-free, as cloud/link.ts: the cloud link's connection (issue #464) is not built.
//
// Feature: an account owner approves an instance at hopper.io with its code
//   Scenario: the owner enters the id and the code; the instance gets `register`; its `registered` answer registers it once
//   Scenario: another instance, or the instance linked to another account, gets no code, and its answer registers nothing
//   Scenario: the instance refuses the code; nothing is registered, the owner sees why, and the code is not kept
//   Scenario: a request expires after REQUEST_MS
//   Scenario: a bad id or code, another Origin or no session keeps nothing; at most REQUESTS_PER_ACCOUNT open per account
//   Scenario: each account reads only its own requests (R3), and the code is never in the store, the page or the API
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudLinkAnswers } from '../../cloud/link.ts';
import { REQUEST_MS, REQUESTS_PER_ACCOUNT } from '../../cloud/requests.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { PUBLIC, rows, setUp, stopAll, type Set } from './harness.ts';

afterEach(stopAll);

const ADA = '1001';
const GRACE = '1002';
const INSTANCE = '7f0c2a4e1d1b4c55';
const OTHER = '0b9e8d7c6a5f4e3d';
const CODE = 'c0de'.repeat(16);
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const cookie = (session: string) => ({ cookie: `${SESSION_COOKIE}=${session}` });
const answer = (outcome: string) => JSON.stringify({ type: 'registration', outcome });
const soon = (ms = 1000) => new Date(Date.now() + ms);

async function withAccounts(s: Set) {
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.signedIn({ githubUserId: GRACE, login: 'grace' });
  await s.store.openSession('ada-session', ADA, new Date());
  await s.store.openSession('grace-session', GRACE, new Date());
  return createCloudLinkAnswers({ store: s.store, requests: s.requests, states: s.states });
}
const enter = (s: Set, session: string, installId: string, code: string, origin = PUBLIC) => s.server.inject({
  method: 'POST', url: '/account/instances/register', headers: { ...form, origin, ...cookie(session) },
  payload: new URLSearchParams({ installId, code }).toString(),
});
const requests = async (s: Set, session: string) =>
  (await s.server.inject({ method: 'GET', url: '/api/account/registration-requests', headers: cookie(session) })).json().requests as Record<string, unknown>[];
const instances = async (s: Set, session: string) =>
  (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: cookie(session) })).json().instances as Record<string, unknown>[];

describe('a registration code entered at hopper.io', () => {
  it('goes to the instance as register; its registered answer registers the instance once', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    expect((await enter(s, 'ada-session', INSTANCE, ` ${CODE.toUpperCase()} `)).statusCode).toBe(303);
    expect(await requests(s, 'ada-session')).toEqual([{ installId: INSTANCE, expiresAt: expect.any(String) }]);

    expect(link.registerMessage({ installId: INSTANCE, account: 'ada', now: soon() })).toBe(JSON.stringify({ type: 'register', code: CODE, account: 'ada' }));
    expect(await link.registration({ installId: INSTANCE, account: 'ada', answer: answer('registered'), now: soon() })).toBe(true);
    expect((await instances(s, 'ada-session')).map((i) => i.installId)).toEqual([INSTANCE]);
    expect(await requests(s, 'ada-session')).toEqual([]);
    expect(link.registerMessage({ installId: INSTANCE, account: 'ada', now: soon() })).toBeUndefined();
    expect(await link.registration({ installId: INSTANCE, account: 'ada', answer: answer('registered'), now: soon() })).toBe(false);
    expect((await s.store.records(ADA, soon())).map((r) => r.kind)).toEqual(['instance_registered']);
  });

  it('goes to no other instance, nor to the instance linked to another account, and their answers register nothing', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await enter(s, 'ada-session', INSTANCE, CODE);
    expect(link.registerMessage({ installId: OTHER, account: 'ada', now: soon() })).toBeUndefined();
    expect(link.registerMessage({ installId: INSTANCE, account: 'grace', now: soon() })).toBeUndefined();
    expect(await link.registration({ installId: OTHER, account: 'ada', answer: answer('registered'), now: soon() })).toBe(false);
    expect(await link.registration({ installId: INSTANCE, account: 'grace', answer: answer('registered'), now: soon() })).toBe(false);
    expect(await instances(s, 'ada-session')).toEqual([]);
    expect(await instances(s, 'grace-session')).toEqual([]);
    expect(await requests(s, 'ada-session')).toHaveLength(1);
  });

  it("keeps nothing when the instance refuses the code; the owner sees why, and the code is gone", async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await enter(s, 'ada-session', INSTANCE, CODE);
    expect(await link.registration({ installId: INSTANCE, account: 'ada', answer: 'not json', now: soon() })).toBe(false);
    expect(await requests(s, 'ada-session')).toEqual([{ installId: INSTANCE, expiresAt: expect.any(String) }]);

    expect(await link.registration({ installId: INSTANCE, account: 'ada', answer: answer('no-code'), now: soon() })).toBe(false);
    expect(await requests(s, 'ada-session')).toEqual([{ installId: INSTANCE, expiresAt: expect.any(String), refused: 'no-code' }]);
    expect(link.registerMessage({ installId: INSTANCE, account: 'ada', now: soon() })).toBeUndefined();
    expect(await link.registration({ installId: INSTANCE, account: 'ada', answer: answer('registered'), now: soon() })).toBe(false);
    expect(await instances(s, 'ada-session')).toEqual([]);
    const home = await s.server.inject({ method: 'GET', url: '/', headers: cookie('ada-session') });
    expect(home.body).toContain('did not take the code');
  });

  it('expires after REQUEST_MS', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await enter(s, 'ada-session', INSTANCE, CODE);
    const after = soon(REQUEST_MS + 1000);
    expect(link.registerMessage({ installId: INSTANCE, account: 'ada', now: after })).toBeUndefined();
    expect(await link.registration({ installId: INSTANCE, account: 'ada', answer: answer('registered'), now: after })).toBe(false);
    expect(s.requests.of(ADA, after)).toEqual([]);
  });

  it('keeps nothing for a bad id or code, another Origin or no session; at most REQUESTS_PER_ACCOUNT open', async () => {
    const s = await setUp();
    await withAccounts(s);
    expect((await enter(s, 'ada-session', 'not-an-id', CODE)).statusCode).toBe(400);
    expect((await enter(s, 'ada-session', INSTANCE, 'short')).statusCode).toBe(400);
    expect((await enter(s, 'ada-session', INSTANCE, CODE, 'https://elsewhere.example')).statusCode).toBe(403);
    expect((await enter(s, 'no-session', INSTANCE, CODE)).statusCode).toBe(401);
    expect(await requests(s, 'ada-session')).toEqual([]);

    const ids = Array.from({ length: REQUESTS_PER_ACCOUNT + 1 }, (_, i) => i.toString(16).padStart(16, '0'));
    for (const id of ids.slice(0, -1)) expect((await enter(s, 'ada-session', id, CODE)).statusCode).toBe(303);
    expect((await enter(s, 'ada-session', ids.at(-1)!, CODE)).statusCode).toBe(429);
    expect((await enter(s, 'ada-session', ids[0]!, CODE)).statusCode).toBe(303);
    expect(await requests(s, 'ada-session')).toHaveLength(REQUESTS_PER_ACCOUNT);
  });

  it('is read only by its own account, and the code is never in the store, the page or the API', async () => {
    const s = await setUp();
    await withAccounts(s);
    await enter(s, 'ada-session', INSTANCE, CODE);
    expect(await requests(s, 'grace-session')).toEqual([]);
    expect((await s.server.inject({ method: 'GET', url: '/api/account/registration-requests' })).statusCode).toBe(401);
    const home = await s.server.inject({ method: 'GET', url: '/', headers: cookie('ada-session') });
    expect(home.body).toContain(INSTANCE);
    expect(home.body).toContain('action="/account/instances/register"');
    for (const text of [home.body, JSON.stringify(await requests(s, 'ada-session')), await rows(s.databaseUrl)]) expect(text).not.toContain(CODE);
  });
});
