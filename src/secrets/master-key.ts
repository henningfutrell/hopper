// The master key (issue #659, design.md "Secrets"): the key every secret the hopper keeps is sealed under. It comes
// from the launch, as HOPPER_MASTER_KEY, and never from a file or a volume: a container is ephemeral, and a key kept
// beside it is lost with it. The database keeps the key's fingerprint — an HMAC of a fixed label under the key, never
// the key — and each start checks the key against it: a wrong key stops the hopper. A fresh hopper given no key makes
// one, shown once; a hopper that keeps secrets and is given no key starts limited: nothing is opened, nothing is made
// again. The old token key (HOPPER_TOKEN_KEY, or the file HOPPER_TOKEN_KEY_FILE names, the compose secrets volume's
// `token_key`) is read only to move an install to HOPPER_MASTER_KEY, and not once that is set.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSealer } from './sealer.ts';
import { createTokenBox, decodeKey, MASTER_KEY_VARIABLE, PREVIOUS_KEYS_VARIABLE } from './token-box.ts';

/** The old token key's variables: read only to move an install from them. */
export const OLD_KEY_VARIABLE = 'HOPPER_TOKEN_KEY';
const OLD_PREVIOUS_VARIABLE = `${OLD_KEY_VARIABLE}_PREVIOUS`;

/** Every variable the master key may come in (or was once given in): none of them reaches a part or a child process. */
export const MASTER_KEY_VARIABLES = [
  MASTER_KEY_VARIABLE, `${MASTER_KEY_VARIABLE}_FILE`, PREVIOUS_KEYS_VARIABLE, `${PREVIOUS_KEYS_VARIABLE}_FILE`,
  OLD_KEY_VARIABLE, `${OLD_KEY_VARIABLE}_FILE`, OLD_PREVIOUS_VARIABLE, `${OLD_PREVIOUS_VARIABLE}_FILE`,
] as const;

/** The key's fingerprint: HMAC-SHA256 under the key of a fixed label, as 64 hex digits. */
export function fingerprintOf(key: string): string {
  const bytes = decodeKey(key);
  if (!bytes) throw new Error(`${MASTER_KEY_VARIABLE} must be 32 bytes, as 64 hex digits or base64 (openssl rand -hex 32)`);
  return createHmac('sha256', bytes).update('hopper master key fingerprint v1').digest('hex');
}

/** The short form of a fingerprint people compare. */
export const shortFingerprint = (fingerprint: string): string => fingerprint.slice(0, 16);

/** The given key does not match the database's fingerprint: the hopper does not start on it. */
export class MasterKeyMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyMismatch';
  }
}

/** What the database seals under the master key: the sealed values' key ids, and the sealed tokens (InstanceStore.keptSecrets). */
export interface KeptSecrets {
  keyIds: readonly string[];
  tokens: readonly string[];
}

/**
 * The master key this start runs on. `given`: HOPPER_MASTER_KEY. `generated`: made now, on a fresh hopper: shown once,
 * to be given as HOPPER_MASTER_KEY. `old-token-key`: read from the old token key, to be given as HOPPER_MASTER_KEY.
 * `missing`: none, while the database keeps secrets: the hopper starts limited.
 */
export type MasterKey =
  | { source: 'given' | 'generated' | 'old-token-key'; key: string; previous: string[]; fingerprint: string; notes: string[] }
  | { source: 'missing'; problem: string; fingerprint?: string };

export interface MasterKeyRecord {
  fingerprint(): string | undefined;
  setFingerprint(fingerprint: string): void;
}

const listOf = (text: string | undefined): string[] => (text ?? '').split(/[\s,]+/).filter(Boolean);

/** The old token key, or undefined; a file that is not there is no key. */
function oldKey(env: Record<string, string | undefined>, read: (path: string) => string): string | undefined {
  if (env[OLD_KEY_VARIABLE]) return env[OLD_KEY_VARIABLE];
  const file = env[`${OLD_KEY_VARIABLE}_FILE`];
  if (!file) return undefined;
  try {
    return read(file).trim() || undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${OLD_KEY_VARIABLE}_FILE: cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { cause: e });
  }
}

/** Whether `keys` (the current one first) seal any kept secret; true when none is kept. */
function seals(keys: readonly string[], kept: KeptSecrets): boolean {
  if (kept.keyIds.length === 0 && kept.tokens.length === 0) return true;
  const ids = new Set(keys.map((k) => createSealer(k).keyId));
  if (kept.keyIds.some((id) => ids.has(id))) return true;
  return kept.tokens.some((t) => keys.some((k) => {
    try {
      createTokenBox(k).open(t);
      return true;
    } catch {
      return false;
    }
  }));
}

/** How to give the key: the line every message about a missing key ends with. */
export const GIVE_MASTER_KEY = `give it as ${MASTER_KEY_VARIABLE} at launch and restart (docs/deploy.md "The master key")`;

/**
 * The master key from the launch, checked against the database's fingerprint. Throws MasterKeyMismatch on a wrong key;
 * throws on a key that is no key and on HOPPER_MASTER_KEY_FILE (the key is never read from a file).
 */
export function resolveMasterKey(o: {
  env: Record<string, string | undefined>;
  record: MasterKeyRecord;
  /** What the database seals under the master key: read only when no fingerprint is recorded. */
  kept: () => KeptSecrets;
  readFile?: (path: string) => string;
}): MasterKey {
  const { env, record } = o;
  if (env[`${MASTER_KEY_VARIABLE}_FILE`]) throw new Error(`${MASTER_KEY_VARIABLE}_FILE is not read: the master key never comes from a file; give the key as ${MASTER_KEY_VARIABLE}`);
  const recorded = record.fingerprint();
  const read = o.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const given = env[MASTER_KEY_VARIABLE] || undefined;

  if (given !== undefined) {
    const fingerprint = fingerprintOf(given);
    const previous = listOf(env[PREVIOUS_KEYS_VARIABLE]);
    for (const p of previous) fingerprintOf(p);
    const notes: string[] = [];
    if (recorded === undefined) {
      if (!seals([given, ...previous], o.kept())) {
        throw new MasterKeyMismatch(`the master key does not match this database: ${MASTER_KEY_VARIABLE} (fingerprint ${shortFingerprint(fingerprint)}) seals none of the secrets it keeps. Give the key they were sealed under`);
      }
      record.setFingerprint(fingerprint);
    } else if (recorded !== fingerprint) {
      if (!previous.some((p) => fingerprintOf(p) === recorded)) {
        throw new MasterKeyMismatch(`the master key does not match this database: it was set up with the key of fingerprint ${shortFingerprint(recorded)}, and ${MASTER_KEY_VARIABLE} has fingerprint ${shortFingerprint(fingerprint)}. Give the right key; nothing was changed`);
      }
      record.setFingerprint(fingerprint);
      notes.push(`the master key is new (fingerprint ${shortFingerprint(fingerprint)}): what the old one sealed is sealed again under it`);
    }
    const old = oldKey(env, read);
    if (old !== undefined) {
      notes.push(old === given
        ? `the old token key (${OLD_KEY_VARIABLE}, or the secrets volume's token_key) is not read any more: it can be removed`
        : `the old token key (${OLD_KEY_VARIABLE}, or the secrets volume's token_key) is not read: ${MASTER_KEY_VARIABLE} is set`);
    }
    return { source: 'given', key: given, previous, fingerprint, notes };
  }

  const old = oldKey(env, read);
  if (old !== undefined) {
    const fingerprint = fingerprintOf(old);
    const previous = listOf(env[OLD_PREVIOUS_VARIABLE]);
    const matches = recorded === undefined ? seals([old, ...previous], o.kept()) : recorded === fingerprint;
    if (!matches) {
      return {
        source: 'missing',
        ...(recorded ? { fingerprint: recorded } : {}),
        problem: `the old token key does not match this database (fingerprint ${shortFingerprint(fingerprint)}): the secrets stay closed. Find the key they were sealed under and ${GIVE_MASTER_KEY}`,
      };
    }
    if (recorded === undefined) record.setFingerprint(fingerprint);
    return { source: 'old-token-key', key: old, previous, fingerprint, notes: [] };
  }

  if (recorded !== undefined) {
    return { source: 'missing', fingerprint: recorded, problem: `the master key is missing: this database keeps secrets sealed under the key of fingerprint ${shortFingerprint(recorded)}; ${GIVE_MASTER_KEY}` };
  }
  const kept = o.kept();
  if (kept.keyIds.length > 0 || kept.tokens.length > 0) {
    return { source: 'missing', problem: `the master key is missing: this database keeps secrets sealed under a key the launch does not give; ${GIVE_MASTER_KEY}` };
  }
  const key = randomBytes(32).toString('hex');
  const fingerprint = fingerprintOf(key);
  record.setFingerprint(fingerprint);
  return { source: 'generated', key, previous: [], fingerprint, notes: [] };
}

/**
 * `env` as the parts read it: the master key and its previous keys as resolved (none when `key` is undefined), and none
 * of the files or old variables. Every other variable is `env`'s, read live.
 */
export function withMasterKey(env: Record<string, string | undefined>, key: { key: string; previous: readonly string[] } | undefined): Record<string, string | undefined> {
  const over: Record<string, string | undefined> = Object.fromEntries(MASTER_KEY_VARIABLES.map((n) => [n, undefined]));
  if (key) {
    over[MASTER_KEY_VARIABLE] = key.key;
    if (key.previous.length) over[PREVIOUS_KEYS_VARIABLE] = key.previous.join('\n');
  }
  return new Proxy(env, {
    get: (target, name) => (typeof name === 'string' && name in over ? over[name] : target[name as string]),
  });
}

/**
 * The key a part that records no fingerprint reads (the vault container, issue #586): HOPPER_MASTER_KEY, else the old
 * token key while the install is moved from it; undefined: none. Throws as resolveMasterKey does on a file or no key.
 */
export function launchKey(env: Record<string, string | undefined>, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): { key: string; previous: string[] } | undefined {
  if (env[`${MASTER_KEY_VARIABLE}_FILE`]) throw new Error(`${MASTER_KEY_VARIABLE}_FILE is not read: the master key never comes from a file; give the key as ${MASTER_KEY_VARIABLE}`);
  const given = env[MASTER_KEY_VARIABLE] || undefined;
  const key = given ?? oldKey(env, read);
  if (key === undefined) return undefined;
  fingerprintOf(key);
  return { key, previous: listOf(env[given !== undefined ? PREVIOUS_KEYS_VARIABLE : OLD_PREVIOUS_VARIABLE]) };
}

/** Why `key` is not the key the database's fingerprint names, or undefined when it is (or none is recorded yet). */
export function mismatchOf(key: { key: string; previous: readonly string[] }, recorded: string | undefined): string | undefined {
  if (recorded === undefined || [key.key, ...key.previous].some((k) => fingerprintOf(k) === recorded)) return undefined;
  return `the master key does not match this database: it was set up with the key of fingerprint ${shortFingerprint(recorded)}, and this one has fingerprint ${shortFingerprint(fingerprintOf(key.key))}`;
}

/** The start's lines about the master key: the key itself once, to save now; a limited start, loud; the notes. */
export function logMasterKey(key: MasterKey, saved: boolean, logger: { info(line: string): void; warn(line: string): void }): void {
  if (key.source === 'missing') {
    logger.warn(`hopper: LIMITED: ${key.problem}. Nothing is deleted, and what needs a secret stays off until then`);
    return;
  }
  for (const note of key.notes) logger.info(`hopper: ${note}`);
  if (key.source === 'given') return;
  const fingerprint = shortFingerprint(key.fingerprint);
  if (!saved) {
    const what = key.source === 'generated' ? 'made for this new hopper' : 'read from the old token key';
    logger.warn(`hopper: SAVE THIS NOW: the master key, ${what} (fingerprint ${fingerprint}): ${key.key}`);
    logger.warn('hopper: keep it in a password manager: every secret the hopper keeps is sealed under it, and without it a new container opens none of them');
  }
  logger.warn(`hopper: give the master key as ${MASTER_KEY_VARIABLE} at each launch (docs/deploy.md "The master key"): ${key.source === 'generated'
    ? 'a start without it is limited'
    : 'until then it is read from the old token key, and the secrets volume cannot be removed'}`);
}
