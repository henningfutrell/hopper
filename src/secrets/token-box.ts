// The token box (issue #441, design.md "Secrets"): a connected account's access and refresh tokens are the
// one GitHub credential the hopper keeps, so they are sealed at rest with AES-256-GCM (node:crypto) under
// the runtime's HOPPER_TOKEN_KEY: a dump or backup of the database holds no usable token. The key comes
// from the runtime like every other secret; without one the tokens are kept in clear and the daemon says
// so at start. `sealed:v1:` + base64url(nonce ‖ tag ‖ ciphertext), a fresh 12-byte nonce per seal.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const TOKEN_KEY_VARIABLE = 'HOPPER_TOKEN_KEY';

const PREFIX = 'sealed:v1:';
const NONCE = 12;
const TAG = 16;

export interface TokenBox {
  isSealed(value: string): boolean;
  seal(token: string): string;
  /** The token; throws when it was altered or sealed under another key. */
  open(sealed: string): string;
}

/** The 32 bytes of a key given as 64 hex digits or base64, or undefined. The sealer reads the same key (issue #451). */
export const decodeKey = (key: string): Buffer | undefined => {
  const bytes = /^[0-9a-fA-F]{64}$/.test(key) ? Buffer.from(key, 'hex')
    : /^[A-Za-z0-9+/_-]+={0,2}$/.test(key) ? Buffer.from(key, key.includes('-') || key.includes('_') ? 'base64url' : 'base64') : undefined;
  return bytes?.length === 32 ? bytes : undefined;
};

/** Why `key` is no HOPPER_TOKEN_KEY, or undefined. */
export const tokenKeyProblem = (key: string): string | undefined =>
  decodeKey(key) ? undefined : 'must be 32 bytes, as 64 hex digits or base64 (openssl rand -hex 32)';

export const isSealed = (value: string): boolean => value.startsWith(PREFIX);

export function createTokenBox(key: string): TokenBox {
  const k = decodeKey(key);
  if (!k) throw new Error(`${TOKEN_KEY_VARIABLE} ${tokenKeyProblem(key)}`);
  return {
    isSealed,
    seal(token) {
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv('aes-256-gcm', k, nonce);
      const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
    },
    open(sealed) {
      const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, raw.subarray(0, NONCE));
        decipher.setAuthTag(raw.subarray(NONCE, NONCE + TAG));
        return Buffer.concat([decipher.update(raw.subarray(NONCE + TAG)), decipher.final()]).toString('utf8');
      } catch {
        throw new Error(`a stored token cannot be opened: it was altered, or sealed under another ${TOKEN_KEY_VARIABLE}`);
      }
    },
  };
}

/**
 * The box under the runtime's HOPPER_TOKEN_KEY: a key that is no key throws (the runtime fails closed);
 * none answers undefined, and the tokens are kept in clear, said once in the log.
 */
export function tokenBoxOf(secret: (name: string) => string | undefined, logger: { warn(line: string): void }): TokenBox | undefined {
  const key = secret(TOKEN_KEY_VARIABLE);
  if (key) return createTokenBox(key);
  logger.warn(`hopper: ${TOKEN_KEY_VARIABLE} is not set: the connected account's tokens are kept in the database in clear (docs/deploy.md)`);
  return undefined;
}
