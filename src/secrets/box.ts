// The secret box (design.md "Secrets at rest", issue #53): a secret the hopper itself keeps — a
// webhook subscription's generated secret, wherever it is stored — is sealed with AES-256-GCM
// (node:crypto) under JOB_HOPPER_SECRET_KEY, so a database dump or backup holds no secret in clear.
// `sealed:v1:` + base64url(nonce ‖ tag ‖ ciphertext); a fresh 12-byte nonce per seal.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretBox } from '../domain/ports.ts';

const PREFIX = 'sealed:v1:';
const NONCE = 12;
const TAG = 16;

const decodeKey = (key: string): Buffer | undefined => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(key)) return undefined;
  const bytes = Buffer.from(key, key.includes('-') || key.includes('_') ? 'base64url' : 'base64');
  return bytes.length === 32 ? bytes : undefined;
};

/** Why `key` is not a JOB_HOPPER_SECRET_KEY, or undefined. */
export const secretKeyProblem = (key: string): string | undefined =>
  decodeKey(key) ? undefined : 'must be 32 bytes, base64 (openssl rand -base64 32)';

export function createSecretBox(key: string): SecretBox {
  const k = decodeKey(key);
  if (!k) throw new Error(`JOB_HOPPER_SECRET_KEY ${secretKeyProblem(key)}`);
  const isSealed = (value: string): boolean => value.startsWith(PREFIX);
  return {
    isSealed,
    seal(secret) {
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv('aes-256-gcm', k, nonce);
      const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
    },
    unseal(value) {
      if (!isSealed(value)) throw new Error('not a sealed secret');
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, raw.subarray(0, NONCE));
        decipher.setAuthTag(raw.subarray(NONCE, NONCE + TAG));
        return Buffer.concat([decipher.update(raw.subarray(NONCE + TAG)), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('cannot unseal a stored secret: it was altered, or sealed under another JOB_HOPPER_SECRET_KEY');
      }
    },
  };
}
