// A fake passkey authenticator (issue #1380, design.md "Passkeys for local accounts"): what a browser and a platform
// authenticator answer to `navigator.credentials.create()` and `.get()`, made here with an EC P-256 key, so the daemon's
// WebAuthn checks (@simplewebauthn/server) run on real attestations and assertions. Attestation `none`; user presence and
// user verification set unless asked otherwise.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

const UP = 0x01, UV = 0x04, AT = 0x40;

/** What the daemon's options name: the challenge, the RP ID (`rp.id` when creating, `rpId` when getting). */
interface CreateOptions { challenge: string; rp: { id?: string }; user: { id: string } }
interface GetOptions { challenge: string; rpId?: string }

export interface FakePasskey {
  id: string;
  /** The answer to `navigator.credentials.create()` for these options, as @simplewebauthn/browser posts it. */
  create(options: CreateOptions, origin: string, o?: { userVerified?: boolean }): Record<string, unknown>;
  /** The answer to `navigator.credentials.get()` for these options. */
  get(options: GetOptions, origin: string, o?: { userVerified?: boolean; rpId?: string }): Record<string, unknown>;
}

export function fakePasskey(): FakePasskey {
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(16);
  const id = b64url(credentialId);
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  let counter = 0;
  let userHandle = '';
  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    create(options, origin, o = {}) {
      userHandle = options.user.id;
      const rpId = options.rp.id ?? new URL(origin).hostname;
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([UP | AT | (o.userVerified === false ? 0 : UV)]), u32(counter),
        Buffer.alloc(16), idLength, credentialId, Buffer.from(cose)]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64url(clientData('webauthn.create', options.challenge, origin)), attestationObject: b64url(attestationObject), transports: ['internal'] },
      };
    },
    get(options, origin, o = {}) {
      counter += 1;
      const rpId = o.rpId ?? options.rpId ?? new URL(origin).hostname;
      const authData = Buffer.concat([sha256(rpId), Buffer.from([UP | (o.userVerified === false ? 0 : UV)]), u32(counter)]);
      const cd = clientData('webauthn.get', options.challenge, origin);
      const signature = sign('sha256', Buffer.concat([authData, sha256(cd)]), privateKey);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64url(cd), authenticatorData: b64url(authData), signature: b64url(signature), userHandle },
      };
    },
  };
}
