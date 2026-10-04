// Issue #59 against a real OpenSSH server (a throwaway alpine container that also accepts passwords
// and keyboard-interactive login): the hopper gets in only with its own key, only to the host key it
// pins, and never tries a password or a key the user's ssh config offers (design.md "Target
// authentication"). The hopper's key is installed with `restrict`, as attach-machine.sh installs it.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sshArgv, type SshAuth } from '../../src/executors/ssh.ts';
import { waitFor } from '../support/wait.ts';

const CONTAINER = `jh-it-sshd-${process.pid}`;
const ALIAS = `jh-real-sshd-${process.pid}`;
let dir: string;
let hostKey: string;

const keygen = (file: string): string => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', file]);
  return readFileSync(`${file}.pub`, 'utf8').trim();
};

function ssh(auth: SshAuth, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('ssh', sshArgv({ target: ALIAS, auth: () => auth }, command), { encoding: 'utf8', timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? -1) : 0, stdout, stderr });
    });
  });
}

const pinned = (name: string, key: string): string => {
  const file = join(dir, name);
  writeFileSync(file, `${ALIAS} ${key}\n`, { mode: 0o600 });
  return file;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jh-sshd-'));
  const hopperKey = keygen(join(dir, 'hopper'));
  const userKey = keygen(join(dir, 'user'));
  keygen(join(dir, 'stranger'));
  // The server accepts the hopper's key (restricted) and the user's key, and passwords.
  const authorized = `restrict ${hopperKey} hopper\n${userKey} user\n`;
  const script = [
    'apk add --no-cache openssh >/dev/null',
    'ssh-keygen -A >/dev/null',
    'adduser -D -s /bin/sh hopper && echo hopper:secret | chpasswd',
    'mkdir -p /home/hopper/.ssh && printf %s "$AUTH" > /home/hopper/.ssh/authorized_keys',
    'chown -R hopper /home/hopper/.ssh && chmod 700 /home/hopper/.ssh && chmod 600 /home/hopper/.ssh/authorized_keys',
    'exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=yes -o LogLevel=VERBOSE',
  ].join(' && ');
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-e', `AUTH=${authorized}`, '-p', '127.0.0.1::22', 'alpine:latest', 'sh', '-c', script]);
  const port = execFileSync('docker', ['port', CONTAINER, '22/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  hostKey = await waitFor(async () => {
    try {
      const key = execFileSync('docker', ['exec', CONTAINER, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ').slice(0, 2).join(' ');
      return /Server listening/.test(serverLog()) ? key : undefined;
    } catch { return undefined; }
  }, { timeoutMs: 90000, what: 'sshd in the container' });
  // The user's own ssh config names the alias, and offers the user's key (which the server accepts).
  mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 });
  writeFileSync(join(homedir(), '.ssh', 'config'), `Host ${ALIAS}\n  HostName 127.0.0.1\n  Port ${port}\n  User hopper\n  IdentityFile ${join(dir, 'user')}\n`, { mode: 0o600, flag: 'a' });
}, 120000);

afterAll(() => {
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

const serverLog = (): string => execFileSync('sh', ['-c', `docker logs ${CONTAINER} 2>&1`], { encoding: 'utf8' });

describe('ssh to a real target (issue #59)', () => {
  it('the hopper\'s own key and the pinned host key: in, with the key restricted', async () => {
    const r = await ssh({ identityFile: join(dir, 'hopper'), knownHostsFile: pinned('kh-good', hostKey) }, 'echo "in as $(id -un)"');
    expect(r).toMatchObject({ code: 0, stdout: 'in as hopper\n' });
  }, 30000);

  it('a host key other than the pinned one: refused before authenticating', async () => {
    const other = readFileSync(join(dir, 'stranger.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    const r = await ssh({ identityFile: join(dir, 'hopper'), knownHostsFile: pinned('kh-bad', other) }, 'true');
    expect(r.code).toBe(255);
    expect(r.stderr).toMatch(/host key|Host key verification failed/i);
  }, 30000);

  it('a key the server does not accept: refused — never the password the server offers, never the user\'s key from the config', async () => {
    const before = serverLog();
    const r = await ssh({ identityFile: join(dir, 'stranger'), knownHostsFile: pinned('kh-good2', hostKey) }, 'true');
    expect(r.code).toBe(255);
    expect(r.stderr).toMatch(/Permission denied \(publickey/);
    const log = serverLog().slice(before.length);
    expect(log).not.toMatch(/password|keyboard-interactive/i);
    expect(log).not.toMatch(/Accepted publickey/);
  }, 30000);
});
