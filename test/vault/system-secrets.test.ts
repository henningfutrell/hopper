// Issue #658: the system scope's one way in (src/vault/system.ts). `keep` is the only code that writes a value: a set,
// a replace and a rotation each an event, never with the value, its last 4 characters kept for its page. A read by the
// hopper is an event, at most once an hour per secret. With no master key nothing is kept, never in clear (issue #659).
// A value an absent key sealed is named by the start check, and an older key's is sealed again. A move from the old
// place is kept, opened again, and recorded.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NewEvent } from '../../src/domain/types.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createSystemSecrets, READ_EVENT_EVERY_MS } from '../../src/vault/system.ts';
import { memoryAccountStore, NO_KEY_PROBLEM } from '../support/system-secrets.ts';

const KEY = randomBytes(32).toString('hex');
const VALUE = 'gho_secret0123456789abcdefWXYZ';

function system(key: string | undefined, store = memoryAccountStore(), previous: string[] = []) {
  let now = Date.parse('2026-10-10T12:00:00Z');
  let n = 0;
  const s = createSystemSecrets({
    store: store.store, keys: key ? { sealer: createSealer(key, previous) } : { problem: NO_KEY_PROBLEM }, userId: 'u1',
    clock: { now: () => new Date(now) }, idGen: () => `id-${++n}`, logger: { warn: () => undefined },
  });
  return { s, ...store, later: (ms: number) => { now += ms; } };
}
const types = (events: NewEvent[]) => events.map((e) => [e.type, (e.data as { name: string }).name, (e.data as { replaced?: boolean }).replaced, (e.data as { rotated?: boolean }).rotated]);

describe('the system scope\'s one way in (issue #658)', () => {
  it('keeps a value sealed with its last 4 characters; a set, a replace and a rotation are events, never with the value', () => {
    const { s, events, secrets } = system(KEY);
    expect(s.keep('webhook.w1.signing-secret', VALUE, 'Ada')).toEqual({ ok: true });
    expect(s.keep('webhook.w1.signing-secret', `${VALUE}2`, 'Ada')).toEqual({ ok: true });
    expect(s.keep('webhook.w1.signing-secret', `${VALUE}3`, 'hopper', { rotated: true })).toEqual({ ok: true });
    expect(types(events)).toEqual([
      ['vault.secret_set', 'system/webhook.w1.signing-secret', false, undefined],
      ['vault.secret_set', 'system/webhook.w1.signing-secret', true, undefined],
      ['vault.secret_set', 'system/webhook.w1.signing-secret', true, true],
    ]);
    expect(s.meta('webhook.w1.signing-secret')).toMatchObject({ setBy: 'hopper', last4: 'XYZ3' });
    expect(secrets.get('system/webhook.w1.signing-secret')!.sealed).toMatch(/^hs1\./);
    expect(JSON.stringify([...secrets.values()].map((v) => v.secret))).not.toContain(VALUE);
    expect(JSON.stringify(events)).not.toContain(VALUE);
    expect(s.list()).toEqual([expect.objectContaining({ name: 'webhook.w1.signing-secret', kind: 'webhook', scope: 'user', last4: 'XYZ3' })]);
  });

  it('a read by the hopper is an event, at most once an hour per secret', () => {
    const { s, events, later } = system(KEY);
    s.keep('connected-account.github.access-token', VALUE, 'hopper');
    for (let i = 0; i < 5; i++) expect(s.open('connected-account.github.access-token', 'GitHub')).toBe(VALUE);
    later(READ_EVENT_EVERY_MS);
    expect(s.open('connected-account.github.access-token', 'GitHub')).toBe(VALUE);
    expect(events.filter((e) => e.type === 'vault.secret_read').map((e) => e.data)).toEqual([
      { name: 'system/connected-account.github.access-token', by: 'hopper', purpose: 'GitHub' },
      { name: 'system/connected-account.github.access-token', by: 'hopper', purpose: 'GitHub' },
    ]);
    expect(s.stored('connected-account.github.access-token')).toMatch(/^hs1\./);
  });

  it('no master key: nothing is kept, never in clear, and it says why; an older key\'s value is sealed again under the new one', () => {
    const store = memoryAccountStore();
    const none = system(undefined, store);
    for (const name of ['connected-account.github.access-token', 'webhook.w1.signing-secret'] as const) {
      expect(none.s.keep(name, VALUE, 'hopper')).toMatchObject({ ok: false, code: 'unavailable', error: expect.stringContaining('HOPPER_MASTER_KEY') });
    }
    expect(store.secrets.size).toBe(0);
    system(KEY, store).s.keep('webhook.w1.signing-secret', VALUE, 'Ada');
    const NEW = randomBytes(32).toString('hex');
    const rotated = system(NEW, store, [KEY]);
    expect(rotated.s.resealAll()).toBe(1);
    expect(rotated.s.stored('webhook.w1.signing-secret')!.split('.')[1]).toBe(createSealer(NEW).keyId);
    expect(rotated.s.open('webhook.w1.signing-secret')).toBe(VALUE);
  });

  it('the start check names the key a value was sealed under when the runtime does not give it; never a value', () => {
    const store = memoryAccountStore();
    system(KEY, store).s.keep('sign-in.corp.clientSecret', VALUE, 'the sign-in config');
    const other = system(randomBytes(32).toString('hex'), store);
    const found = other.s.check();
    expect(found).toEqual([{ name: 'sign-in.corp.clientSecret', problem: expect.stringContaining(`the key it was sealed under (${createSealer(KEY).keyId})`) }]);
    expect(other.s.list()[0]!.problem).toBe(found[0]!.problem);
    expect(system(undefined, store).s.check()[0]!.problem).toContain('the master key is missing');
    expect(JSON.stringify(found)).not.toContain(VALUE);
  });

  it('a move from the old place is kept, opened again and recorded as a move; a removal is an event', () => {
    const { s, events } = system(KEY);
    expect(s.migrate('webhook.w1.signing-secret', VALUE, 'webhooks')).toEqual({ ok: true });
    expect(s.open('webhook.w1.signing-secret')).toBe(VALUE);
    expect(s.drop('webhook.w1.signing-secret', 'Ada')).toBe(true);
    expect(s.drop('webhook.w1.signing-secret', 'Ada')).toBe(false);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['vault.secret_migrated', { name: 'system/webhook.w1.signing-secret', from: 'webhooks' }],
      ['vault.secret_read', { name: 'system/webhook.w1.signing-secret', by: 'hopper' }],
      ['vault.secret_removed', { name: 'system/webhook.w1.signing-secret', by: 'Ada' }],
    ]);
  });
});
