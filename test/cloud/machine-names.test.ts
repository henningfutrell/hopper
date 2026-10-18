// The names an account owner gives machines at hopper.io (issue #465 item 4, docs/design.md "Machine names at
// hopper.io"). An instance reports each machine by an opaque key only, never its name (the hopper.io state snapshot);
// the owner names a machine they see under their instance, and hopper.io keeps that name by the instance id and the key.
// Transport-free, as cloud/link.ts: the cloud link's connection (issue #464) is not built.
//
// Feature: an account owner names the machines of their instances
//   Scenario: the owner names a machine of their instance's state; the API and the page show it; an empty name clears it
//   Scenario: a key not in the instance's state, another account's instance, a bad name or key, another Origin change nothing
//   Scenario: the names stay at a new snapshot and when the instance registers again under the same account
//   Scenario: a removal, an unlink, a move to another account and an account deletion drop the names
//   Scenario: at most MACHINE_NAMES_MAX names per instance; a named machine can still be named again
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudLinkAnswers } from '../../cloud/link.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { MACHINE_NAMES_MAX } from '../../cloud/store.ts';
import { PUBLIC, rawUser, registerAs, rows, setUp, signIn, stopAll, viaGitHub, type Set } from './harness.ts';

afterEach(stopAll);

const ADA = '1001';
const GRACE = '1002';
const INSTANCE = '7f0c2a4e1d1b4c55';
const OTHER = '0b9e8d7c6a5f4e3d';
const t0 = new Date('2026-10-18T12:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);
const form = { 'content-type': 'application/x-www-form-urlencoded' };
const cookie = (session: string) => ({ cookie: `${SESSION_COOKIE}=${session}` });

const machine = (key: string) => ({ key, online: true, lanesInUse: 1, lanes: 4, executors: ['claude'], takesJobs: true });
const snapshot = (...keys: string[]) => JSON.stringify({
  schema: 2, sentAt: '2026-10-18T11:59:58.000Z',
  instance: { version: '1f36076e', channel: 'dev' },
  queue: { waiting: 0, running: 0, locked: 0, gate: 'auto-accept' },
  attention: { questionsAwaitingOwner: 0, jobsLocked: 0, machinesOffline: 0 },
  machines: keys.map(machine),
});

async function withAccounts(s: Set) {
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.signedIn({ githubUserId: GRACE, login: 'grace' });
  await s.store.openSession('ada-session', ADA, new Date());
  await s.store.openSession('grace-session', GRACE, new Date());
  return createCloudLinkAnswers({ store: s.store, requests: s.requests, states: s.states });
}
const instances = async (s: Set, session: string) =>
  (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: cookie(session) })).json().instances as Record<string, unknown>[];
const name = (s: Set, session: string, installId: string, key: string, value: string, origin = PUBLIC) =>
  s.server.inject({
    method: 'POST', url: `/account/instances/${installId}/machines/${key}/name`,
    headers: { ...form, origin, ...cookie(session) }, payload: `name=${encodeURIComponent(value)}`,
  });

describe('machine names at hopper.io', () => {
  it('names a machine of the instance\'s state; the API and the page show it; an empty name clears it', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('k-desk', 'k-laptop'), now: later(1000) });

    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', '  Desk <box>  ')).statusCode).toBe(303);
    expect((await instances(s, 'ada-session'))[0]!.machineNames).toEqual({ 'k-desk': 'Desk <box>' });
    const page = (await s.server.inject({ method: 'GET', url: '/', headers: cookie('ada-session') })).body;
    expect(page).toContain('<strong>Desk &#60;box&#62;</strong> (k-desk)');
    expect(page).toContain(`action="/account/instances/${INSTANCE}/machines/k-laptop/name"`);
    expect(page).not.toContain('Desk <box>');
    expect((await s.store.records(ADA, later(10_000))).map((r) => r.kind)).toEqual(['machine_renamed', 'instance_registered']);

    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', '')).statusCode).toBe(303);
    expect((await instances(s, 'ada-session'))[0]!.machineNames).toBeUndefined();
    expect(await rows(s.databaseUrl)).not.toContain('k-desk');
  });

  it('changes nothing for a key not in the state, another account\'s instance, a bad name or key, another Origin', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, GRACE, OTHER, t0);
    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', 'Desk')).statusCode).toBe(404);
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('k-desk'), now: later(1000) });
    await link.snapshot({ installId: OTHER, account: 'grace', text: snapshot('k-desk'), now: later(1000) });

    expect((await name(s, 'ada-session', INSTANCE, 'k-gone', 'Desk')).statusCode).toBe(404);
    expect((await name(s, 'ada-session', OTHER, 'k-desk', 'Desk')).statusCode).toBe(404);
    expect((await name(s, 'grace-session', INSTANCE, 'k-desk', 'Desk')).statusCode).toBe(404);
    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', 'x'.repeat(65))).statusCode).toBe(400);
    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', 'a\u0007b')).statusCode).toBe(400);
    expect((await name(s, 'ada-session', INSTANCE, 'k.desk', 'Desk')).statusCode).toBe(404);
    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', 'Desk', 'https://evil.example')).statusCode).toBe(403);
    expect((await s.server.inject({
      method: 'POST', url: `/account/instances/${INSTANCE}/machines/k-desk/name`, headers: { ...form, origin: PUBLIC }, payload: 'name=Desk',
    })).statusCode).toBe(401);
    expect((await instances(s, 'ada-session'))[0]!.machineNames).toBeUndefined();
    expect((await instances(s, 'grace-session'))[0]!.machineNames).toBeUndefined();
  });

  it('keeps the names at a new snapshot and when the instance registers again under the same account', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('k-desk'), now: later(1000) });
    await name(s, 'ada-session', INSTANCE, 'k-desk', 'Desk');
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('k-laptop'), now: later(2000) });
    await registerAs(s, link, ADA, INSTANCE, later(3000));
    expect((await instances(s, 'ada-session'))[0]!.machineNames).toEqual({ 'k-desk': 'Desk' });
    // A name stays for a machine that is not in the state now, and can still be cleared.
    expect((await name(s, 'ada-session', INSTANCE, 'k-desk', '')).statusCode).toBe(303);
    expect((await instances(s, 'ada-session'))[0]!.machineNames).toBeUndefined();
  });

  it('drops the names at a removal, an unlink and a move to another account', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    const named = async (at: number) => {
      await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('k-desk'), now: later(at) });
      expect((await name(s, 'ada-session', INSTANCE, 'k-desk', 'Desk')).statusCode).toBe(303);
    };

    await registerAs(s, link, ADA, INSTANCE, t0);
    await named(1000);
    await s.server.inject({ method: 'POST', url: `/account/instances/${INSTANCE}/remove`, headers: { ...form, origin: PUBLIC, ...cookie('ada-session') }, payload: '' });
    expect(await rows(s.databaseUrl)).not.toContain('k-desk');

    await registerAs(s, link, ADA, INSTANCE, later(2000));
    await named(3000);
    await link.unlinked({ installId: INSTANCE, notice: JSON.stringify({ type: 'unlinked', installId: INSTANCE, account: 'ada' }), now: later(4000) });
    expect(await rows(s.databaseUrl)).not.toContain('k-desk');

    await registerAs(s, link, ADA, INSTANCE, later(5000));
    await named(6000);
    await registerAs(s, link, GRACE, INSTANCE, later(7000));
    expect((await instances(s, 'grace-session'))[0]!.machineNames).toBeUndefined();
    expect(await rows(s.databaseUrl)).not.toContain('k-desk');
  });

  it('drops the names when the account is deleted', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const { session } = await signIn(s);
    const ada = String((await rawUser(s, 'ada')).id);
    const link = createCloudLinkAnswers({ store: s.store, requests: s.requests, states: s.states });
    await registerAs(s, link, ada, INSTANCE, t0);
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('k-desk'), now: later(1000) });
    expect((await name(s, session!, INSTANCE, 'k-desk', 'Desk')).statusCode).toBe(303);
    expect(await rows(s.databaseUrl)).toContain('k-desk');

    const start = await s.server.inject({ method: 'POST', url: '/account/delete', headers: { ...form, origin: PUBLIC, ...cookie(session!) }, payload: '' });
    expect((await viaGitHub(s, start, `${SESSION_COOKIE}=${session}; `)).callback.statusCode).toBe(200);
    expect(await rows(s.databaseUrl)).not.toContain('k-desk');
  });

  it(`keeps at most ${MACHINE_NAMES_MAX} names per instance; a named machine can still be named again`, async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    for (let i = 0; i < MACHINE_NAMES_MAX; i++) expect(await s.store.nameMachine(ADA, INSTANCE, `m${i}`, `M ${i}`)).toBe('named');
    expect(await s.store.nameMachine(ADA, INSTANCE, 'one-more', 'More')).toBe('full');
    expect(await s.store.nameMachine(ADA, INSTANCE, 'm0', 'First')).toBe('named');
    expect(await s.store.nameMachine(GRACE, INSTANCE, 'm1', 'Not hers')).toBe('no-instance');

    await link.snapshot({ installId: INSTANCE, account: 'ada', text: snapshot('one-more'), now: later(1000) });
    expect((await name(s, 'ada-session', INSTANCE, 'one-more', 'More')).statusCode).toBe(409);
    const names = (await instances(s, 'ada-session'))[0]!.machineNames as Record<string, string>;
    expect(Object.keys(names)).toHaveLength(MACHINE_NAMES_MAX);
    expect(names.m0).toBe('First');
  });
});
