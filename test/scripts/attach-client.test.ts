// scripts/attach-client.sh <name> <ssh-target> <user@hopper> (issue #59, design.md "Client targets"):
// installs the hopper client on another machine and lets its own key open its one tunnel here and
// nothing else. Stand-ins on PATH — ssh runs the command in a local shell with HOME pointing at the
// "remote" home — so nothing leaves this process tree. node and ssh-keygen are the real ones. The
// client installed is the hopper's client release (issue #70): the client files of the hopper's
// install (HOPPER_APP_DIR), whatever checkout the script runs from.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_FILES, readRelease } from '../../src/client/release.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'attach-client.sh');
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';

let dir: string;
let bin: string;
let home: string;
let there: string;
let app: string;

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/log"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function run(args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, THERE: there,
      HOPPER_HOST_KEY_FILE: join(dir, 'host_ed25519.pub'), HOPPER_APP_DIR: app, HOPPER_WORK_DIR: join(dir, 'work'),
    },
  });
}
const log = (): string => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-attach-client-'));
  bin = join(dir, 'bin');
  home = join(dir, 'home');
  there = join(dir, 'there');
  app = join(dir, 'app');
  for (const d of [bin, home, there]) mkdirSync(d);
  // The hopper's install: its client release one line apart from this checkout's.
  cpSync(join(ROOT, 'src/client'), join(app, 'src/client'), { recursive: true });
  writeFileSync(join(app, 'src/client/main.ts'), `${readFileSync(join(ROOT, 'src/client/main.ts'), 'utf8')}// the installed hopper's\n`);
  writeFileSync(join(dir, 'host_ed25519.pub'), `${HOST_KEY} root@hopper\n`);
  stub('ssh', [
    'while [ "$1" != "--" ]; do shift; done; shift',
    'target="$1"; shift',
    '[ "$target" = unreachable ] && { echo "ssh: connect to host unreachable: No route" >&2; exit 255; }',
    'HOME="$THERE" exec sh -c "$*"',
  ].join('\n'));
  stub('herdr', 'echo herdr');
  stub('systemctl', 'true');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attach-client.sh', () => {
  it('installs the client and its units there, with the token, its own key and this machine\'s pinned host key', () => {
    const r = run(['studio', 'studio-ssh', 'hop@hopper.lan', '2']);
    expect(r.status, r.stderr).toBe(0);
    const release = readRelease(join(app, 'src/client'));
    expect(readRelease(join(there, '.local/lib/hopper-client'))).toEqual(release);
    for (const f of CLIENT_FILES) expect(existsSync(join(there, `.local/lib/hopper-client/${f}`))).toBe(true);
    expect(r.stderr).toContain(`client release ${release.id}`);
    const token = readFileSync(join(home, '.config/hopper/clients/studio.token'), 'utf8').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(home, '.config/hopper/clients/studio.token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(there, '.config/hopper-client/token'), 'utf8').trim()).toBe(token);
    expect(statSync(join(there, '.config/hopper-client/token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(there, '.config/hopper-client')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(there, '.config/hopper-client/known_hosts'), 'utf8')).toBe(`hopper ${HOST_KEY}\n`);
    const env = readFileSync(join(there, '.config/hopper-client/client.env'), 'utf8');
    expect(env).toContain(`HOPPER_CLIENT_HERDR_BIN=${bin}/herdr`);
    expect(env).toContain('HOPPER_CLIENT_SESSION=hopper-client');
    expect(env).toContain('HOPPER_CLIENT_HOPPER=hop@hopper.lan');
    expect(env).toContain(`HOPPER_CLIENT_KEY_FILE=${there}/.config/hopper-client/tunnel_ed25519`);
    expect(readFileSync(join(there, '.config/systemd/user/hopper-client.service'), 'utf8')).toBe(readFileSync(join(ROOT, 'systemd/hopper-client.service'), 'utf8'));
    const herdrUnit = readFileSync(join(there, '.config/systemd/user/hopper-client-herdr.service'), 'utf8');
    expect(herdrUnit).toContain('--session hopper-client server');
    expect(herdrUnit).not.toMatch(/--session hopper /);
    expect(log()).toMatch(/systemctl --user restart hopper-client/);
    expect(r.stdout).toContain(`CLIENT_TOKEN_STUDIO_FILE=${home}/.config/hopper/clients/studio.token`);
    expect(r.stdout).toContain('Plugins → Machine sources, add a client instance named studio, then set its options:\n  tokenEnv: CLIENT_TOKEN_STUDIO\n  lanes: 2');
  });

  it('the client\'s key may open its one tunnel here and nothing else; re-running keeps the token and the key', () => {
    expect(run(['studio', 'studio-ssh', 'hop@hopper.lan']).status).toBe(0);
    const token = readFileSync(join(home, '.config/hopper/clients/studio.token'), 'utf8');
    const pub = readFileSync(join(there, '.config/hopper-client/tunnel_ed25519.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    writeFileSync(join(home, '.ssh/authorized_keys'), `ssh-ed25519 AAAAother user@desk\n${readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')}`);
    expect(run(['studio', 'studio-ssh', 'hop@hopper.lan']).status).toBe(0);
    expect(readFileSync(join(home, '.config/hopper/clients/studio.token'), 'utf8')).toBe(token);
    const lines = readFileSync(join(home, '.ssh/authorized_keys'), 'utf8').trim().split('\n');
    expect(lines).toEqual([
      'ssh-ed25519 AAAAother user@desk',
      `restrict,command="${process.execPath} ${app}/src/client/relay.ts ${join(dir, 'work')}/clients/studio.sock" ${pub} hopper-client:studio`,
    ]);
    expect(statSync(join(home, '.ssh/authorized_keys')).mode & 0o777).toBe(0o600);
  });

  it('refuses a bad name, a hopper that is not user@host, or a target that is an option; nothing touched', () => {
    expect(run(['../x', 'studio-ssh', 'hop@hopper.lan']).status).toBe(2);
    expect(run(['studio', 'studio-ssh', 'hopper.lan']).status).toBe(2);
    expect(run(['studio', '-oProxyCommand=x', 'hop@hopper.lan']).status).toBe(2);
    expect(log()).toBe('');
  });

  it('stops when the machine cannot be reached, before any key is let in', () => {
    const r = run(['studio', 'unreachable', 'hop@hopper.lan']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot reach unreachable/);
    expect(existsSync(join(home, '.ssh/authorized_keys'))).toBe(false);
  });
});
