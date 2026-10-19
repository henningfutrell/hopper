// The cloud link key (issue #467 part 2, design.md "The cloud link key", docs/hopper-io-security.md R4): one Ed25519
// key per instance (issue #2039: it signs hopper.io's challenge), minted at the link, its private half a system secret in the instance's vault that the link record
// names, its public half in the record. The admin rotates it on request; an unlink drops it. Over the real instance store.
//   Scenario: a link mints the key; the record names the secret and holds the public half; the view never the private half
//   Scenario: a rotation replaces the key; the old one is kept until the new one connected (issue #2039); not linked, 409
//   Scenario: a revoke drops both keys and keeps the link; no key is minted again until a rotation (issue #2039)
//   Scenario: a link with no key gets one when the agent connects (issue #2039)
//   Scenario: an unlink drops the key with the record
//   Scenario: with no master key, a link is refused and writes nothing
//   Scenario: an unregistration keeps the key; a link from before part 2 has none until a rotation mints one
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOUD_LINK_KEY, CLOUD_LINK_PREVIOUS_KEY, type CloudLinkView } from '../../src/domain/cloud-link.ts';
import type { InstanceStore } from '../../src/domain/store.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { systemBackendRefusal } from '../../src/domain/vault.ts';
import { createCloudLink, type CloudLink } from '../../src/http/cloud-link.ts';
import { HttpError } from '../../src/http/errors.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import type { SystemSecrets } from '../../src/vault/system.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { systemOf } from '../support/system-secrets.ts';
import { fixedClock } from '../store/helpers.ts';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

function setup(key?: null): { instance: InstanceStore; link: CloudLink; secrets: SystemSecrets; events: NewEvent[] } {
  const instance = openInstanceStore({ url: installFromBefore(testDatabaseUrl()), clock: fixedClock() });
  closers.push(() => instance.close());
  const events: NewEvent[] = [];
  const append = (e: NewEvent) => { events.push(e); return e; };
  const secrets = systemOf({ vault: instance.vault, events: { append }, tx: instance.tx }, key);
  const link = createCloudLink({ settings: instance.settings, secrets, events: { append }, now: () => new Date('2026-10-17T08:00:00.000Z') });
  return { instance, link, secrets, events };
}

/** The private key the secret holds, a JWK. */
const privateOf = (secret: string) => createPrivateKey({ key: JSON.parse(secret) as JsonWebKey, format: 'jwk' });
/** The public half, as the record keeps it, of the private half the secret holds. */
const publicOf = (secret: string): string => (createPublicKey(privateOf(secret)).export({ format: 'jwk' }) as { x: string }).x;

const keyOf = (v: CloudLinkView) => v.link?.linkKey;

describe('the cloud link key', () => {
  it('a link mints the key; the record names the secret and holds the public half; the view never the private half', () => {
    const { instance, link, secrets, events } = setup();
    const view = link.link('octo-cat', 'admin');
    expect(keyOf(view)).toEqual({ secret: CLOUD_LINK_KEY, publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), createdAt: '2026-10-17T08:00:00.000Z' });
    expect(instance.settings.getCloudLink()?.linkKey).toEqual(keyOf(view));
    const secret = secrets.open(CLOUD_LINK_KEY)!;
    expect(privateOf(secret).asymmetricKeyType).toBe('ed25519');
    // The vault keeps a secret's last 4 characters: none of them is the private half's.
    expect(secrets.meta(CLOUD_LINK_KEY)?.last4).toBe('KP"}');
    expect(publicOf(secret)).toBe(keyOf(view)!.publicKey);
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.map((e) => e.type)).toEqual(['vault.secret_set', 'cloud_link.linked', 'vault.secret_read']);
    expect(secrets.list()).toEqual([expect.objectContaining({ name: CLOUD_LINK_KEY, kind: 'cloud-link' })]);
    expect(systemBackendRefusal(CLOUD_LINK_KEY)).toContain('stays in the hopper');
  });

  it('a rotation replaces the key; the old one is kept until the new one connected; not linked, 409', () => {
    const { link, secrets, events } = setup();
    expect(() => link.rotateKey('admin')).toThrow(HttpError);
    const before = keyOf(link.link('octo-cat', 'admin'))!;
    const old = secrets.open(CLOUD_LINK_KEY)!;
    events.length = 0;
    const after = keyOf(link.rotateKey('admin'))!;
    expect(after.publicKey).not.toBe(before.publicKey);
    const secret = secrets.open(CLOUD_LINK_KEY)!;
    expect(secret).not.toBe(old);
    expect(publicOf(secret)).toBe(after.publicKey);
    expect(events[0]).toEqual({ type: 'vault.secret_set', data: { name: `system/${CLOUD_LINK_PREVIOUS_KEY}`, by: 'admin' } });
    expect(events[1]).toEqual({ type: 'vault.secret_set', data: { name: `system/${CLOUD_LINK_KEY}`, by: 'admin', replaced: true, rotated: true } });
    // The key before stays until hopper.io took the new one: its hello proves the bound key (R4).
    expect(link.view().link).toMatchObject({ account: 'octo-cat', state: 'pending', linkKey: after, previousKey: { ...before, secret: CLOUD_LINK_PREVIOUS_KEY } });
    expect(secrets.open(CLOUD_LINK_PREVIOUS_KEY)).toBe(old);

    // A second rotation before a connection keeps the first key before: the one hopper.io may still have bound.
    link.rotateKey('admin');
    expect(link.view().link?.previousKey?.publicKey).toBe(before.publicKey);
    expect(secrets.open(CLOUD_LINK_PREVIOUS_KEY)).toBe(old);

    // Another key's connection drops nothing; the new key's drops the key before.
    link.keyConnected(after.publicKey);
    expect(link.view().link?.previousKey).toBeDefined();
    link.keyConnected(link.view().link!.linkKey!.publicKey);
    expect(link.view().link?.previousKey).toBeUndefined();
    expect(secrets.meta(CLOUD_LINK_PREVIOUS_KEY)).toBeUndefined();
  });

  it('a revoke drops both keys and keeps the link; no key is minted again until a rotation', () => {
    const { link, secrets, events } = setup();
    expect(() => link.revokeKey('admin')).toThrow(HttpError);
    const { installId } = link.link('octo-cat', 'admin').link!;
    link.rotateKey('admin');
    const view = link.revokeKey('admin');
    expect(view.link).toMatchObject({ installId, account: 'octo-cat', keyRevokedAt: '2026-10-17T08:00:00.000Z' });
    expect(view.link?.linkKey).toBeUndefined();
    expect(view.link?.previousKey).toBeUndefined();
    expect(secrets.meta(CLOUD_LINK_KEY)).toBeUndefined();
    expect(secrets.meta(CLOUD_LINK_PREVIOUS_KEY)).toBeUndefined();
    expect(events).toContainEqual({ type: 'cloud_link.revoked', data: { installId, account: 'octo-cat', by: 'admin' } });
    expect(link.ensureKey()?.linkKey).toBeUndefined();

    const rotated = link.rotateKey('admin').link!;
    expect(rotated.linkKey?.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.keyRevokedAt).toBeUndefined();
    expect(rotated.previousKey).toBeUndefined();
  });

  it('a link with no key gets one when the agent connects', () => {
    const { instance, link } = setup();
    expect(link.ensureKey()).toBeUndefined();
    instance.settings.setCloudLink({ installId: instance.settings.instanceId(), account: 'octo-cat', state: 'pending', linkedAt: '2026-10-17T07:00:00.000Z', by: 'admin' });
    const key = link.ensureKey()?.linkKey;
    expect(key?.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.ensureKey()?.linkKey).toEqual(key);
  });

  it('an unlink drops the key with the record', () => {
    const { instance, link, secrets, events } = setup();
    link.link('octo-cat', 'admin');
    expect(link.unlink('admin')).toEqual({ link: null });
    expect(secrets.meta(CLOUD_LINK_KEY)).toBeUndefined();
    expect(instance.vault.get(`system/${CLOUD_LINK_KEY}`)).toBeUndefined();
    expect(events.map((e) => e.type)).toContain('vault.secret_removed');
  });

  it('with no master key, a link is refused and writes nothing', () => {
    const { instance, link, events } = setup(null);
    expect(() => link.link('octo-cat', 'admin')).toThrow(expect.objectContaining({ status: 503 }) as Error);
    expect(instance.settings.getCloudLink()).toBeUndefined();
    expect(instance.vault.get(`system/${CLOUD_LINK_KEY}`)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('an unregistration keeps the key; a link from before part 2 has none until a rotation mints one', () => {
    const { instance, link } = setup();
    const key = keyOf(link.link('octo-cat', 'admin'));
    instance.settings.setCloudLink({ ...instance.settings.getCloudLink()!, state: 'registered', registeredAt: '2026-10-17T08:00:00.000Z' });
    expect(link.unregister('octo-cat')).toBe('unregistered');
    expect(link.view().link?.linkKey).toEqual(key);

    link.unlink('admin');
    instance.settings.setCloudLink({ installId: instance.settings.instanceId(), account: 'octo-cat', state: 'pending', linkedAt: '2026-10-17T07:00:00.000Z', by: 'admin' });
    expect(link.view().link?.linkKey).toBeUndefined();
    expect(keyOf(link.rotateKey('admin'))?.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
