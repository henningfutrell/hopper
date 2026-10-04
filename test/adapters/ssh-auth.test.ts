// Issue #59: the hopper proves itself to an ssh target with its own key and nothing else — never a
// password, never the user's agent or the user's other keys — and talks only to a target whose host
// key plugins.yaml pins (design.md "Target authentication"). ssh is the stand-in from test/herdr.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { SSH_KEY, hopperSshAuth, knownHostsFile, pinHostKeys, renderKnownHosts, sshArgv } from '../../src/executors/ssh.ts';

const SSH = fileURLToPath(new URL('../herdr/fake-ssh-bin.mjs', import.meta.url));
chmodSync(SSH, 0o755);
const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';
const ED2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICvgalHxcabio+TdTXsu+bZgR377KnQGos9ENVpQoKjP';

let dir: string;
let key: string;
const saved = { ...process.env };
const auth = () => ({ identityFile: key, knownHostsFile: join(dir, 'known_hosts') });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-ssh-auth-'));
  process.env.FAKE_HERDR_DIR = dir;
  key = join(dir, 'id_ed25519');
  writeFileSync(key, 'not a real key\n', { mode: 0o600 });
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const opts = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === '-o' ? [a] : []));

describe('ssh to a target: key-based authentication only', () => {
  const argv = (target = 'laptop') => sshArgv({ target, bin: SSH, auth }, 'true');

  it('reads no ssh config at connect time: the destination is resolved first, then connected with -F /dev/null', () => {
    const a = argv();
    expect(a.slice(0, 2)).toEqual(['-F', '/dev/null']);
    // The fake resolves `laptop` to host laptop.example, user tester, port 2222.
    expect(a.slice(a.indexOf('--') - 4)).toEqual(['-p', '2222', '-l', 'tester', '--', 'laptop.example', 'true']);
  });

  it('offers only the public key: no password, no keyboard-interactive, no GSSAPI, no host-based login', () => {
    expect(opts(argv())).toEqual(expect.arrayContaining([
      'BatchMode=yes', 'PreferredAuthentications=publickey', 'PubkeyAuthentication=yes', 'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no', 'GSSAPIAuthentication=no', 'HostbasedAuthentication=no',
    ]));
  });

  it('proves itself with the hopper\'s own key alone: never the user\'s agent or the user\'s other keys', () => {
    const a = argv();
    expect(opts(a)).toEqual(expect.arrayContaining(['IdentitiesOnly=yes', 'IdentityAgent=none']));
    expect(a[a.indexOf('-i') + 1]).toBe(key);
    expect(a.filter((x) => x === '-i')).toHaveLength(1);
  });

  it('talks only to a pinned host key: strict checking against the hopper\'s known_hosts, under the target\'s name', () => {
    expect(opts(argv())).toEqual(expect.arrayContaining([
      'StrictHostKeyChecking=yes', `UserKnownHostsFile=${join(dir, 'known_hosts')}`, 'GlobalKnownHostsFile=/dev/null',
      'HostKeyAlias=laptop', 'UpdateHostKeys=no', 'CheckHostIP=no', 'VerifyHostKeyDNS=no',
    ]));
  });

  it('forwards nothing to the target', () => {
    expect(opts(argv())).toEqual(expect.arrayContaining(['ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no']));
  });

  it('refuses a target that goes through a jump host or a proxy command: their ssh would not be this one', () => {
    expect(() => argv('jumped')).toThrow(/jumped.*ProxyJump/);
    expect(() => argv('proxied')).toThrow(/proxied.*ProxyCommand/);
  });

  it('refuses a target that is not a plain name: it is also the host key\'s name in known_hosts', () => {
    for (const bad of ['-oProxyCommand=x', 'two words', 'a,b', '*', '']) expect(() => argv(bad)).toThrow(/bad ssh target/);
    expect(() => argv('user@laptop')).not.toThrow();
  });
});

describe('the hopper\'s ssh key comes from the runtime, as a mounted file', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];

  it('is the file JOB_HOPPER_SSH_KEY_FILE names, beside the pinned known_hosts in the data dir', () => {
    expect(hopperSshAuth({ env: env({ [`${SSH_KEY}_FILE`]: key }), dataDir: dir })).toEqual({ identityFile: key, knownHostsFile: join(dir, 'ssh', 'known_hosts') });
  });

  it('none set: refused, with what to set', () => {
    expect(() => hopperSshAuth({ env: env({}), dataDir: dir })).toThrow(/no ssh key for the hopper: set JOB_HOPPER_SSH_KEY_FILE/);
  });

  it('given as a variable: refused, ssh reads a key only from a file', () => {
    expect(() => hopperSshAuth({ env: env({ [SSH_KEY]: 'key text' }), dataDir: dir })).toThrow(/JOB_HOPPER_SSH_KEY must be a mounted file/);
  });

  it('a key file others can read, or that is missing: refused', () => {
    chmodSync(key, 0o640);
    expect(() => hopperSshAuth({ env: env({ [`${SSH_KEY}_FILE`]: key }), dataDir: dir })).toThrow(/readable by others/);
    expect(() => hopperSshAuth({ env: env({ [`${SSH_KEY}_FILE`]: join(dir, 'nope') }), dataDir: dir })).toThrow(/cannot read/);
  });
});

describe('pinned host keys', () => {
  const ssh = (name: string, target: string, hostKey?: string): AttachedMachine => ({
    name, ssh: target, lanes: 1, executors: ['herdr-claude'], session: 'job-hopper', herdrBin: 'herdr', ...(hostKey ? { hostKey } : {}),
  });

  it('one known_hosts line per ssh target, under the target\'s name; container targets and unpinned ones have none', () => {
    const r = renderKnownHosts([ssh('laptop', 'laptop', ED), ssh('other', 'user@desk', ED2), ssh('bare', 'bare'), { name: 'box', docker: 'c', lanes: 1, executors: ['command'] }]);
    expect(r.text).toBe(`laptop ${ED}\nuser@desk ${ED2}\n`);
    expect(r.problems).toEqual(['attached machine bare: no hostKey pinned; the hopper will not connect to it']);
  });

  it('two machines pinning different keys for one target: neither is trusted', () => {
    const r = renderKnownHosts([ssh('a', 'laptop', ED), ssh('b', 'laptop', ED2), ssh('c', 'laptop', ED)]);
    expect(r.text).toBe('');
    expect(r.problems).toEqual(['ssh target laptop: attached machines pin different host keys; none is trusted']);
  });

  it('written to <dataDir>/ssh/known_hosts, owner-only, and rewritten only when it changes', () => {
    pinHostKeys(dir, [ssh('laptop', 'laptop', ED)]);
    const file = knownHostsFile(dir);
    expect(readFileSync(file, 'utf8')).toBe(`laptop ${ED}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'ssh')).mode & 0o777).toBe(0o700);
    const before = statSync(file).mtimeMs;
    pinHostKeys(dir, [ssh('laptop', 'laptop', ED)]);
    expect(statSync(file).mtimeMs).toBe(before);
    pinHostKeys(dir, []);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
