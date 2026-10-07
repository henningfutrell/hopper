// scripts/agent-boxes.sh (issue #295, design.md "Agent boxes"): one container per agent CLI, each an ssh
// target with its own herdr session, attached to the hopper as an ssh machine with no executors. The
// plugins-config filter (scripts/agent-boxes.ts) on its own; then, opt-in (HOPPER_TEST_AGENT_BOX=1: it
// builds an image with the codex CLI from npm, minutes the first time, and keeps docker busy), a real box
// on the real docker, reached over real ssh with the hopper's key, attached through the operator CLI to a
// test database. HOME is the worker's throwaway one, so ~/.ssh is too; the box and its home volume are
// removed afterwards.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachBoxes, detachBoxes, executorOf } from '../../scripts/agent-boxes.ts';
import { pluginsConfigProblem } from '../../src/plugins/plugins-config.ts';
import { openAdminStore } from '../support/files.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-boxes.sh');
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGv8n9cYc0bTqgYk2m0h3iN1wqXo3f5rB0g8m1Xx3c1B';

describe('the plugins config with agent boxes', () => {
  const base = { version: 1, executors: [{ name: 'herdr-claude', plugin: 'herdr-claude' }], machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }] };

  it('attaches each box as an ssh machine running its agent\'s executor, with its herdr session and pinned host key (issue #307)', () => {
    const out = attachBoxes(base, [{ name: 'hopper-box-codex', agent: 'codex', ssh: 'agent@hopper-box-codex', hostKey: KEY_A }]);
    expect(out.machines).toEqual([
      base.machines[0],
      { name: 'hopper-box-codex', plugin: 'ssh', options: { ssh: 'agent@hopper-box-codex', herdr: true, hostKey: KEY_A, lanes: 1, executors: ['codex'] } },
    ]);
    // The executor a box runs is switched on when it is not yet: the box runs jobs once attached.
    expect(out.executors).toEqual([...base.executors, { name: 'codex', plugin: 'codex' }]);
    expect(pluginsConfigProblem(out)).toBeUndefined();
  });

  it.each([
    ['claude', 'herdr-claude'], ['cursor', 'cursor-agent'], ['codex', 'codex'], ['opencode', 'opencode'], ['omp', 'omp'],
  ])('the %s box runs %s', (agent, plugin) => {
    expect(executorOf(agent)).toBe(plugin);
  });

  it('a box runs the instance of its executor the config already has, whatever its name', () => {
    const named = { ...base, executors: [...base.executors, { name: 'cursor', plugin: 'cursor-agent', options: { args: ['--force'] } }] };
    const out = attachBoxes(named, [{ name: 'c', agent: 'cursor', ssh: 'agent@c', hostKey: KEY_A }, { name: 'h', agent: 'claude', ssh: 'agent@h', hostKey: KEY_A }]);
    expect(out.executors).toEqual(named.executors);
    expect(out.machines!.slice(1).map((m) => m.options!.executors)).toEqual([['cursor'], ['herdr-claude']]);
  });

  it('attached again, a box keeps its lanes, executors and label and takes its new connection; one left with none takes its agent\'s', () => {
    const once = attachBoxes(base, [{ name: 'b', agent: 'claude', ssh: 'b', hostKey: KEY_A }]);
    const edited = { ...once, machines: once.machines!.map((m) => (m.name === 'b' ? { ...m, options: { ...m.options, lanes: 3, executors: ['test'], label: 'Claude box' } } : m)) };
    const again = attachBoxes(edited, [{ name: 'b', agent: 'claude', ssh: 'agent@b', hostKey: KEY_B }]);
    expect(again.machines!.find((m) => m.name === 'b')!.options).toEqual({ ssh: 'agent@b', herdr: true, hostKey: KEY_B, lanes: 3, executors: ['test'], label: 'Claude box' });
    const idle = { ...once, machines: once.machines!.map((m) => (m.name === 'b' ? { ...m, options: { ...m.options, executors: [] } } : m)) };
    expect(attachBoxes(idle, [{ name: 'b', agent: 'claude', ssh: 'b', hostKey: KEY_A }]).machines!.find((m) => m.name === 'b')!.options!.executors).toEqual(['herdr-claude']);
  });

  it('never turns another kind of machine into a box', () => {
    expect(() => attachBoxes(base, [{ name: 'local', agent: 'codex', ssh: 'local', hostKey: KEY_A }])).toThrow(/machine local is a local machine, not an agent box/);
  });

  it('a config with no machines yet takes the boxes', () => {
    expect(attachBoxes({ version: 1 }, [{ name: 'b', agent: 'opencode', ssh: 'b', hostKey: KEY_A }]).machines).toHaveLength(1);
  });

  it('detaches only the ssh machines named', () => {
    const two = attachBoxes(base, [{ name: 'b', agent: 'omp', ssh: 'b', hostKey: KEY_A }, { name: 'c', agent: 'omp', ssh: 'c', hostKey: KEY_B }]);
    expect(detachBoxes(two, ['b', 'local']).machines!.map((m) => m.name)).toEqual(['local', 'c']);
  });
});

describe('agent-boxes.sh', () => {
  it('refuses an agent it does not know, and an option', () => {
    for (const args of [['gemini'], ['--yes']]) {
      const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('agents: claude codex cursor omp opencode');
    }
  });

  it('builds from the box files an install carries: its scripts directory, nothing else of the checkout', () => {
    // As scripts/install.sh lays out the app: scripts/ copied, deploy/ and the rest not. A stand-in docker
    // answers `info`, and on `build` lists its build context and fails, so nothing is built.
    const d = mkdtempSync(join(tmpdir(), 'jh-boxes-app-'));
    cpSync(join(ROOT, 'scripts'), join(d, 'app', 'scripts'), { recursive: true });
    mkdirSync(join(d, 'bin'));
    writeFileSync(join(d, 'bin', 'docker'), `#!/bin/sh\ncase "$1" in info) exit 0 ;; build) for a; do c="$a"; done; ls "$c" > "${d}/context"; exit 1 ;; esac\nexit 1\n`);
    writeFileSync(join(d, 'bin', 'herdr'), '#!/bin/sh\n');
    chmodSync(join(d, 'bin', 'docker'), 0o755);
    chmodSync(join(d, 'bin', 'herdr'), 0o755);
    const r = spawnSync('bash', [join(d, 'app', 'scripts', 'agent-boxes.sh'), 'codex'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH ?? ''}`, HOPPER_SSH_PUBLIC_KEY: KEY_A },
    });
    expect(r.stderr).toContain('building hopper-box-codex failed');
    expect(readFileSync(join(d, 'context'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['Dockerfile', 'entrypoint.sh', 'herdr', 'pickup.ts']);
  });

  it('with no hopper to ask, needs the hopper\'s key: its file, or its public line', () => {
    const env = { ...process.env, HOPPER_SSH_KEY_FILE: '', HOPPER_SSH_PUBLIC_KEY: '', HOPPER_CONTAINER: '' };
    const none = spawnSync('bash', [SCRIPT, 'codex'], { encoding: 'utf8', env });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('no hopper found to attach to: run the hopper (compose.yaml), or name its key: HOPPER_SSH_KEY_FILE (its file), or HOPPER_SSH_PUBLIC_KEY (its public line, as Machines → Add shows it)');
    const bad = spawnSync('bash', [SCRIPT, 'codex'], { encoding: 'utf8', env: { ...env, HOPPER_SSH_PUBLIC_KEY: 'not a key' } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is not a public key line');
  });
});

// Issue #307: the hopper in its compose container is found through docker, asked for its key and its
// network there, and every box joins that network under a fixed sshd port. A stand-in docker logs each
// call, answers as a running compose hopper does, and fails the build, so nothing is built.
describe('agent-boxes.sh, the hopper in a container', () => {
  function standIn() {
    const d = mkdtempSync(join(tmpdir(), 'jh-boxes-hopper-'));
    mkdirSync(join(d, 'bin'));
    writeFileSync(join(d, 'bin', 'docker'), `#!/bin/sh
echo "$*" >> "${d}/calls"
case "$1" in
  info) exit 0 ;;
  ps) case "$*" in *com.docker.compose.service=hopper*) echo hopper-hopper-1 ;; esac; exit 0 ;;
  exec) case "$*" in *"hopper ssh-key"*) echo '${KEY_A} hopper'; exit 0 ;; esac; exit 1 ;;
  container) case "$*" in *hopper-hopper-1*) echo 'hopper_default' ; exit 0 ;; esac; exit 1 ;;
  build) exit 1 ;;
esac
exit 1
`);
    writeFileSync(join(d, 'bin', 'herdr'), '#!/bin/sh\n');
    chmodSync(join(d, 'bin', 'docker'), 0o755);
    chmodSync(join(d, 'bin', 'herdr'), 0o755);
    return d;
  }

  it('asks the hopper in its container for its key: no key to copy, no database, no host install', () => {
    const d = standIn();
    const env = { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH ?? ''}`, HOPPER_SSH_KEY_FILE: '', HOPPER_SSH_PUBLIC_KEY: '', HOPPER_DATABASE_URL: '', HOPPER_DATABASE_URL_FILE: '' };
    delete (env as Record<string, string | undefined>).HOPPER_CONTAINER;
    const r = spawnSync('bash', [SCRIPT, 'codex'], { encoding: 'utf8', env });
    expect(r.stderr).toContain('the hopper runs in container hopper-hopper-1 (network hopper_default)');
    expect(r.stderr).toContain('building hopper-box-codex failed');
    expect(readFileSync(join(d, 'calls'), 'utf8')).toContain('exec -- hopper-hopper-1 hopper ssh-key');
  });
});

describe.skipIf(process.env.HOPPER_TEST_AGENT_BOX !== '1')('a real agent box (opt-in)', () => {
  const prefix = `jh-box-${process.pid}`;
  const name = `${prefix}-codex`;
  const ssh = join(homedir(), '.ssh');
  const key = join(homedir(), 'hopper-key');
  let url: string;
  beforeAll(() => { url = installFromBefore(testDatabaseUrl()); });
  const run = (args: string[]) => spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 900_000,
    env: { ...process.env, HOPPER_BOX_PREFIX: prefix, HOPPER_BOX_PORT_BASE: String(40000 + (process.pid % 20000)), HOPPER_SSH_KEY_FILE: key, HOPPER_APP_DIR: ROOT, HOPPER_DATABASE_URL: url, HOPPER_CONTAINER: '' },
  });
  const asHopper = (command: string): string => execFileSync('ssh', [
    '-F', join(ssh, 'config'), '-o', `UserKnownHostsFile=${join(ssh, 'known_hosts')}`, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-i', key, '--', name, command,
  ], { encoding: 'utf8' });
  const plugins = () => { const s = openAdminStore(url); try { return s.config.read('plugins') as { machines: { name: string; plugin: string; options: Record<string, unknown> }[] }; } finally { s.close(); } };

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', name]);
    spawnSync('docker', ['volume', 'rm', `${name}-home`]);
    spawnSync('docker', ['image', 'rm', '--no-prune', name]); // its layers stay: the build cache of the next run
  });

  it('runs the agent CLI and its own herdr session, reached over ssh with the hopper\'s key, attached to the hopper', () => {
    const s = openAdminStore(url);
    try { s.config.write('plugins', { version: 1, executors: [{ name: 'test', plugin: 'test' }] }, 'missing'); } finally { s.close(); }
    const r = run(['codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(ssh, 'config'), 'utf8').split('\n')[0]).toBe(`Include ${join(ssh, `${prefix}.config`)}`);
    expect(readFileSync(join(ssh, `${prefix}.config`), 'utf8')).toMatch(new RegExp(`Host ${name}\\n  HostName 127\\.0\\.0\\.1\\n  Port \\d+\\n  User agent\\n`));
    expect(asHopper('/usr/local/bin/herdr --session hopper status server')).toMatch(/^status: running$/m);
    expect(asHopper('codex --version')).toMatch(/codex/i);
    expect(r.stdout).toContain(`ssh -t ${name}`);
    const box = plugins().machines.find((m) => m.name === name)!;
    expect(box).toMatchObject({ plugin: 'ssh', options: { ssh: name, herdr: true, executors: ['codex'] } });
    // herdr is on the box's PATH (/usr/local/bin): no binary is named (issue #311).
    expect(box.options).not.toHaveProperty('herdrBin');
    const pinned = execFileSync('docker', ['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { encoding: 'utf8' }).split(' ').slice(0, 2).join(' ');
    expect(box.options.hostKey).toBe(pinned);
  }, 900_000);

  it('the hopper\'s key is restricted there: no pty', () => {
    const r = spawnSync('ssh', ['-F', join(ssh, 'config'), '-o', `UserKnownHostsFile=${join(ssh, 'known_hosts')}`, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none', '-i', key, '-tt', '--', name, 'tty'], { encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toMatch(/not a tty|PTY allocation request failed/);
  });

  it('running it again keeps the running box', () => {
    const id = execFileSync('docker', ['container', 'inspect', '--format', '{{.Id}}', name], { encoding: 'utf8' });
    const r = run(['codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(execFileSync('docker', ['container', 'inspect', '--format', '{{.Id}}', name], { encoding: 'utf8' })).toBe(id);
  }, 900_000);

  it('--remove takes the box away, its Host and its machine; the rest of ~/.ssh stays', () => {
    writeFileSync(join(ssh, 'config'), `${readFileSync(join(ssh, 'config'), 'utf8')}Host mine\n  HostName example.invalid\n`);
    const r = run(['--remove', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(spawnSync('docker', ['container', 'inspect', name]).status).not.toBe(0);
    expect(readFileSync(join(ssh, `${prefix}.config`), 'utf8')).not.toContain(name);
    expect(readFileSync(join(ssh, 'config'), 'utf8')).toContain('Host mine');
    expect(existsSync(join(ssh, 'known_hosts.old'))).toBe(false);
    expect(plugins().machines.map((m) => m.name)).not.toContain(name);
  }, 120_000);
});
