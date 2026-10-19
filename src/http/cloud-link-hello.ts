// The cloud link's hello (issue #2039, design.md "The cloud link's connection"): the first message the instance sends on its
// connection to hopper.io, the answer to hopper.io's challenge. It names the instance (`installId`), the hopper.io account
// its link names, and the public half of its cloud link key, and proves the key: an Ed25519 signature over the challenge,
// the instance id, the account and the public key, under a fixed context, so a proof is good for one challenge only and
// for nothing else (docs/hopper-io-security.md R4). After a rotation, `previous` proves the key before over the same text,
// so hopper.io moves its registration to the new key; hopper.io keeps only public halves. Transport-free: the cloud link's
// agent hands hopper.io's first message to `challengeNonce` and sends `helloMessage`. hopper.io's side is cloud/hello.ts,
// a copy of these schemas that test/cloud/hello.test.ts holds to this one.
import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import type { CloudLinkSettings } from '../domain/cloud-link.ts';
import { CLOUD_MESSAGE_MAX_BYTES } from './cloud-link-messages.ts';

/** What a proof signs before the challenge: the protocol and its version, so a proof is never good elsewhere. */
export const HELLO_CONTEXT = 'hopper.io cloud link hello 1';
const B64URL = (n: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${n}}$`));
/** An Ed25519 public half (32 bytes) and a signature (64 bytes), base64url. */
const PUBLIC_KEY = B64URL(43);
const PROOF = B64URL(86);

/** hopper.io's challenge: 32 random bytes, base64url. */
export const CLOUD_CHALLENGE_SCHEMA = z.strictObject({ type: z.literal('challenge'), nonce: B64URL(43) });

/** The hello, closed. */
export const CLOUD_HELLO_SCHEMA = z.strictObject({
  type: z.literal('hello'),
  installId: z.string().regex(/^[0-9a-f]{16}$/),
  account: z.string().regex(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/),
  publicKey: PUBLIC_KEY,
  proof: PROOF,
  previous: z.strictObject({ publicKey: PUBLIC_KEY, proof: PROOF }).optional(),
});
export type CloudHello = z.infer<typeof CLOUD_HELLO_SCHEMA>;

/** The heartbeat, closed: when the instance sent it, nothing else. */
export const CLOUD_HEARTBEAT_SCHEMA = z.strictObject({ type: z.literal('heartbeat'), sentAt: z.iso.datetime() });

/** The text a proof signs. */
export const helloProofText = (o: { nonce: string; installId: string; account: string; publicKey: string }): string =>
  [HELLO_CONTEXT, o.nonce, o.installId, o.account, o.publicKey].join('\n');

/** The nonce of hopper.io's challenge, when `text` is one; else undefined. */
export function challengeNonce(text: string): string | undefined {
  if (Buffer.byteLength(text) > CLOUD_MESSAGE_MAX_BYTES) return undefined;
  try {
    const m = CLOUD_CHALLENGE_SCHEMA.safeParse(JSON.parse(text));
    return m.success ? m.data.nonce : undefined;
  } catch {
    return undefined;
  }
}

/** The proof of the key in `secret` (its JWK, as the vault keeps it) over `text`. */
const proofBy = (secret: string, text: string): string =>
  sign(null, Buffer.from(text), createPrivateKey({ key: JSON.parse(secret) as JsonWebKey, format: 'jwk' })).toString('base64url');

/**
 * The hello for `nonce`, for the link and its key: `secret` is the private half the vault keeps, `publicKey` the record's.
 * `previous`: the key before a rotation, still kept until the new one connected.
 */
export function helloMessage(o: {
  link: Pick<CloudLinkSettings, 'installId' | 'account'>; nonce: string; publicKey: string; secret: string;
  previous?: { publicKey: string; secret: string };
}): string {
  const text = helloProofText({ nonce: o.nonce, installId: o.link.installId, account: o.link.account, publicKey: o.publicKey });
  return JSON.stringify(CLOUD_HELLO_SCHEMA.parse({
    type: 'hello', installId: o.link.installId, account: o.link.account, publicKey: o.publicKey, proof: proofBy(o.secret, text),
    ...(o.previous ? { previous: { publicKey: o.previous.publicKey, proof: proofBy(o.previous.secret, text) } } : {}),
  }));
}

/** The heartbeat the instance sends at `now`. */
export const heartbeatMessage = (now: Date): string => JSON.stringify({ type: 'heartbeat', sentAt: now.toISOString() });
