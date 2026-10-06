// scripts/agent-boxes.sh (issue #295, design.md "Agent boxes"): one container per agent CLI, each an ssh
// target with its own herdr session, attached to the hopper as an ssh machine with no executors. The
// plugins-config filter (scripts/agent-boxes.ts) on its own; then, opt-in (HOPPER_TEST_AGENT_BOX=1: it
// builds an image with the codex CLI from npm, minutes the first time, and keeps docker busy), a real box
// on the real docker, reached over real ssh with the hopper's key, attached through the operator CLI to a
// test database. HOME is the worker's throwaway one, so ~/.ssh is too; the box and its home volume are
// removed afterwards.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachBoxes, BOX_HERDR, detachBoxes } from '../../scripts/agent-boxes.ts';
import { pluginsConfigProblem } from '../../src/plugins/plugins-config.ts';
import { openAdminStore } from '../support/files.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-boxes.sh');
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxWxd8NGtwDjmH0KQxSwU0m++PyQWok+VTcSyB7yJ3e';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGv8n9cYc0bTqgYk2m0h3iN1wqXo3f5rB0g8m1Xx3c1B';

describe('the plugins config with agent boxes', () => {
  const base = { version: 1, executors: [{ name: 'herdr-claude', plugin: 'herdr-claude' }], machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }] };

  it('attaches each box as an ssh machine with no executors, its herdr session and pinned host key', () => {
    const out = attachBoxes(base, [{ name: 'hopper-box-codex', ssh: 'hopper-box-codex', hostKey: KEY_A }]);
    expect(out.machines).toEqual([
      base.machines[0],
      { name: 'hopper-box-codex', plugin: 'ssh', options: { ssh: 'hopper-box-codex', herdr: true, herdrBin: BOX_HERDR, hostKey: KEY_A, lanes: 1, executors: [] } },
    ]);
    expect(pluginsConfigProblem(out)).toBeUndefined();
  });

  it('attached again, a box keeps its lanes, executors and label and takes its new host key', () => {
    const once = attachBoxes(base, [{ name: 'b', ssh: 'b', hostKey: KEY_A }]);
    const edited = { ...once, machines: once.machines!.map((m) => (m.name === 'b' ? { ...m, options: { ...m.options, lanes: 3, executors: ['herdr-claude'], label: 'Claude box' } } : m)) };
    const again = attachBoxes(edited, [{ name: 'b', ssh: 'b', hostKey: KEY_B }]);
    expect(again.machines!.find((m) => m.name === 'b')!.options).toEqual({ ssh: 'b', herdr: true, herdrBin: BOX_HERDR, hostKey: KEY_B, lanes: 3, executors: ['herdr-claude'], label: 'Claude box' });
  });

  it('never turns another kind of machine into a box', () => {
    expect(() => attachBoxes(base, [{ name: 'local', ssh: 'local', hostKey: KEY_A }])).toThrow(/machine local is a local machine, not an agent box/);
  });

  it('a config with no machines yet takes the boxes', () => {
    expect(attachBoxes({ version: 1 }, [{ name: 'b', ssh: 'b', hostKey: KEY_A }]).machines).toHaveLength(1);
  });

  it('detaches only the ssh machines named', () => {
    const two = attachBoxes(base, [{ name: 'b', ssh: 'b', hostKey: KEY_A }, { name: 'c', ssh: 'c', hostKey: KEY_B }]);
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

  it('needs the hopper\'s key: its file, or its public line', () => {
    const env = { ...process.env, HOPPER_SSH_KEY_FILE: '', HOPPER_SSH_PUBLIC_KEY: '' };
    const none = spawnSync('bash', [SCRIPT, 'codex'], { encoding: 'utf8', env });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('HOPPER_SSH_KEY_FILE (its file), or HOPPER_SSH_PUBLIC_KEY (its public line, as Machines → Add shows it)');
    const bad = spawnSync('bash', [SCRIPT, 'codex'], { encoding: 'utf8', env: { ...env, HOPPER_SSH_PUBLIC_KEY: 'not a key' } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is not a public key line');
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
    env: { ...process.env, HOPPER_BOX_PREFIX: prefix, HOPPER_SSH_KEY_FILE: key, HOPPER_APP_DIR: ROOT, HOPPER_DATABASE_URL: url },
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
    const r = run(['--attach', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(ssh, 'config'), 'utf8').split('\n')[0]).toBe(`Include ${join(ssh, `${prefix}.config`)}`);
    expect(readFileSync(join(ssh, `${prefix}.config`), 'utf8')).toMatch(new RegExp(`Host ${name}\\n  HostName 127\\.0\\.0\\.1\\n  Port \\d+\\n  User agent\\n`));
    expect(asHopper('/usr/local/bin/herdr --session hopper status server')).toMatch(/^status: running$/m);
    expect(asHopper('codex --version')).toMatch(/codex/i);
    expect(r.stdout).toContain(`ssh -t ${name}`);
    const box = plugins().machines.find((m) => m.name === name)!;
    expect(box).toMatchObject({ plugin: 'ssh', options: { ssh: name, herdr: true, herdrBin: BOX_HERDR, executors: [] } });
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
    const r = run(['--remove', '--attach', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(spawnSync('docker', ['container', 'inspect', name]).status).not.toBe(0);
    expect(readFileSync(join(ssh, `${prefix}.config`), 'utf8')).not.toContain(name);
    expect(readFileSync(join(ssh, 'config'), 'utf8')).toContain('Host mine');
    expect(existsSync(join(ssh, 'known_hosts.old'))).toBe(false);
    expect(plugins().machines.map((m) => m.name)).not.toContain(name);
  }, 120_000);
});
