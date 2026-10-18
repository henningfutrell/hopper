// An instance's machines at hopper.io (issue #465 item 4, docs/design.md "Instance states at hopper.io"). A registered
// instance sends its state snapshot (src/domain/hopper-io-state.ts) on its link; hopper.io checks it against its own
// closed schema and a size cap, keeps the last one in memory only, and shows its machines under that instance, to its
// account's owner only. Transport-free, as cloud/link.ts: the cloud link's connection (issue #464) is not built.
//
// Feature: an account owner sees each instance's machines as the instance reported them
//   Scenario: a registered instance's snapshot shows under it, with its machines, and when hopper.io got it
//   Scenario: an instance that is not registered, or whose link names another account, keeps nothing
//   Scenario: a snapshot too large, not JSON, of another shape or another schema version keeps nothing
//   Scenario: a removal, an unlink and a move to another account drop the snapshot; so does an account deletion
//   Scenario: each account reads only its own instances' states (R3); the store holds none; the page escapes and says when
//   Scenario: hopper.io's schema is the instance's schema, and a snapshot of 500 machines fits the cap
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCloudLinkAnswers } from '../../cloud/link.ts';
import { INSTANCE_STATE_SCHEMA, SNAPSHOT_MAX_BYTES } from '../../cloud/states.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { HOPPER_IO_EXECUTORS, HOPPER_IO_STATE_SCHEMA } from '../../src/domain/hopper-io-state.ts';
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

const machine = (key: string, over: Record<string, unknown> = {}) => ({
  key, online: true, lanesInUse: 1, lanes: 4, executors: ['claude', 'codex'], takesJobs: true, ...over,
});
const snapshot = (over: Record<string, unknown> = {}) => ({
  schema: 2, sentAt: '2026-10-18T11:59:58.000Z',
  instance: { version: '1f36076e', channel: 'dev' },
  queue: { waiting: 2, running: 1, locked: 0, gate: 'auto-accept' },
  attention: { questionsAwaitingOwner: 1, jobsLocked: 0, machinesOffline: 1 },
  machines: [machine('k-desk'), machine('k-laptop', { online: false, lanesInUse: 0, takesJobs: false, notTaking: 'offline' })],
  ...over,
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
const post = (s: Set, url: string, session: string) =>
  s.server.inject({ method: 'POST', url, headers: { ...form, origin: PUBLIC, ...cookie(session) }, payload: '' });

describe("an instance's machines at hopper.io", () => {
  it('shows a registered instance\'s last snapshot under it, with its machines and when hopper.io got it', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    expect((await instances(s, 'ada-session'))[0]!.state).toBeUndefined();

    expect(await link.snapshot({ installId: INSTANCE, account: 'ada', text: JSON.stringify(snapshot()), now: later(1000) })).toBe(true);
    const next = snapshot({ queue: { waiting: 0, running: 3, locked: 1, gate: 'review' } });
    expect(await link.snapshot({ installId: INSTANCE, account: 'Ada', text: JSON.stringify(next), now: later(3000) })).toBe(true);
    expect((await instances(s, 'ada-session'))[0]).toEqual({
      installId: INSTANCE, registeredAt: t0.toISOString(), state: { ...next, receivedAt: later(3000).toISOString() },
    });
  });

  it('keeps nothing of an instance that is not registered, or whose link names another account', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    const text = JSON.stringify(snapshot());
    expect(await link.snapshot({ installId: OTHER, account: 'ada', text, now: later(1000) })).toBe(false);
    expect(await link.snapshot({ installId: INSTANCE, account: 'grace', text, now: later(1000) })).toBe(false);
    expect(await link.snapshot({ installId: 'not-an-id', account: 'ada', text, now: later(1000) })).toBe(false);
    expect((await instances(s, 'ada-session'))[0]!.state).toBeUndefined();
    expect(await instances(s, 'grace-session')).toEqual([]);
  });

  it('keeps nothing of a snapshot too large, not JSON, of another shape or another schema version', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    const bad = [
      JSON.stringify(snapshot({ machines: [machine('k'.repeat(64))], attention: { questionsAwaitingOwner: 1, jobsLocked: 0, machinesOffline: 0, pad: 'x'.repeat(SNAPSHOT_MAX_BYTES) } })),
      `${JSON.stringify(snapshot())}${' '.repeat(SNAPSHOT_MAX_BYTES)}`,
      'not json',
      JSON.stringify(snapshot({ schema: 1 })),
      JSON.stringify(snapshot({ label: 'desk.example.com' })),
      JSON.stringify(snapshot({ machines: [machine('k-desk', { label: 'desk.example.com' })] })),
      JSON.stringify(snapshot({ machines: [machine('desk.example.com')] })),
      JSON.stringify(snapshot({ machines: [machine('k-desk', { executors: ['my-runner'] })] })),
      JSON.stringify(snapshot({ queue: { waiting: -1, running: 0, locked: 0, gate: 'auto-accept' } })),
    ];
    for (const text of bad) expect(await link.snapshot({ installId: INSTANCE, account: 'ada', text, now: later(1000) })).toBe(false);
    expect((await instances(s, 'ada-session'))[0]!.state).toBeUndefined();
  });

  it('drops the snapshot at a removal, an unlink and a move to another account', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    const text = JSON.stringify(snapshot());
    const send = (at: number) => link.snapshot({ installId: INSTANCE, account: 'ada', text, now: later(at) });

    await registerAs(s, link, ADA, INSTANCE, t0);
    await send(1000);
    expect((await post(s, `/account/instances/${INSTANCE}/remove`, 'ada-session')).statusCode).toBe(303);
    await registerAs(s, link, ADA, INSTANCE, later(2000));
    expect((await instances(s, 'ada-session'))[0]!.state).toBeUndefined();

    await send(3000);
    await link.unlinked({ installId: INSTANCE, notice: JSON.stringify({ type: 'unlinked', installId: INSTANCE, account: 'ada' }), now: later(4000) });
    await registerAs(s, link, ADA, INSTANCE, later(5000));
    expect((await instances(s, 'ada-session'))[0]!.state).toBeUndefined();

    await send(6000);
    await registerAs(s, link, GRACE, INSTANCE, later(7000));
    expect((await instances(s, 'grace-session'))[0]!.state).toBeUndefined();
    await registerAs(s, link, ADA, INSTANCE, later(8000));
    expect((await instances(s, 'ada-session'))[0]!.state).toBeUndefined();

  });

  it('drops the account\'s snapshots when the account is deleted', async () => {
    const s = await setUp();
    s.github.webLogin = 'ada';
    const { session } = await signIn(s);
    const ada = String((await rawUser(s, 'ada')).id);
    const link = createCloudLinkAnswers({ store: s.store, requests: s.requests, states: s.states });
    await registerAs(s, link, ada, INSTANCE, t0);
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: JSON.stringify(snapshot()), now: later(1000) });
    expect(s.states.of(ada, INSTANCE)).toBeDefined();

    const start = await s.server.inject({ method: 'POST', url: '/account/delete', headers: { ...form, origin: PUBLIC, ...cookie(session!) }, payload: '' });
    expect((await viaGitHub(s, start, `${SESSION_COOKIE}=${session}; `)).callback.statusCode).toBe(200);
    expect(s.states.of(ada, INSTANCE)).toBeUndefined();
  });

  it('shows each account only its own instances\' states; the store holds none; the page escapes and says when', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, GRACE, OTHER, t0);
    await link.snapshot({ installId: INSTANCE, account: 'ada', text: JSON.stringify(snapshot()), now: later(1000) });
    expect((await instances(s, 'grace-session'))[0]!.state).toBeUndefined();
    expect(await rows(s.databaseUrl)).not.toContain('k-desk');

    const page = (await s.server.inject({ method: 'GET', url: '/', headers: cookie('ada-session') })).body;
    expect(page).toContain(`As the instance reported it at ${later(1000).toISOString()}`);
    expect(page).toContain('k-desk');
    expect(page).toContain('online, 1 of 4 lanes in use, executors: claude, codex, takes jobs');
    expect(page).toContain('offline, 0 of 4 lanes in use, executors: claude, codex, takes no job: offline');
    expect(page).toContain('2 waiting, 1 running, 0 locked');
    const grace = (await s.server.inject({ method: 'GET', url: '/', headers: cookie('grace-session') })).body;
    expect(grace).not.toContain('k-desk');
    expect(grace).toContain('No state reported yet');
  });

  it("uses the instance's own schema, and a snapshot of 500 machines with every executor fits the cap", () => {
    expect(z.toJSONSchema(INSTANCE_STATE_SCHEMA)).toEqual(z.toJSONSchema(HOPPER_IO_STATE_SCHEMA));
    const machines = Array.from({ length: 500 }, (_, i) => machine(`m${i}`.padEnd(64, 'x'), {
      lanesInUse: 99_999, lanes: 99_999, executors: [...HOPPER_IO_EXECUTORS], takesJobs: false, notTaking: 'template-waiting',
    }));
    const full = snapshot({ machines });
    expect(HOPPER_IO_STATE_SCHEMA.parse(full)).toEqual(full);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(SNAPSHOT_MAX_BYTES);
  });
});
