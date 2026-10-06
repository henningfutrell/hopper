// The hopper's own ssh key (issue #293, design.md "Target authentication"): the hopper runs in
// ephemeral containers, so the key it proves itself with to an ssh target cannot live in a durable
// ~/.ssh there. It is minted once (ed25519, by ssh-keygen) and kept in the user's store; at every start
// its private half is written to `<dataDir>/ssh/hopper_ed25519` (owner-only), because ssh reads a key
// only from a file. Its public half is what a machine's authorized_keys holds. Never answered by any
// route but the public half.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubbedEnv } from './env.ts';

/** The hopper's own ssh key as the store keeps it: OpenSSH private key text, and its public line. */
export interface StoredSshKey { privateKey: string; publicKey: string }

/** Where the hopper's own key is written for ssh to read: `<dataDir>/ssh/hopper_ed25519`. */
export const ownKeyFile = (dataDir: string): string => join(dataDir, 'ssh', 'hopper_ed25519');

/** The comment on the hopper's public key: how a machine's authorized_keys names it. */
const COMMENT = 'hopper';

function mint(dir: string, keygenBin: string): StoredSshKey {
  const tmp = mkdtempSync(join(dir, 'keygen-'));
  try {
    const file = join(tmp, 'key');
    execFileSync(keygenBin, ['-q', '-t', 'ed25519', '-N', '', '-C', COMMENT, '-f', file], { env: scrubbedEnv(), stdio: 'ignore', timeout: 10000 });
    return { privateKey: readFileSync(file, 'utf8'), publicKey: readFileSync(`${file}.pub`, 'utf8').trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The hopper's own key: the stored one, else one minted now and stored. Its private half is written to
 * ownKeyFile (mode 600) when the file there is not it. Throws when no key can be minted.
 */
export function ensureOwnSshKey(o: { stored(): StoredSshKey | undefined; store(key: StoredSshKey): void; dataDir: string; keygenBin?: string }): StoredSshKey {
  const dir = join(o.dataDir, 'ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let key = o.stored();
  if (!key) {
    key = mint(dir, o.keygenBin ?? 'ssh-keygen');
    o.store(key);
  }
  const file = ownKeyFile(o.dataDir);
  let now: string | undefined;
  try { now = readFileSync(file, 'utf8'); } catch { /* not written yet */ }
  if (now !== key.privateKey) {
    writeFileSync(`${file}.tmp`, key.privateKey, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  return key;
}
