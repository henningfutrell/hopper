// hopper.io's registrations and their tombstones (issue #463, docs/cloud-hosting-identity.md decision 5; issue #465).
// A registration is one instance id under one hopper.io account, kept when the instance answers `registered` to the code
// its owner entered. Deleting the account deletes its registrations with it, and leaves a **registration tombstone** for
// each: the instance id and the time, nothing of the account. hopper.io cannot reach an instance, so the instance learns
// it at its next hello: hopper.io answers `unregister`, the message the instance already takes (src/http/cloud-link-messages.ts).
// Transport-free, as the instance's side: the cloud link's connection (issue #464) is not built.
//
// Feature: an account deletion tells the instances it registered
//   Scenario: an instance that answers `registered` is a registration of the account, once, however often it registers
//   Scenario: any other answer keeps nothing
//   Scenario: after the deletion, the instance's next hello is answered `unregister` for the account the hello names
//     And the tombstone keeps the instance id and the time only
//   Scenario: a registration that stays, and an instance hopper.io never knew, get no answer
//   Scenario: a tombstone older than TOMBSTONE_MS is deleted at the next write; the hello then gets no answer
//   Scenario: the instance registers again, under another account: its tombstone goes
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudLinkAnswers } from '../../cloud/link.ts';
import { TOMBSTONE_MS } from '../../cloud/store.ts';
import { registerAs, rows, setUp, stopAll, type Set } from './harness.ts';

afterEach(stopAll);

const ADA = '1001';
const GRACE = '1002';
const INSTANCE = '7f0c2a4e1d1b4c55';
const OTHER = '0b9e8d7c6a5f4e3d';
const t0 = new Date('2026-10-17T12:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);
/** The rows of one table, by its place in rows(): 4 registration, 5 registration_tombstone. */
const table = async (s: Set, i: number) => (JSON.parse(await rows(s.databaseUrl)) as { r: Record<string, unknown> }[][])[i]!.map((x) => x.r);

async function withAccounts(s: Set) {
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.signedIn({ githubUserId: GRACE, login: 'grace' });
  return createCloudLinkAnswers({ store: s.store, requests: s.requests, states: s.states });
}

describe("hopper.io's registrations", () => {
  it('keeps an instance that answers registered, once', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    expect(await registerAs(s, link, ADA, INSTANCE, t0)).toBe(true);
    expect(await registerAs(s, link, ADA, INSTANCE, later(1000))).toBe(true);
    const kept = await table(s, 4);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ install_id: INSTANCE, account_id: Number(ADA) });
  });

  it('keeps nothing for any other answer', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    for (const answer of [
      JSON.stringify({ type: 'registration', outcome: 'no-code' }),
      JSON.stringify({ type: 'registration', outcome: 'registered', extra: 1 }),
      JSON.stringify({ type: 'unregistration', outcome: 'unregistered' }),
      'not json',
      JSON.stringify({ type: 'registration', outcome: 'registered', pad: 'x'.repeat(2000) }),
    ]) expect(await registerAs(s, link, ADA, INSTANCE, t0, answer)).toBe(false);
    expect(await registerAs(s, link, ADA, 'not an id', t0)).toBe(false);
    expect(await table(s, 4)).toEqual([]);
  });

  it("after the account's deletion, tells the instance at its next hello, and keeps nothing of the account", async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await registerAs(s, link, GRACE, OTHER, t0);
    expect(await link.hello({ installId: INSTANCE, account: 'ada', now: later(1000) })).toBeUndefined();

    await s.store.deleteAccount(ADA, later(2000));

    expect(await link.hello({ installId: INSTANCE, account: 'ada', now: later(3000) })).toBe(JSON.stringify({ type: 'unregister', account: 'ada' }));
    expect(await link.hello({ installId: OTHER, account: 'grace', now: later(3000) })).toBeUndefined();
    expect(await link.hello({ installId: '1111222233334444', account: 'ada', now: later(3000) })).toBeUndefined();
    expect((await table(s, 4)).map((r) => r.install_id)).toEqual([OTHER]);
    const tombstones = await table(s, 5);
    expect(tombstones).toHaveLength(1);
    expect(Object.keys(tombstones[0]!).sort()).toEqual(['install_id', 'removed_at']);
    expect(tombstones[0]!.install_id).toBe(INSTANCE);
    const all = await rows(s.databaseUrl);
    expect(all).not.toContain(`"account_id":${ADA}`);
    expect(all).not.toContain(`"github_user_id":${ADA}`);
    expect(all).not.toContain('"ada"');
  });

  it('deletes a tombstone older than TOMBSTONE_MS at the next write; the hello then gets no answer', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await s.store.deleteAccount(ADA, t0);
    expect(await link.hello({ installId: INSTANCE, account: 'ada', now: later(TOMBSTONE_MS + 1) })).toBeUndefined();

    await registerAs(s, link, GRACE, OTHER, later(TOMBSTONE_MS + 1));
    await s.store.deleteAccount(GRACE, later(TOMBSTONE_MS + 1));
    expect((await table(s, 5)).map((r) => r.install_id)).toEqual([OTHER]);
  });

  it('drops the tombstone when the instance registers again, under another account', async () => {
    const s = await setUp();
    const link = await withAccounts(s);
    await registerAs(s, link, ADA, INSTANCE, t0);
    await s.store.deleteAccount(ADA, later(1000));
    await registerAs(s, link, GRACE, INSTANCE, later(2000));
    expect(await link.hello({ installId: INSTANCE, account: 'grace', now: later(3000) })).toBeUndefined();
    expect(await table(s, 5)).toEqual([]);
  });
});
