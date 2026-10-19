// The cloud link's hello (issue #2039, docs/design.md "The cloud link's connection"): the instance answers hopper.io's challenge
// with its instance id, its link's account and the public half of its Ed25519 cloud link key, and proves the key over the
// challenge (docs/hopper-io-security.md R4). hopper.io checks the proof and keeps only the public half. Both sides, no
// transport: the instance's hello (src/http/cloud-link-hello.ts) checked by hopper.io's (cloud/hello.ts).
//   Scenario: hopper.io takes the hello the instance makes for its challenge, and the key it names
//   Scenario: a hello for another challenge, with a field changed, another key's proof or a key outside the schema is refused
//   Scenario: after a rotation the hello proves the key before too; a wrong proof of it refuses the whole hello
//   Scenario: the instance takes only a challenge of the closed shape
//   Scenario: both sides use one schema, and a hello fits the 1024-byte cap; hopper.io answers an accepted hello `connected`
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CHALLENGE_SCHEMA, challenge, CONNECTED, HEARTBEAT_SCHEMA, HELLO_CONTEXT, HELLO_SCHEMA, provedHello } from '../../cloud/hello.ts';
import { LINK_MESSAGE_MAX_BYTES } from '../../cloud/link.ts';
import {
  challengeNonce, CLOUD_CHALLENGE_SCHEMA, CLOUD_CONNECTED, CLOUD_HEARTBEAT_SCHEMA, CLOUD_HELLO_SCHEMA, HELLO_CONTEXT as INSTANCE_CONTEXT, heartbeatMessage, helloMessage,
} from '../../src/http/cloud-link-hello.ts';

/** A cloud link key as the instance keeps it: the vault's JWK, and the record's public half. */
function key(): { secret: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { d, x } = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return { secret: JSON.stringify({ d, x, crv: 'Ed25519', kty: 'OKP' }), publicKey: x };
}
const link = { installId: '7f0c2a4e1d1b4c55', account: 'octo-cat' };

describe("the cloud link's hello", () => {
  it('hopper.io takes the hello the instance makes for its challenge, and the key it names', () => {
    const k = key();
    const c = challenge();
    const nonce = challengeNonce(c.text)!;
    expect(nonce).toBe(c.nonce);
    const hello = helloMessage({ link, nonce, ...k });
    expect(provedHello(hello, c.nonce)).toEqual({ ...link, publicKey: k.publicKey });
    expect(hello).not.toContain(JSON.parse(k.secret).d);
  });

  it('a hello for another challenge, with a field changed, another key\'s proof or a key outside the schema is refused', () => {
    const k = key();
    const c = challenge();
    const hello = JSON.parse(helloMessage({ link, nonce: c.nonce, ...k })) as Record<string, string>;
    expect(provedHello(JSON.stringify(hello), challenge().nonce)).toBeUndefined();
    expect(provedHello(JSON.stringify({ ...hello, account: 'grace' }), c.nonce)).toBeUndefined();
    expect(provedHello(JSON.stringify({ ...hello, installId: '0b9e8d7c6a5f4e3d' }), c.nonce)).toBeUndefined();
    expect(provedHello(JSON.stringify({ ...hello, publicKey: key().publicKey }), c.nonce)).toBeUndefined();
    const other = JSON.parse(helloMessage({ link, nonce: c.nonce, ...key() })) as Record<string, string>;
    expect(provedHello(JSON.stringify({ ...hello, proof: other.proof }), c.nonce)).toBeUndefined();
    expect(provedHello(JSON.stringify({ ...hello, label: 'kitchen' }), c.nonce)).toBeUndefined();
    expect(provedHello('not json', c.nonce)).toBeUndefined();
    expect(provedHello(JSON.stringify({ ...hello, account: 'x'.repeat(2000) }), c.nonce)).toBeUndefined();
  });

  it('after a rotation the hello proves the key before too; a wrong proof of it refuses the whole hello', () => {
    const before = key();
    const now = key();
    const c = challenge();
    const hello = helloMessage({ link, nonce: c.nonce, ...now, previous: before });
    expect(provedHello(hello, c.nonce)).toEqual({ ...link, publicKey: now.publicKey, previousKey: before.publicKey });
    const forged = JSON.parse(hello) as { previous: { publicKey: string } };
    forged.previous.publicKey = key().publicKey;
    expect(provedHello(JSON.stringify(forged), c.nonce)).toBeUndefined();
  });

  it('the instance takes only a challenge of the closed shape', () => {
    expect(challengeNonce(JSON.stringify({ type: 'challenge', nonce: 'a'.repeat(43) }))).toBe('a'.repeat(43));
    expect(challengeNonce(JSON.stringify({ type: 'challenge', nonce: 'a'.repeat(42) }))).toBeUndefined();
    expect(challengeNonce(JSON.stringify({ type: 'challenge', nonce: 'a'.repeat(43), run: 'x' }))).toBeUndefined();
    expect(challengeNonce(JSON.stringify({ type: 'register', code: 'c', account: 'a' }))).toBeUndefined();
    expect(challengeNonce('{')).toBeUndefined();
  });

  it('both sides use one schema, and a hello fits the 1024-byte cap; hopper.io answers an accepted hello `connected`', () => {
    expect(CONNECTED).toBe(CLOUD_CONNECTED);
    expect(JSON.parse(CONNECTED)).toEqual({ type: 'connected' });
    expect(z.toJSONSchema(HELLO_SCHEMA)).toEqual(z.toJSONSchema(CLOUD_HELLO_SCHEMA));
    expect(z.toJSONSchema(CHALLENGE_SCHEMA)).toEqual(z.toJSONSchema(CLOUD_CHALLENGE_SCHEMA));
    expect(z.toJSONSchema(HEARTBEAT_SCHEMA)).toEqual(z.toJSONSchema(CLOUD_HEARTBEAT_SCHEMA));
    expect(HELLO_CONTEXT).toBe(INSTANCE_CONTEXT);
    const largest = helloMessage({ link: { installId: link.installId, account: 'a'.repeat(39) }, nonce: challenge().nonce, ...key(), previous: key() });
    expect(Buffer.byteLength(largest)).toBeLessThan(LINK_MESSAGE_MAX_BYTES / 2);
    expect(HEARTBEAT_SCHEMA.parse(JSON.parse(heartbeatMessage(new Date('2026-10-19T12:00:00Z'))))).toEqual({ type: 'heartbeat', sentAt: '2026-10-19T12:00:00.000Z' });
  });
});
