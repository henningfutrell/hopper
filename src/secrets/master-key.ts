// The master key (issue #659, design.md "Secrets"): the key every secret the hopper keeps is sealed under. It comes
// from the launch, as HOPPER_MASTER_KEY, or as the file HOPPER_MASTER_KEY_FILE names — a Secret the cluster mounts
// (issue #1288) — and never from a volume of the hopper's own: a container is ephemeral, and a key kept beside it is
// lost with it. A key file named but not there stops the start. The database keeps the key's fingerprint — an HMAC of a fixed label under the key, never
// the key — and each start checks the key against it: a wrong key stops the hopper. A fresh hopper given no key makes
// one, shown once; a hopper that keeps secrets and is given no key does not start (issue #1296: never limited), and its
// error names the fingerprint of the key it needs. A key sealed to the host (scripts/master-key.sh) is unsealed by the
// launch and given as HOPPER_MASTER_KEY. The old token key (HOPPER_TOKEN_KEY, or the file HOPPER_TOKEN_KEY_FILE names, the compose secrets volume's
// `token_key`) is read only to move an install to HOPPER_MASTER_KEY, and not once that is set.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logMask, type LogMask } from './log-mask.ts';
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

/** No key is given, and the database keeps secrets (issue #1296): the hopper does not start. */
export class MasterKeyMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyMissing';
  }
}

/** What the database seals under the master key: the sealed values' key ids, and the sealed tokens (InstanceStore.keptSecrets). */
export interface KeptSecrets {
  keyIds: readonly string[];
  tokens: readonly string[];
}

/**
 * The master key this hopper runs on. `given`: HOPPER_MASTER_KEY. `generated`: made now, on a fresh hopper: shown once,
 * to be given as HOPPER_MASTER_KEY. `old-token-key`: read from the old token key, to be given as HOPPER_MASTER_KEY.
 * `rotated`: made by a rotation in this run, shown once, to be given as HOPPER_MASTER_KEY before the next start.
 * There is no hopper without a key: resolveMasterKey throws instead (issue #1296).
 */
export interface MasterKey { source: 'given' | 'generated' | 'old-token-key' | 'rotated'; key: string; previous: string[]; fingerprint: string; notes: string[] }

export interface MasterKeyRecord {
  fingerprint(): string | undefined;
  setFingerprint(fingerprint: string): void;
  /** The last rotation: the fingerprint of the key it replaced, and when (issue #659). */
  rotation?(): { from: string; at: string } | undefined;
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

/**
 * The key and previous keys the launch gives (issue #1288): each from its variable, else from the file its `_FILE`
 * variable names (a mounted Secret). A key file named that cannot be read or is empty stops the start; a previous-keys
 * file that is not there gives none (a Secret with no `previous`). Both the variable and its file: refused.
 */
function launchGiven(env: Record<string, string | undefined>, read: (path: string) => string): { key: string | undefined; previous: string[] } {
  const fromFile = (name: string, required: boolean): string | undefined => {
    const value = env[name] || undefined;
    const file = env[`${name}_FILE`] || undefined;
    if (value !== undefined && file !== undefined) throw new Error(`${name} and ${name}_FILE are both set; set one`);
    if (file === undefined) return value;
    let text: string;
    try {
      text = read(file).trim();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!required && code === 'ENOENT') return undefined;
      throw new Error(`${name}_FILE: cannot read ${file}: ${code ?? (e as Error).message}${required ? '; the hopper does not start without the master key it names' : ''}`, { cause: e });
    }
    if (required && !text) throw new Error(`${name}_FILE: ${file} is empty; the hopper does not start without the master key it names`);
    return text || undefined;
  };
  return { key: fromFile(MASTER_KEY_VARIABLE, true), previous: listOf(fromFile(PREVIOUS_KEYS_VARIABLE, false)) };
}

/** How to give the key: the line every message about a missing key ends with. */
export const GIVE_MASTER_KEY = `give it as ${MASTER_KEY_VARIABLE} at launch, or start with the key sealed to this host (bash master-key.sh run …), and start again (docs/deploy.md "The master key")`;

/**
 * The master key from the launch, checked against the database's fingerprint. Throws MasterKeyMismatch on a wrong key,
 * MasterKeyMissing on no key while the database keeps secrets (issue #1296); throws on a key that is no key and on a key
 * file named that cannot be read.
 */
export function resolveMasterKey(o: {
  env: Record<string, string | undefined>;
  record: MasterKeyRecord;
  /** What the database seals under the master key: read only when no fingerprint is recorded. */
  kept: () => KeptSecrets;
  readFile?: (path: string) => string;
}): MasterKey {
  const { env, record } = o;
  const read = o.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const { key: given, previous } = launchGiven(env, read);
  const recorded = record.fingerprint();

  if (given !== undefined) {
    const fingerprint = fingerprintOf(given);
    for (const p of previous) fingerprintOf(p);
    const notes: string[] = [];
    if (recorded === undefined) {
      if (!seals([given, ...previous], o.kept())) {
        throw new MasterKeyMismatch(`the master key does not match this database: ${MASTER_KEY_VARIABLE} (fingerprint ${shortFingerprint(fingerprint)}) seals none of the secrets it keeps. Give the key they were sealed under`);
      }
      record.setFingerprint(fingerprint);
    } else if (recorded !== fingerprint) {
      if (!previous.some((p) => fingerprintOf(p) === recorded)) {
        const rotation = record.rotation?.();
        if (rotation?.from === fingerprint) {
          throw new MasterKeyMismatch(`the master key does not match this database: it was rotated at ${rotation.at} to the key of fingerprint ${shortFingerprint(recorded)}, and ${MASTER_KEY_VARIABLE} is the key it replaced (fingerprint ${shortFingerprint(fingerprint)}). Give the new key, the one the rotation showed; nothing was changed`);
        }
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
    const oldPrevious = listOf(env[OLD_PREVIOUS_VARIABLE]);
    const matches = recorded === undefined ? seals([old, ...oldPrevious], o.kept()) : recorded === fingerprint;
    if (!matches) {
      throw new MasterKeyMismatch(`the old token key does not match this database (fingerprint ${shortFingerprint(fingerprint)})${recorded ? `: it was set up with the key of fingerprint ${shortFingerprint(recorded)}` : ''}. The hopper does not start: find the key its secrets were sealed under and ${GIVE_MASTER_KEY}`);
    }
    if (recorded === undefined) record.setFingerprint(fingerprint);
    return { source: 'old-token-key', key: old, previous: oldPrevious, fingerprint, notes: [] };
  }

  if (recorded !== undefined) {
    throw new MasterKeyMissing(`the master key is missing: this database was set up with the key of fingerprint ${shortFingerprint(recorded)}. The hopper does not start without it: ${GIVE_MASTER_KEY}`);
  }
  const kept = o.kept();
  if (kept.keyIds.length > 0 || kept.tokens.length > 0) {
    throw new MasterKeyMissing(`the master key is missing: this database keeps secrets sealed under a key the launch does not give. The hopper does not start without it: ${GIVE_MASTER_KEY}`);
  }
  const key = randomBytes(32).toString('hex');
  const fingerprint = fingerprintOf(key);
  record.setFingerprint(fingerprint);
  return { source: 'generated', key, previous: [], fingerprint, notes: [] };
}

/** `env` as the parts read it, and the one way to change the master key in it: a rotation (issue #659). */
export interface KeyedEnv {
  env: Record<string, string | undefined>;
  /** The parts read `key` from now on: they seal under it at their next call. */
  use(key: { key: string; previous: readonly string[] }): void;
}

/**
 * `env` as the parts read it: the master key and its previous keys as resolved (none when `key` is undefined), and none
 * of the files or old variables. Every other variable is `env`'s, read live.
 */
export function withMasterKey(env: Record<string, string | undefined>, key: { key: string; previous: readonly string[] } | undefined): KeyedEnv {
  const over: Record<string, string | undefined> = Object.fromEntries(MASTER_KEY_VARIABLES.map((n) => [n, undefined]));
  const use = (k: { key: string; previous: readonly string[] }): void => {
    over[MASTER_KEY_VARIABLE] = k.key;
    over[PREVIOUS_KEYS_VARIABLE] = k.previous.length ? k.previous.join('\n') : undefined;
  };
  if (key) use(key);
  return {
    env: new Proxy(env, { get: (target, name) => (typeof name === 'string' && name in over ? over[name] : target[name as string]) }),
    use,
  };
}

/**
 * The key a part that records no fingerprint reads (the vault container, issue #586): HOPPER_MASTER_KEY, else the old
 * token key while the install is moved from it; undefined: none. Throws as resolveMasterKey does on a key file that
 * cannot be read or no key.
 */
export function launchKey(env: Record<string, string | undefined>, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): { key: string; previous: string[] } | undefined {
  const given = launchGiven(env, read);
  const key = given.key ?? oldKey(env, read);
  if (key === undefined) return undefined;
  fingerprintOf(key);
  return { key, previous: given.key !== undefined ? given.previous : listOf(env[OLD_PREVIOUS_VARIABLE]) };
}

/** Why `key` is not the key the database's fingerprint names, or undefined when it is (or none is recorded yet). */
export function mismatchOf(key: { key: string; previous: readonly string[] }, recorded: string | undefined): string | undefined {
  if (recorded === undefined || [key.key, ...key.previous].some((k) => fingerprintOf(k) === recorded)) return undefined;
  return `the master key does not match this database: it was set up with the key of fingerprint ${shortFingerprint(recorded)}, and this one has fingerprint ${shortFingerprint(fingerprintOf(key.key))}`;
}

const SOURCE_WORDS = { given: `given at launch as ${MASTER_KEY_VARIABLE} or its file`, generated: 'made for this new hopper', 'old-token-key': 'read from the old token key', rotated: 'made by a rotation' } as const;

/**
 * The start's lines about the master key: where it came from and its fingerprint, never the key (issue #685: a log goes
 * to the host's journal and stays there; the UI shows a key this start made once, to the hopper's admin); the notes. The log mask holds the key and its previous keys from here on, so no later line carries them.
 */
export function logMasterKey(key: MasterKey, saved: boolean, logger: { info(line: string): void; warn(line: string): void }, mask: Pick<LogMask, 'hold'> = logMask): void {
  mask.hold(key.key, ...key.previous);
  const fingerprint = shortFingerprint(key.fingerprint);
  logger.info(`hopper: master key: ${SOURCE_WORDS[key.source]} (${key.source}), fingerprint ${fingerprint}${key.previous.length ? `; ${key.previous.length} previous key(s) given` : ''}`);
  for (const note of key.notes) logger.info(`hopper: ${note}`);
  if (key.source === 'given') return;
  if (!saved) {
    logger.warn('hopper: save the master key now: the hopper\'s admin shows it once in the UI (Show the key (once)), never in the log. Keep it in a password manager: every secret the hopper keeps is sealed under it, and without it a new container opens none of them');
  }
  logger.warn(`hopper: give the master key as ${MASTER_KEY_VARIABLE} at each launch (docs/deploy.md "The master key"): ${key.source === 'generated'
    ? 'a start without it is refused'
    : 'until then it is read from the old token key, and the secrets volume cannot be removed'}`);
}
