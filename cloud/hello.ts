// hopper.io's side of the cloud link's hello (issue #2039, docs/design.md "The cloud link's connection"): the challenge
// hopper.io sends first on each connection, and the check of the instance's answer. The hello names the instance, the
// account its link names and the public half of its cloud link key, and proves the key with an Ed25519 signature over
// the challenge, the instance id, the account and the key, under a fixed context (R4). `previous` proves the key before a
// rotation over the same text. The schemas are a copy of the instance's (src/http/cloud-link-hello.ts): cloud/ may not
// import it, and test/cloud/hello.test.ts holds the two to one JSON Schema.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { z } from 'zod';
import { LINK_MESSAGE_MAX_BYTES } from './link.ts';

/** hopper.io's answer to a hello it took (issue #2039 part 2): the instance is connected from here on. Nothing else. */
export const CONNECTED = JSON.stringify({ type: 'connected' });

export const HELLO_CONTEXT = 'hopper.io cloud link hello 1';
const B64URL = (n: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${n}}$`));
const PUBLIC_KEY = B64URL(43);
const PROOF = B64URL(86);

export const HELLO_SCHEMA = z.strictObject({
  type: z.literal('hello'),
  installId: z.string().regex(/^[0-9a-f]{16}$/),
  account: z.string().regex(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/),
  publicKey: PUBLIC_KEY,
  proof: PROOF,
  previous: z.strictObject({ publicKey: PUBLIC_KEY, proof: PROOF }).optional(),
});
export const HEARTBEAT_SCHEMA = z.strictObject({ type: z.literal('heartbeat'), sentAt: z.iso.datetime() });
export const CHALLENGE_SCHEMA = z.strictObject({ type: z.literal('challenge'), nonce: B64URL(43) });

/** A hello whose proof holds: the instance, its link's account, its key, and the key before a rotation when it proved that too. */
export interface ProvedHello { installId: string; account: string; publicKey: string; previousKey?: string }

/** A new challenge: its nonce, and the message that carries it. */
export function challenge(): { nonce: string; text: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, text: JSON.stringify({ type: 'challenge', nonce }) };
}

/** Whether `proof` is the signature of the Ed25519 key `publicKey` over `text`. */
function proves(publicKey: string, proof: string, text: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return verify(null, Buffer.from(text), key, Buffer.from(proof, 'base64url'));
  } catch {
    return false;
  }
}

/** The hello in `text` for the challenge `nonce`, when it is JSON of at most LINK_MESSAGE_MAX_BYTES in the closed schema
 * and its proof holds; a `previous` whose proof fails is no hello at all. Else undefined. */
export function provedHello(text: string, nonce: string): ProvedHello | undefined {
  if (Buffer.byteLength(text) > LINK_MESSAGE_MAX_BYTES) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  const m = HELLO_SCHEMA.safeParse(raw);
  if (!m.success) return undefined;
  const h = m.data;
  const signed = [HELLO_CONTEXT, nonce, h.installId, h.account, h.publicKey].join('\n');
  if (!proves(h.publicKey, h.proof, signed)) return undefined;
  if (h.previous && !proves(h.previous.publicKey, h.previous.proof, signed)) return undefined;
  return { installId: h.installId, account: h.account, publicKey: h.publicKey, ...(h.previous ? { previousKey: h.previous.publicKey } : {}) };
}
