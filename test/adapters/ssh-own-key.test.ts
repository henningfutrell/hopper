// Issue #293: the hopper runs in ephemeral containers, so reaching a machine over ssh never leans on a
// durable ~/.ssh there. The hopper's own key is minted once and kept in the database (the user's
// settings), and written to its work dir at every start; a new machine's host key, when ~/.ssh/known_hosts
// does not know it, is the one the machine presents, offered with its fingerprint for the person to confirm.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hopperSshAuth, sshArgv } from '../../src/executors/ssh.ts';
import { ensureOwnSshKey, ownKeyFile, type StoredSshKey } from '../../src/executors/ssh-key.ts';
import { hostKeyFingerprint, hostKeyOffer } from '../../src/machines/index.ts';

const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(SSH, 0o755);
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';
const RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-ssh-own-'));
  process.env.FAKE_HERDR_DIR = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A settings row in memory: what the user's store keeps. */
function settings() {
  let row: StoredSshKey | undefined;
  return { get: () => row, set: (k: StoredSshKey) => { row = k; }, row: () => row };
}

describe('the hopper\'s own ssh key', () => {
  it('is minted once (ed25519) and kept in the store; its private half written to the work dir, owner-only', () => {
    const s = settings();
    const key = ensureOwnSshKey({ stored: s.get, store: s.set, dataDir: dir });
    expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} hopper$/);
    expect(s.row()).toEqual(key);
    const file = ownKeyFile(dir);
    expect(readFileSync(file, 'utf8')).toBe(key.privateKey);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A real key: ssh-keygen reads its public half back from the file.
    const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' ');
    expect(derived).toBe(key.publicKey.split(' ').slice(0, 2).join(' '));
    expect(ensureOwnSshKey({ stored: s.get, store: s.set, dataDir: dir })).toEqual(key);
  });

  it('a fresh container (an empty work dir, no ~/.ssh) gets the same key back from the store', () => {
    const s = settings();
    const key = ensureOwnSshKey({ stored: s.get, store: s.set, dataDir: dir });
    const fresh = mkdtempSync(join(tmpdir(), 'jh-ssh-own-fresh-'));
    try {
      expect(existsSync(ownKeyFile(fresh))).toBe(false);
      expect(ensureOwnSshKey({ stored: s.get, store: () => { throw new Error('minted again'); }, dataDir: fresh })).toEqual(key);
      expect(readFileSync(ownKeyFile(fresh), 'utf8')).toBe(key.privateKey);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('is offered first, then the keys ssh would use that exist; never the agent', () => {
    const s = settings();
    ensureOwnSshKey({ stored: s.get, store: s.set, dataDir: dir });
    const auth = hopperSshAuth({ env: () => undefined, dataDir: dir });
    expect(auth.ownKey).toBe(ownKeyFile(dir));
    const a = sshArgv({ target: 'laptop', bin: SSH, auth: () => auth }, 'true');
    expect(a.filter((_, i) => a[i - 1] === '-i')).toEqual([ownKeyFile(dir)]);
    expect(a).toEqual(expect.arrayContaining(['IdentitiesOnly=yes', 'IdentityAgent=none']));
  });

  it('a key the runtime mounts (HOPPER_SSH_KEY_FILE) is offered alone', () => {
    const s = settings();
    ensureOwnSshKey({ stored: s.get, store: s.set, dataDir: dir });
    const mounted = join(dir, 'mounted');
    writeFileSync(mounted, 'k\n', { mode: 0o600 });
    const auth = hopperSshAuth({ env: (n) => (n === 'HOPPER_SSH_KEY_FILE' ? mounted : undefined), dataDir: dir });
    const a = sshArgv({ target: 'laptop', bin: SSH, auth: () => auth }, 'true');
    expect(a.filter((_, i) => a[i - 1] === '-i')).toEqual([mounted]);
  });
});

describe('a new machine\'s host key, with no known_hosts', () => {
  /** A stand-in ssh-keyscan: prints what the machine presents (one line per key type), or nothing. */
  const keyscan = (lines: string): string => {
    const bin = join(dir, 'ssh-keyscan');
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${join(dir, 'keyscan-args')}"\nprintf '%s' '${lines}'\n`, { mode: 0o755 });
    return bin;
  };
  const noKnownHosts = (): string => join(dir, 'none');

  it('the fingerprint is ssh-keygen\'s: SHA256 over the key, base64 without padding', () => {
    const file = join(dir, 'k.pub');
    writeFileSync(file, `${ED}\n`);
    const want = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', file], { encoding: 'utf8' }).split(' ')[1];
    expect(hostKeyFingerprint(ED)).toBe(want);
  });

  it('known to ~/.ssh/known_hosts: that key, known', async () => {
    const kh = join(dir, 'known_hosts');
    writeFileSync(kh, `[laptop.example]:2222 ${ED}\n`);
    const offer = await hostKeyOffer({ target: 'laptop', sshBin: SSH, knownHosts: kh, keyscanBin: keyscan('') });
    expect(offer).toEqual({ ssh: 'laptop', hostKey: ED, fingerprint: hostKeyFingerprint(ED), known: true });
  });

  it('unknown there: the key the machine presents (ed25519 first), on its resolved host and port, not known', async () => {
    const bin = keyscan(`laptop.example ${RSA}\nlaptop.example ${ED}\n`);
    const offer = await hostKeyOffer({ target: 'user@laptop', sshBin: SSH, knownHosts: noKnownHosts(), keyscanBin: bin });
    expect(offer).toEqual({ ssh: 'user@laptop', hostKey: ED, fingerprint: hostKeyFingerprint(ED), known: false });
    expect(readFileSync(join(dir, 'keyscan-args'), 'utf8')).toMatch(/-p 2222 .*laptop\.example/);
  });

  it('nothing presented, or a target that is not a plain name: rejected with the reason', async () => {
    await expect(hostKeyOffer({ target: 'laptop', sshBin: SSH, knownHosts: noKnownHosts(), keyscanBin: keyscan('') })).rejects.toThrow(/laptop.*no host key/);
    await expect(hostKeyOffer({ target: '-oProxyCommand=x', sshBin: SSH, knownHosts: noKnownHosts(), keyscanBin: keyscan('') })).rejects.toThrow(/bad ssh target/);
  });
});
