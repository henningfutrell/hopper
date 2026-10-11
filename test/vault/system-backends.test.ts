// Issue #658 requirement 6: a system secret a person gives — the TypeSafe API key, a webhook's signing secret — can be
// kept in a vault backend, when the owner turns it on. The backends only read, and asynchronously; the hopper reads its
// own secrets synchronously. So the hopper reads the value at start, when it is set and at each refresh, and holds it in
// its process memory only: never in the database, an event or a log line. A read that fails drops what was held: the
// hopper never falls back to a stale or local copy. The secrets the hopper writes itself (the GitHub tokens, the artifact
// key) and the instance's (the sign-in realms') stay in the hopper's own vault. The backend is a fake at its port
// (`VaultBackend`, src/domain/vault.ts).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SystemSecretAsk } from '../../src/domain/access.ts';
import type { ConfiguredBackend } from '../../src/domain/vault.ts';
import { createSealer, SecretUnreadable } from '../../src/secrets/sealer.ts';
import { createSystemSecrets } from '../../src/vault/system.ts';
import { memoryAccountStore } from '../support/system-secrets.ts';

const KEY = randomBytes(32).toString('hex');
const VALUE = 'typesafe-key-in-the-backend-0123ABCD';
const NEXT = 'typesafe-key-rotated-in-the-backend-WXYZ';
const ADA = { userId: 'u1', admin: false, by: 'Ada' };

/** A backend whose values a test changes; `down` makes every read fail. */
function fakeBackend() {
  const values = new Map<string, string>();
  const state = { down: false, reads: 0 };
  const backend: ConfiguredBackend = {
    name: 'my-vault', plugin: 'hashicorp-vault',
    backend: {
      name: 'my-vault',
      check: (ref) => (ref.includes('#') ? undefined : 'a reference is path#key'),
      read: async (ref) => {
        state.reads++;
        if (state.down) throw new Error('connection refused');
        const v = values.get(ref);
        if (v === undefined) throw new Error(`nothing at ${ref}`);
        return v;
      },
    },
  };
  return { backend, values, state };
}

function system(o: { allow?: boolean; backends?: ConfiguredBackend[] } = {}) {
  const store = memoryAccountStore();
  let n = 0;
  const warned: string[] = [];
  const asks: SystemSecretAsk[] = [];
  let backends = o.backends ?? [];
  const s = createSystemSecrets({
    store: store.store, keys: { sealer: createSealer(KEY) }, userId: 'u1',
    access: { decideSystemSecret: async (ask: SystemSecretAsk) => { asks.push(ask); return o.allow === false ? { allowed: false, reason: 'not yours' } : { allowed: true, reason: 'owner' }; } } as never,
    backends: () => backends,
    clock: { now: () => new Date('2026-10-10T12:00:00Z') }, idGen: () => `id-${++n}`, logger: { warn: (l) => { warned.push(l); } },
  });
  return { s, ...store, warned, asks, setBackends: (b: ConfiguredBackend[]) => { backends = b; } };
}

describe('a system secret kept in a vault backend (issue #658, requirement 6)', () => {
  it('a person points it at a backend: read once, held in memory, never in the store, an event or a log line', async () => {
    const b = fakeBackend();
    b.values.set('jev#key', VALUE);
    const { s, events, secrets, warned, asks } = system({ backends: [b.backend] });
    expect(await s.keepInBackend('typesafe-api-key', 'my-vault', 'jev#key', ADA)).toEqual({ ok: true });
    expect(asks).toEqual([expect.objectContaining({ name: 'typesafe-api-key', action: 'change' })]);
    expect(s.open('typesafe-api-key')).toBe(VALUE);
    expect(s.keptIn('typesafe-api-key')).toEqual({ name: 'my-vault', reference: 'jev#key' });
    expect(secrets.get('system/typesafe-api-key')!.sealed).toBeNull();
    expect(events.find((e) => e.type === 'vault.secret_set')!.data).toEqual({ name: 'system/typesafe-api-key', by: 'Ada', replaced: false, backend: 'my-vault' });
    expect(s.list()).toEqual([expect.objectContaining({ name: 'typesafe-api-key', backend: { name: 'my-vault', reference: 'jev#key' }, last4: 'ABCD' })]);
    for (const where of [JSON.stringify([...secrets.values()]), JSON.stringify(events), warned.join('\n')]) expect(where).not.toContain(VALUE);
  });

  it('a refresh reads the value the backend holds now; a read that fails drops the value held, and names the secret and the backend', async () => {
    const b = fakeBackend();
    b.values.set('hooks/w1#secret', VALUE);
    const { s, warned } = system({ backends: [b.backend] });
    await s.keepInBackend('webhook.w1.signing-secret', 'my-vault', 'hooks/w1#secret', ADA);
    b.values.set('hooks/w1#secret', NEXT);
    expect(await s.refresh()).toEqual([]);
    expect(s.open('webhook.w1.signing-secret')).toBe(NEXT);

    b.state.down = true;
    const found = await s.refresh();
    expect(found).toEqual([{ name: 'webhook.w1.signing-secret', problem: expect.stringMatching(/vault backend my-vault.*connection refused/) }]);
    expect(() => s.open('webhook.w1.signing-secret')).toThrow(SecretUnreadable);
    expect(() => s.open('webhook.w1.signing-secret')).toThrow(/my-vault/);
    expect(s.list()[0]!.problem).toBe(found[0]!.problem);
    expect(warned.join('\n')).not.toContain(NEXT);

    b.state.down = false;
    await s.refresh();
    expect(s.open('webhook.w1.signing-secret')).toBe(NEXT);
    expect(s.list()[0]!.problem).toBeUndefined();
  });

  it('before its first read (a fresh start) and with its backend gone, it cannot be opened: no local copy stands in', async () => {
    const b = fakeBackend();
    b.values.set('jev#key', VALUE);
    const first = system({ backends: [b.backend] });
    await first.s.keepInBackend('typesafe-api-key', 'my-vault', 'jev#key', ADA);
    // The same store, a new process: nothing is held until it is read.
    let n = 0;
    const again = createSystemSecrets({
      store: first.store, keys: { sealer: createSealer(KEY) }, userId: 'u1', backends: () => [b.backend],
      clock: { now: () => new Date() }, idGen: () => `again-${++n}`, logger: { warn: () => undefined },
    });
    expect(() => again.open('typesafe-api-key')).toThrow(/not read from vault backend my-vault yet/);
    expect(await again.refresh()).toEqual([]);
    expect(again.open('typesafe-api-key')).toBe(VALUE);

    first.setBackends([]);
    expect(await first.s.refresh()).toEqual([{ name: 'typesafe-api-key', problem: expect.stringMatching(/no vault backend my-vault/) }]);
    expect(() => first.s.open('typesafe-api-key')).toThrow(SecretUnreadable);
  });

  it('a rotation is refused, pointing at the backend; a value a person gives keeps it in the hopper again', async () => {
    const b = fakeBackend();
    b.values.set('hooks/w1#secret', VALUE);
    const { s, secrets } = system({ backends: [b.backend] });
    await s.keepInBackend('webhook.w1.signing-secret', 'my-vault', 'hooks/w1#secret', ADA);
    const rotated = s.keep('webhook.w1.signing-secret', 'made-by-the-hopper-0123456789abcdef', 'hopper', { rotated: true });
    expect(rotated).toMatchObject({ ok: false, code: 'conflict', error: expect.stringMatching(/kept in vault backend my-vault at hooks\/w1#secret: rotate it there/) });
    expect(s.open('webhook.w1.signing-secret')).toBe(VALUE);

    expect(s.keep('webhook.w1.signing-secret', NEXT, 'Ada')).toEqual({ ok: true });
    expect(s.keptIn('webhook.w1.signing-secret')).toBeUndefined();
    expect(secrets.get('system/webhook.w1.signing-secret')!.sealed).toMatch(/^hs1\./);
    expect(s.open('webhook.w1.signing-secret')).toBe(NEXT);
  });

  it('is refused for a secret the hopper writes or the whole hopper keeps, an unknown backend, a bad reference, a failed read, and without Access', async () => {
    const b = fakeBackend();
    b.values.set('a#b', VALUE);
    const { s, secrets } = system({ backends: [b.backend] });
    for (const name of ['connected-account.github.access-token', 'connected-account.github.refresh-token', 'artifact-content-key', 'sign-in.corp.clientSecret'] as const) {
      expect(await s.keepInBackend(name, 'my-vault', 'a#b', ADA)).toMatchObject({ ok: false, code: 'invalid', error: expect.stringContaining('stays in the hopper') });
    }
    expect(await s.keepInBackend('typesafe-api-key', 'other', 'a#b', ADA)).toMatchObject({ ok: false, code: 'invalid', error: expect.stringContaining('no vault backend other') });
    expect(await s.keepInBackend('typesafe-api-key', 'my-vault', 'ab', ADA)).toMatchObject({ ok: false, code: 'invalid', error: expect.stringContaining('path#key') });
    expect(await s.keepInBackend('typesafe-api-key', 'my-vault', 'none#here', ADA)).toMatchObject({ ok: false, code: 'invalid', error: expect.stringContaining('nothing at none#here') });
    expect(await system({ allow: false, backends: [b.backend] }).s.keepInBackend('typesafe-api-key', 'my-vault', 'a#b', ADA)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(secrets.size).toBe(0);
  });

  it('the reseal and the start check of sealed values pass over a secret kept in a backend', async () => {
    const b = fakeBackend();
    b.values.set('jev#key', VALUE);
    const { s } = system({ backends: [b.backend] });
    await s.keepInBackend('typesafe-api-key', 'my-vault', 'jev#key', ADA);
    expect(s.resealAll()).toBe(0);
    expect(s.check()).toEqual([]);
  });
});
