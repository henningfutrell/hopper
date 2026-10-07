// A machine's link to the hopper (design.md "Joining a machine", issue #308). The machine and the hopper
// each hold an X25519 **link key**: the machine's public half is its **machine key**, recorded on its
// machine instance when it joins; the hopper's public half is given to the machine in the join's answer.
// The **client token** both ends sign with (signature.ts) is derived on each end from its own private
// half and the other's public half — so neither stores a shared secret, and the token never crosses the
// wire. node:crypto's X25519 and HKDF: the client is installed as plain files, with no node_modules.
// Imports nothing of hopper: it is one of the client's files.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from 'node:crypto';

/** A link key: its private half (PKCS#8 PEM, never sent) and its public half (the raw 32 bytes, base64url). */
export interface LinkKey { privateKey: string; publicKey: string }

const PUBLIC = /^[A-Za-z0-9_-]{43}$/;

/** A new link key, from the OS random source. */
export function mintLinkKey(): LinkKey {
  const { privateKey } = generateKeyPairSync('x25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKey: pem, publicKey: publicKeyOf(pem) };
}

/** The public half of a link key's private half. */
export function publicKeyOf(privateKey: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKey)).export({ format: 'jwk' });
  return String(jwk.x);
}

/** Whether a string is a link key's public half. */
export const isPublicKey = (v: unknown): v is string => typeof v === 'string' && PUBLIC.test(v);

function publicKeyObject(publicKey: string): KeyObject {
  if (!isPublicKey(publicKey)) throw new Error(`not a link key: ${JSON.stringify(publicKey).slice(0, 60)}`);
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicKey }, format: 'jwk' });
  } catch {
    throw new Error(`not a link key: ${publicKey}`);
  }
}

/** The client token between the holder of `ownPrivateKey` and the holder of `otherPublicKey`: the same on both ends. */
export function linkToken(ownPrivateKey: string, otherPublicKey: string): string {
  const shared = diffieHellman({ privateKey: createPrivateKey(ownPrivateKey), publicKey: publicKeyObject(otherPublicKey) });
  return Buffer.from(hkdfSync('sha256', shared, 'hopper-link/1', 'client token', 32)).toString('base64url');
}

/** What a machine is given to join: the hopper's URL as the machine reaches it, and the one-time join code. */
export interface JoinLine { url: string; code: string }

const CODE = /^[0-9a-f]{64}$/;

/** `<hopper URL>#<join code>`, as the Add machine view shows it. Throws, saying what it must be. */
export function parseJoinLine(line: string): JoinLine {
  const at = line.lastIndexOf('#');
  const code = at < 0 ? '' : line.slice(at + 1);
  let url: URL | undefined;
  try { url = new URL(line.slice(0, at)); } catch { /* not a URL */ }
  if (!url || !/^https?:$/.test(url.protocol) || !CODE.test(code)) {
    throw new Error(`the join line must be <hopper URL>#<join code>, as Add machine shows it: ${JSON.stringify(line).slice(0, 120)}`);
  }
  return { url: url.origin, code };
}

/** The route a machine joins at, and the one it dials in at (an HTTP upgrade to this protocol). */
export const JOIN_PATH = '/client/join';
export const CONNECT_PATH = '/client/connect';
export const LINK_PROTOCOL = 'hopper-client/1';
/** On the dial-in: which user's machine, and its machine key. */
export const USER_HEADER = 'x-hopper-user';
export const MACHINE_KEY_HEADER = 'x-hopper-machine-key';
