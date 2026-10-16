// Passkeys for local accounts (issue #1380, design.md "Passkeys for local accounts"): a local account adds a passkey, and
// signs in with it in place of its password. The WebAuthn checks are @simplewebauthn/server's; these tests hold the rules
// around them: a challenge is used once and only by its own ceremony, the origin and RP ID are the UI's, user
// verification is required, an unknown or removed passkey signs nobody in, and the signature counter moves.
import { describe, expect, it } from 'vitest';
import { createPasskeys, relyingParty } from '../../src/auth/passkeys.ts';
import type { LocalAccount, LocalAccountPasskey, LocalAccountPasskeyRepository } from '../../src/domain/ports.ts';
import { fakePasskey } from '../support/fake-authenticator.ts';

const ORIGIN = 'http://localhost:8790';
const rp = relyingParty(ORIGIN);
const NOW = new Date('2026-10-16T08:00:00Z');

function setup() {
  const accounts = new Map<string, LocalAccount>([['ada@example.com', { email: 'ada@example.com', passwordHash: 'x', role: 'admin', createdAt: NOW.toISOString() }]]);
  const rows = new Map<string, LocalAccountPasskey>();
  const repo: LocalAccountPasskeyRepository = {
    list: (email) => [...rows.values()].filter((p) => p.email === email),
    get: (id) => rows.get(id),
    put: (p) => { rows.set(p.id, p); },
    remove: (email, id) => rows.get(id)?.email === email && rows.delete(id),
    any: () => rows.size > 0,
  };
  const passkeys = createPasskeys({ accounts: { get: (e) => accounts.get(e.toLowerCase()) }, passkeys: repo, clock: { now: () => NOW } });
  return { passkeys, rows, accounts };
}

async function registered() {
  const s = setup();
  const key = fakePasskey();
  const options = await s.passkeys.registrationOptions('ada@example.com', 'session-1', rp);
  await s.passkeys.register('ada@example.com', 'session-1', rp, key.create(options, ORIGIN), 'Laptop');
  return { ...s, key };
}

describe('passkeys for local accounts (issue #1380)', () => {
  it('the relying party is the UI origin\'s host name', () => {
    expect(relyingParty('https://hopper.example.com')).toEqual({ id: 'hopper.example.com', origin: 'https://hopper.example.com' });
    expect(relyingParty('http://localhost:8790')).toEqual({ id: 'localhost', origin: 'http://localhost:8790' });
  });

  it('asks for a discoverable credential with user verification, and names the account by its email', async () => {
    const { passkeys } = setup();
    const options = await passkeys.registrationOptions('ada@example.com', 'session-1', rp);
    expect(options).toMatchObject({
      rp: { id: 'localhost' }, user: { name: 'ada@example.com' }, attestation: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
  });

  it('adds a passkey, then signs the account in with it; the counter moves and its last use is kept', async () => {
    const { passkeys, rows, key } = await registered();
    expect(passkeys.view('ada@example.com')).toEqual([{ id: key.id, name: 'Laptop', rpId: 'localhost', createdAt: NOW.toISOString() }]);
    expect(passkeys.any()).toBe(true);
    const { flow, options } = await passkeys.signInOptions(rp);
    expect(options).toMatchObject({ rpId: 'localhost', userVerification: 'required' });
    expect(options.allowCredentials ?? []).toEqual([]);
    const r = await passkeys.signIn(flow, rp, key.get(options, ORIGIN));
    expect(r).toMatchObject({ ok: true, account: { email: 'ada@example.com', role: 'admin' } });
    expect(rows.get(key.id)).toMatchObject({ counter: 1, lastUsedAt: NOW.toISOString() });
    // Nothing secret is kept: the public key only.
    expect(JSON.stringify([...rows.values()])).not.toMatch(/PRIVATE/);
  });

  it('uses a sign-in challenge once', async () => {
    const { passkeys, key } = await registered();
    const { flow, options } = await passkeys.signInOptions(rp);
    expect((await passkeys.signIn(flow, rp, key.get(options, ORIGIN))).ok).toBe(true);
    expect(await passkeys.signIn(flow, rp, key.get(options, ORIGIN))).toMatchObject({ ok: false, error: expect.stringMatching(/unknown, used or expired/) });
  });

  it('refuses an answer for another origin or RP ID, without user verification, or to another challenge', async () => {
    const { passkeys, key } = await registered();
    const tries: [string, (o: { challenge: string; rpId?: string }) => Record<string, unknown>][] = [
      ['origin', (o) => key.get(o, 'http://evil.example:8790')],
      ['rp id', (o) => key.get(o, ORIGIN, { rpId: 'evil.example' })],
      ['user verification', (o) => key.get(o, ORIGIN, { userVerified: false })],
      ['challenge', (o) => key.get({ ...o, challenge: 'bm90IHRoZSBjaGFsbGVuZ2U' }, ORIGIN)],
    ];
    for (const [, answer] of tries) {
      const { flow, options } = await passkeys.signInOptions(rp);
      expect(await passkeys.signIn(flow, rp, answer(options))).toMatchObject({ ok: false });
    }
  });

  it('a passkey added at one host name does not sign in at another', async () => {
    const { passkeys, key } = await registered();
    const other = relyingParty('https://hopper.example.com');
    const { flow, options } = await passkeys.signInOptions(other);
    expect(await passkeys.signIn(flow, other, key.get(options, other.origin))).toMatchObject({ ok: false });
  });

  it('an unknown passkey, a removed one, or one of a removed account signs nobody in', async () => {
    const { passkeys, accounts, key } = await registered();
    const stranger = fakePasskey();
    let s = await passkeys.signInOptions(rp);
    expect(await passkeys.signIn(s.flow, rp, stranger.get(s.options, ORIGIN))).toMatchObject({ ok: false, error: expect.stringMatching(/unknown passkey/) });
    accounts.delete('ada@example.com');
    s = await passkeys.signInOptions(rp);
    expect((await passkeys.signIn(s.flow, rp, key.get(s.options, ORIGIN))).ok).toBe(false);
    accounts.set('ada@example.com', { email: 'ada@example.com', passwordHash: 'x', role: 'admin', createdAt: NOW.toISOString() });
    expect(passkeys.remove('bea@example.com', key.id)).toBe(false);
    expect(passkeys.remove('ada@example.com', key.id)).toBe(true);
    s = await passkeys.signInOptions(rp);
    expect((await passkeys.signIn(s.flow, rp, key.get(s.options, ORIGIN))).ok).toBe(false);
  });

  it('a registration challenge is the session\'s own, used once; the same passkey is not added twice', async () => {
    const { passkeys } = setup();
    const key = fakePasskey();
    const options = await passkeys.registrationOptions('ada@example.com', 'session-1', rp);
    await expect(passkeys.register('ada@example.com', 'session-2', rp, key.create(options, ORIGIN), 'Laptop')).rejects.toThrow(/no passkey was asked for/);
    await expect(passkeys.register('ada@example.com', 'session-1', rp, key.create(options, ORIGIN, { userVerified: false }), 'Laptop')).rejects.toThrow(/user verification|verified/i);
    await expect(passkeys.register('ada@example.com', 'session-1', rp, key.create(options, ORIGIN), 'Laptop')).rejects.toThrow(/no passkey was asked for/);
    const again = await passkeys.registrationOptions('ada@example.com', 'session-1', rp);
    await passkeys.register('ada@example.com', 'session-1', rp, key.create(again, ORIGIN), 'Laptop');
    const third = await passkeys.registrationOptions('ada@example.com', 'session-1', rp);
    expect(third.excludeCredentials?.map((c) => c.id)).toEqual([key.id]);
    await expect(passkeys.register('ada@example.com', 'session-1', rp, key.create(third, ORIGIN), 'Laptop')).rejects.toThrow(/already added/);
  });
});
