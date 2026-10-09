// The sealer (issue #451, design.md "Secrets"): a secret the hopper owns is kept in the database sealed, and
// opened only where it is used. The master key is the runtime's HOPPER_TOKEN_KEY (the token key): it never
// reaches the database, so a dump or backup of it holds no usable secret. Each value is sealed under a key
// of its own, derived from the master key and a fresh 32-byte salt (HKDF-SHA256), with AES-256-GCM and a
// fresh 12-byte nonce. The context — where the value is kept, e.g. `webhook:<id>/signing-secret` — is bound
// to it twice, in the derivation and as authenticated data: a value copied to another place does not open.
// The value is padded to a block of 64 bytes, so its length does not show. Each sealed text names the
// master key's id (a fingerprint, never the key), so a new key can be given while the old one, as
// HOPPER_TOKEN_KEY_PREVIOUS, still opens what it sealed until it is sealed again.
//
//   hs1.<key id>.<salt>.<nonce>.<ciphertext ‖ tag>     (base64url)
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { decodeKey, PREVIOUS_KEYS_VARIABLE, TOKEN_KEY_VARIABLE } from './token-box.ts';
import type { RuntimeSecrets } from './runtime.ts';

export { PREVIOUS_KEYS_VARIABLE };

const VERSION = 'hs1';
const SALT = 32;
const NONCE = 12;
const TAG = 16;
const BLOCK = 64;
const LENGTH = 4;

/** A sealed value that cannot be opened: no key, another key, altered, or moved. Never "no secret". */
export class SecretUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnreadable';
  }
}

/**
 * The key provider (issue #558): the one seam a vault secret, a webhook signing secret and anything else sealed reach
 * their key through. The sealer below, under the runtime's token key, is the local default and the only one built; a key
 * service (KMS) would be another implementation, never a requirement (design.md "The key provider").
 */
export interface Sealer {
  /** The current master key's id: 16 hex digits of HMAC-SHA256(key, a fixed label). */
  readonly keyId: string;
  /** `value` sealed for `context`, under the current master key. */
  seal(value: string, context: string): string;
  /** The value sealed for `context`; throws SecretUnreadable. */
  open(sealed: string, context: string): string;
  /** Whether `sealed` is under the current master key (else: open it and seal it again). */
  current(sealed: string): boolean;
}

const idOf = (key: Buffer): string => createHmac('sha256', key).update('hopper master key id v1').digest().subarray(0, 8).toString('hex');

/** The key one value is sealed under: the master key, its salt and its context. */
const valueKey = (key: Buffer, salt: Buffer, context: string): Buffer =>
  Buffer.from(hkdfSync('sha256', key, salt, `hopper sealed secret v1\0${context}`, 32));

const aad = (keyId: string, context: string): Buffer => Buffer.from(`${VERSION}\0${keyId}\0${context}`, 'utf8');

/** The value with its length first, zero-padded to a whole number of blocks. */
function pad(value: string): Buffer {
  const text = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(Math.ceil((LENGTH + text.length + 1) / BLOCK) * BLOCK);
  out.writeUInt32BE(text.length, 0);
  text.copy(out, LENGTH);
  text.fill(0);
  return out;
}

function unpad(padded: Buffer): string {
  const length = padded.readUInt32BE(0);
  if (LENGTH + length > padded.length) throw new SecretUnreadable('a stored secret cannot be opened: its padding is broken');
  return padded.subarray(LENGTH, LENGTH + length).toString('utf8');
}

function keyOf(text: string, variable: string): Buffer {
  const key = decodeKey(text);
  if (!key) throw new Error(`${variable} must be 32 bytes, as 64 hex digits or base64 (openssl rand -hex 32)`);
  return key;
}

/** A sealer under `key` (64 hex digits or base64 of 32 bytes); `previous` keys only open. Throws on a key that is no key. */
export function createSealer(key: string, previous: readonly string[] = []): Sealer {
  const master = keyOf(key, TOKEN_KEY_VARIABLE);
  const keyId = idOf(master);
  const keys = new Map<string, Buffer>([[keyId, master]]);
  for (const p of previous) {
    const k = keyOf(p, PREVIOUS_KEYS_VARIABLE);
    if (!keys.has(idOf(k))) keys.set(idOf(k), k);
  }

  return {
    keyId,
    seal(value, context) {
      const salt = randomBytes(SALT);
      const nonce = randomBytes(NONCE);
      const k = valueKey(master, salt, context);
      const plain = pad(value);
      try {
        const cipher = createCipheriv('aes-256-gcm', k, nonce);
        cipher.setAAD(aad(keyId, context));
        const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
        return [VERSION, keyId, salt.toString('base64url'), nonce.toString('base64url'), body.toString('base64url')].join('.');
      } finally {
        k.fill(0);
        plain.fill(0);
      }
    },
    open(sealed, context) {
      const parts = sealed.split('.');
      if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretUnreadable('a stored secret cannot be opened: it is not a sealed secret');
      const [, id, salt64, nonce64, body64] = parts as [string, string, string, string, string];
      const master = keys.get(id);
      if (!master) {
        throw new SecretUnreadable(`a stored secret cannot be opened: it was sealed under key ${id}, which neither ${TOKEN_KEY_VARIABLE} nor ${PREVIOUS_KEYS_VARIABLE} gives`);
      }
      const salt = Buffer.from(salt64, 'base64url');
      const nonce = Buffer.from(nonce64, 'base64url');
      const body = Buffer.from(body64, 'base64url');
      if (salt.length !== SALT || nonce.length !== NONCE || body.length < TAG + BLOCK) {
        throw new SecretUnreadable('a stored secret cannot be opened: it was altered');
      }
      const k = valueKey(master, salt, context);
      let plain: Buffer | undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, nonce);
        decipher.setAAD(aad(id, context));
        decipher.setAuthTag(body.subarray(body.length - TAG));
        plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG)), decipher.final()]);
        return unpad(plain);
      } catch (e) {
        if (e instanceof SecretUnreadable) throw e;
        throw new SecretUnreadable('a stored secret cannot be opened: it was altered, or it belongs to another place');
      } finally {
        k.fill(0);
        plain?.fill(0);
      }
    },
    current: (sealed) => sealed.split('.')[1] === keyId,
  };
}

/** The sealer under the runtime's keys, or why there is none. */
export interface SealerState {
  sealer?: Sealer;
  /** Set when there is no sealer: what to give the runtime. */
  problem?: string;
}

/**
 * The sealer under the runtime's HOPPER_TOKEN_KEY and HOPPER_TOKEN_KEY_PREVIOUS (each also `_FILE`). No key:
 * no sealer, and a problem saying so — nothing the hopper owns is then stored, and a stored one is not opened.
 * A key that is no key throws, so the daemon does not start on it (fails closed).
 */
export function sealerOf(secret: RuntimeSecrets): SealerState {
  const key = secret(TOKEN_KEY_VARIABLE);
  if (!key) return { problem: `${TOKEN_KEY_VARIABLE} is not set (docs/deploy.md "What every deploy needs")` };
  const previous = (secret(PREVIOUS_KEYS_VARIABLE) ?? '').split(/[\s,]+/).filter(Boolean);
  return { sealer: createSealer(key, previous) };
}
