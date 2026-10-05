// scripts/attach-machine.sh <ssh-target>: prepares another machine to run jobs (design.md
// "Attached machines") and lets the hopper in with its own key only, restricted, pinning the host key
// the user's known_hosts already trusts (issue #59, "Target authentication"). Run against stand-ins
// on PATH — ssh runs the remote command in a local shell with HOME pointing at a temp dir — so
// nothing leaves this process tree. ssh-keygen is the real one.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'attach-machine.sh');

let dir: string;
let bin: string;
let home: string;

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/log"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, HOPPER_SSH_KEY_FILE: join(dir, 'hopper_ed25519'), ...env },
  });
}

const log = (): string => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-attach-'));
  bin = join(dir, 'bin');
  home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  // ssh -G <target>: resolves to host <target>, port 22. ssh <opts> -- <target> <command>: run the
  // command here, as sshd would hand it to a shell.
  stub('ssh', [
    'case " $* " in *" -G "*) for a; do t="$a"; done; printf "hostname %s\\nuser u\\nport 22\\n" "$t"; exit 0;; esac',
    'while [ "$1" != "--" ]; do shift; done; shift',
    'target="$1"; shift',
    '[ "$target" = unreachable ] && { echo "ssh: connect to host unreachable: No route" >&2; exit 255; }',
    'exec sh -c "$*"',
  ].join('\n'));
  stub('herdr', '[ -e "$HOME/.running" ] && echo "status: running" || echo "status: not running"');
  stub('claude', 'echo 2.1.288');
  stub('systemctl', 'case "$*" in *"enable --now"*) touch "$HOME/.running";; esac');
  stub('loginctl', 'echo Linger=${FAKE_LINGER:-yes}');
  mkdirSync(join(home, '.ssh'), { mode: 0o700 });
  writeFileSync(join(home, '.ssh', 'known_hosts'), `laptop ${HOST_KEY}\n`);
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', join(dir, 'hopper_ed25519')]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attach-machine.sh', () => {
  it('installs the herdr session unit there, enables and starts it, and verifies the session runs', () => {
    const r = run(['laptop']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const unit = join(home, '.config/systemd/user/hopper-herdr.service');
    expect(readFileSync(unit, 'utf8')).toBe(readFileSync(join(ROOT, 'systemd/hopper-herdr.service'), 'utf8'));
    expect(log()).toMatch(/systemctl --user daemon-reload\nsystemctl --user enable --now hopper-herdr/);
    expect(r.stdout).toContain('herdr session hopper is running on laptop');
    // The plugins.yaml lines to add, ready to paste.
    expect(r.stdout).toContain('machines:');
    expect(r.stdout).toContain(`- { name: laptop, plugin: ssh, options: { ssh: laptop, lanes: 2, herdrBin: ${bin}/herdr, hostKey: ${HOST_KEY} } }`);
  });

  it('lets the hopper in with its own key only, restricted, once however often it runs (issue #59)', () => {
    expect(run(['laptop']).status).toBe(0);
    expect(run(['laptop']).status).toBe(0);
    const pub = readFileSync(join(dir, 'hopper_ed25519.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`restrict ${pub} hopper\n`);
  });

  it('pins only a host key the user already trusts: a machine never connected to by hand is refused (issue #59)', () => {
    writeFileSync(join(home, '.ssh', 'known_hosts'), '');
    const r = run(['laptop']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no host key for laptop in ~\/\.ssh\/known_hosts/);
    expect(log()).not.toMatch(/systemctl/);
  });

  it('needs the hopper\'s key: refused without HOPPER_SSH_KEY_FILE, before touching the machine', () => {
    const r = run(['laptop'], { HOPPER_SSH_KEY_FILE: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/HOPPER_SSH_KEY_FILE/);
    expect(log()).not.toMatch(/^ssh /m);
  });

  it('refuses without a target, and a target ssh would read as an option', () => {
    expect(run([]).status).toBe(2);
    const r = run(['-oProxyCommand=x']);
    expect(r.status).toBe(2);
    expect(log()).not.toMatch(/^ssh /m);
  });

  it('stops when the machine cannot be reached, naming it', () => {
    const r = run(['unreachable']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot reach unreachable/);
    expect(log()).not.toMatch(/systemctl/);
  });

  it('stops when herdr or claude is missing there', () => {
    rmSync(join(bin, 'claude'));
    const r = run(['laptop']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/claude not found on laptop/);
    expect(log()).not.toMatch(/systemctl/);
  });

  it('warns when the user does not linger there (the session would stop at logout)', () => {
    const r = run(['laptop'], { FAKE_LINGER: 'no' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/loginctl enable-linger/);
  });
});
