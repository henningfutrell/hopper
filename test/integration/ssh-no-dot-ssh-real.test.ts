// Issue #293 against a real OpenSSH server (a throwaway alpine container): with no ~/.ssh at all — no
// config, no keys, no known_hosts, as in an ephemeral container — the hopper reaches a typed
// `user@host` with its own key (kept in the store) and the host key it presents, once confirmed; a host
// key it does not present is never connected to.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hopperSshAuth } from '../../src/executors/ssh.ts';
import { ensureOwnSshKey, type StoredSshKey } from '../../src/executors/ssh-key.ts';
import { hostKeyFingerprint, hostKeyOffer, resolveSshTarget } from '../../src/machines/index.ts';
import { waitFor } from '../support/wait.ts';

const CONTAINER = `jh-it-sshd-nossh-${process.pid}`;
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICvgalHxcabio+TdTXsu+bZgR377KnQGos9ENVpQoKjP';
let dir: string;
let target: string;
let hostKey: string;
let row: StoredSshKey | undefined;
// Never touch a real ~/.ssh (HOPPER_REAL_HERDR keeps the real HOME): the sealed HOME has none.
const noDotSsh = !existsSync(join(homedir(), '.ssh'));

beforeAll(async () => {
  if (!noDotSsh) return;
  dir = mkdtempSync(join(tmpdir(), 'jh-sshd-nossh-'));
  const own = ensureOwnSshKey({ stored: () => row, store: (k) => { row = k; }, dataDir: dir });
  const script = [
    'apk add --no-cache openssh >/dev/null',
    'ssh-keygen -A >/dev/null',
    // An account with no password set is locked, and sshd lets no one into a locked one.
    'adduser -D -s /bin/sh hopper && passwd -u hopper >/dev/null 2>&1; true',
    'mkdir -p /home/hopper/.ssh && printf "restrict %s\\n" "$KEY" > /home/hopper/.ssh/authorized_keys',
    'chown -R hopper /home/hopper/.ssh && chmod 700 /home/hopper/.ssh && chmod 600 /home/hopper/.ssh/authorized_keys',
    'exec /usr/sbin/sshd -D -e',
  ].join(' && ');
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-e', `KEY=${own.publicKey}`, 'alpine:latest', 'sh', '-c', script]);
  const ip = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', CONTAINER], { encoding: 'utf8' }).trim();
  target = `hopper@${ip}`;
  hostKey = await waitFor(async () => {
    try {
      const logs = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
      if (!/Server listening/.test(`${logs.stdout}${logs.stderr}`)) return undefined;
      return execFileSync('docker', ['exec', CONTAINER, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' ');
    } catch { return undefined; }
  }, { timeoutMs: 90000, what: 'sshd in the container' });
}, 120000);

afterAll(() => {
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!noDotSsh)('a machine attached with no ~/.ssh', () => {
  it('there is none: no config, no keys, no known_hosts', () => {
    expect(existsSync(join(homedir(), '.ssh'))).toBe(false);
  });

  it('the host key offer is the key the machine presents, with its fingerprint, not known', async () => {
    const offer = await hostKeyOffer({ target });
    expect(offer).toEqual({ ssh: target, hostKey, fingerprint: hostKeyFingerprint(hostKey), known: false });
  });

  it('confirmed, the hopper gets in with its own key alone', async () => {
    const r = await resolveSshTarget({ target, herdr: false, hostKey, controlDir: join(dir, 'ssh'), auth: () => hopperSshAuth({ env: () => undefined, dataDir: dir }) });
    expect(r).toEqual({ hostKey });
  });

  it('a host key it does not present: never connected', async () => {
    await expect(resolveSshTarget({ target, herdr: false, hostKey: OTHER, controlDir: join(dir, 'ssh'), auth: () => hopperSshAuth({ env: () => undefined, dataDir: dir }) }))
      .rejects.toThrow(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/);
  });
});
