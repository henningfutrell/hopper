// hopper.io records (issue #463, docs/hopper-io-security.md R6): what hopper.io keeps of each act on a hopper.io
// account, for its owner to read. A record is its kind and its time only: no address, no browser, no other person
// (R5). It goes with its account, and after RECORD_MS it goes by itself (R5: stated retention).
//
// Feature: a hopper.io account owner reads what was done on the account
//   Scenario: sign-in and sign-out are records, newest first, on the page and as JSON
//   Scenario: a deletion confirmed as another GitHub account is a record on the account it was to delete
//   Scenario: each session reads only its own account's records (R3)
//   Scenario: a record older than RECORD_MS is deleted, not only hidden
//   Scenario: a deleted account takes its records with it
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { RECORD_MS } from '../../cloud/store.ts';
import { PUBLIC, rawUser, rows, setUp, signIn, stopAll, viaGitHub, type Set } from './harness.ts';

afterEach(stopAll);

const form = { 'content-type': 'application/x-www-form-urlencoded' };
const records = (s: Set, session: string | undefined) =>
  s.server.inject({ method: 'GET', url: '/api/account/records', ...(session ? { headers: { cookie: `${SESSION_COOKIE}=${session}` } } : {}) });
const post = (s: Set, url: string, session: string | undefined) =>
  s.server.inject({ method: 'POST', url, headers: { ...form, origin: PUBLIC, ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) }, payload: '' });
const kinds = (r: { json: () => { records: { kind: string }[] } }) => r.json().records.map((x) => x.kind);

describe('hopper.io records', () => {
  it('keeps sign-in and sign-out, newest first, with their kind and time only', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const first = await signIn(s);
    expect((await post(s, '/auth/sign-out', first.session)).statusCode).toBe(303);
    const second = await signIn(s);

    const r = await records(s, second.session);
    expect(r.statusCode).toBe(200);
    expect(kinds(r)).toEqual(['signed_in', 'signed_out', 'signed_in']);
    for (const x of r.json().records) expect(Object.keys(x).sort()).toEqual(['at', 'kind']);
    expect(Number.isNaN(Date.parse(r.json().records[0].at))).toBe(false);

    const home = await s.server.inject({ method: 'GET', url: '/', headers: { cookie: `${SESSION_COOKIE}=${second.session}` } });
    expect(home.body).toContain('Signed out');
    expect(home.body).toContain('Signed in');
    expect((await records(s, undefined)).statusCode).toBe(401);
  });

  it('a sign-out with no session records nothing', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    await post(s, '/auth/sign-out', 'no-such-session');
    expect(kinds(await records(s, run.session))).toEqual(['signed_in']);
  });

  it('a deletion confirmed as another GitHub account is a record on the account it was to delete', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    s.github.webLogin = 'grace';
    await viaGitHub(s, await post(s, '/account/delete', run.session), `${SESSION_COOKIE}=${run.session}; `);
    expect(kinds(await records(s, run.session))).toEqual(['deletion_refused', 'signed_in']);
    expect(await rows(s.databaseUrl)).not.toContain('grace');
  });

  it('each session reads only its own account records', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const a = await signIn(s);
    await signIn(s);
    s.github.webLogin = 'grace';
    const b = await signIn(s);
    expect(kinds(await records(s, a.session))).toEqual(['signed_in', 'signed_in']);
    expect(kinds(await records(s, b.session))).toEqual(['signed_in']);
  });

  it('deletes a record older than RECORD_MS, not only hides it', async () => {
    const s = await setUp();
    await s.store.signedIn({ githubUserId: '4242', login: 'old' });
    const then = new Date('2026-01-01T00:00:00Z');
    await s.store.record('4242', 'signed_in', then);
    const later = new Date(then.getTime() + RECORD_MS + 1000);
    await s.store.record('4242', 'signed_out', later);
    expect((await s.store.records('4242', later)).map((x) => x.kind)).toEqual(['signed_out']);
    expect(JSON.parse(await rows(s.databaseUrl))[3]).toHaveLength(1);
  });

  it('a deleted account takes its records with it', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const run = await signIn(s);
    await viaGitHub(s, await post(s, '/account/delete', run.session), `${SESSION_COOKIE}=${run.session}; `);
    expect(await s.store.account(String((await rawUser(s, 'ada')).id))).toBeUndefined();
    expect(JSON.parse(await rows(s.databaseUrl))[3]).toEqual([]);
  });
});
