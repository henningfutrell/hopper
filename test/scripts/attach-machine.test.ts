// scripts/attach-machine.sh <ssh-target>: prepares another machine to run jobs (design.md
// "Attached machines"). Run against stand-ins on PATH — ssh runs the remote command in a local
// shell with HOME pointing at a temp dir — so nothing leaves this process tree.
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

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
  });
}

const log = (): string => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-attach-'));
  bin = join(dir, 'bin');
  home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  // ssh <opts> -- <target> <command>: run the command here, as sshd would hand it to a shell.
  stub('ssh', [
    'while [ "$1" != "--" ]; do shift; done; shift',
    'target="$1"; shift',
    '[ "$target" = unreachable ] && { echo "ssh: connect to host unreachable: No route" >&2; exit 255; }',
    'exec sh -c "$*"',
  ].join('\n'));
  stub('herdr', '[ -e "$HOME/.running" ] && echo "status: running" || echo "status: not running"');
  stub('claude', 'echo 2.1.288');
  stub('systemctl', 'case "$*" in *"enable --now"*) touch "$HOME/.running";; esac');
  stub('loginctl', 'echo Linger=${FAKE_LINGER:-yes}');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attach-machine.sh', () => {
  it('installs the herdr session unit there, enables and starts it, and verifies the session runs', () => {
    const r = run(['laptop']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const unit = join(home, '.config/systemd/user/job-hopper-herdr.service');
    expect(readFileSync(unit, 'utf8')).toBe(readFileSync(join(ROOT, 'systemd/job-hopper-herdr.service'), 'utf8'));
    expect(log()).toMatch(/systemctl --user daemon-reload\nsystemctl --user enable --now job-hopper-herdr/);
    expect(r.stdout).toContain('herdr session job-hopper is running on laptop');
    // The plugins.yaml lines to add, ready to paste.
    expect(r.stdout).toContain('attachedMachines:');
    expect(r.stdout).toContain('- { name: laptop, ssh: laptop, lanes: 2 }');
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
