// scripts/hopper-service.sh (issue #1320): the compose stack under a user service of its own, so the published port
// belongs to the service and not to the shell or agent that started the stack. podman, systemctl and loginctl are stubs on
// PATH that record each call; no unit of this machine is written or started. The image prints the script: `hopper service
// script`. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closedPort, dirs, folder, KEY, listening, MASTER_KEY, ROOT, SCRIPT, servers } from '../support/hopper-service-script.ts';

afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

describe('scripts/hopper-service.sh (issue #1320)', () => {
  it('install writes the units, turns on linger, and starts the stack through the service: settings kept, no secret, no image', () => {
    const f = folder();
    const r = f.run(['install'], { HOPPER_BIND: '0.0.0.0', HOPPER_PORT: '4791', HOPPER_MASTER_KEY: KEY, HOPPER_KMS_KEY: 'kms', HOPPER_IMAGE: 'ghcr.io/henningfutrell/hopper:dev' });
    expect(r.status, r.err).toBe(0);
    const service = f.unit('hopper-compose.service');
    expect(service).toContain(`WorkingDirectory="${f.dir}"`);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^RemainAfterExit=yes$/m);
    expect(service).toContain(`ExecStart="${spawnSync('/bin/bash', ['-c', 'command -v bash'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim()}" "${f.dir}/hopper-service.sh" start`);
    expect(service).toMatch(/^ExecStop=.* stop$/m);
    expect(service).toContain(`Environment="HOPPER_SERVICE_COMPOSE=${f.bin}/podman compose"`);
    expect(service).toContain('Environment="HOPPER_BIND=0.0.0.0"');
    expect(service).toContain('Environment="HOPPER_PORT=4791"');
    expect(service).toMatch(/^WantedBy=default\.target$/m);
    for (const secret of [KEY, 'HOPPER_MASTER_KEY', 'HOPPER_KMS_KEY', 'HOPPER_IMAGE']) expect(service).not.toContain(secret);
    expect(service).toMatch(/^ImportCredential=hopper-master-key$/m);
    expect(f.unit('hopper-compose-check.service')).toContain(`"${f.dir}/hopper-service.sh" check`);
    expect(f.unit('hopper-compose-check.timer')).toMatch(/^OnUnitActiveSec=1min$/m);
    expect(f.calls()).toEqual([
      'systemctl --user show-environment',
      expect.stringMatching(/^podman ps -aq --filter label=io\.podman\.compose\.project=hopper/),
      'podman run --rm ghcr.io/henningfutrell/hopper:dev hopper master-key script | key=',
      'loginctl show-user someone -p Linger --value',
      'loginctl enable-linger someone',
      'systemctl --user daemon-reload',
      'systemctl --user enable hopper-compose.service hopper-compose-check.timer',
      'systemctl --user restart hopper-compose.service',
      'systemctl --user restart hopper-compose-check.timer',
    ]);
    expect(r.err).toMatch(/turned on linger for someone/);
    expect(r.err).toMatch(/the image gives no master-key\.sh/);
  });

  it('install takes podman-compose when it started the stack, and gives the rootless Podman socket when podman.socket is on', async () => {
    const f = folder({ podmanCompose: true });
    mkdirSync(join(f.runtime, 'podman'));
    const socket = createServer();
    servers.push(socket);
    await new Promise<void>((done) => socket.listen(join(f.runtime, 'podman', 'podman.sock'), done));
    const r = f.run(['install'], { STUB_STACK: 'podman-compose', STUB_LINGER: 'yes' });
    expect(r.status, r.err).toBe(0);
    const service = f.unit('hopper-compose.service');
    expect(service).toContain(`Environment="HOPPER_SERVICE_COMPOSE=${f.bin}/podman-compose"`);
    expect(service).toContain('Environment="HOPPER_PODMAN_SOCKET_HOST=%t/podman/podman.sock"');
    expect(f.calls()).not.toContain('loginctl enable-linger someone');
  });

  it('install goes on when this user cannot turn on linger, and says the line that does', () => {
    const f = folder();
    const r = f.run(['install'], { STUB_LINGER_FAIL: '1' });
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/sudo loginctl enable-linger someone/);
    expect(f.calls()).toContain('systemctl --user restart hopper-compose.service');
  });

  it('install refuses without podman, or with no compose.yaml here, and writes no unit', () => {
    const f = folder();
    rmSync(join(f.bin, 'podman'));
    // Only the stubs: no podman of this machine answers.
    const r = f.run(['install'], { PATH: f.bin });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/With Docker, its daemon serves the port/);
    const g = folder();
    rmSync(join(g.dir, 'compose.yaml'));
    expect(g.run(['install']).status).toBe(1);
    expect(existsSync(join(f.home, '.config', 'systemd'))).toBe(false);
    expect(existsSync(join(g.home, '.config', 'systemd'))).toBe(false);
  });

  it('start takes the stack down, then starts it with the key sealed to this host, for compose only: never an argument', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    writeFileSync(join(f.dir, 'hopper-master-key.enc'), 'sealed');
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose' });
    expect(r.status, r.err).toBe(0);
    const compose = f.calls().filter((c) => c.startsWith('podman compose') || c.startsWith('master-key.sh'));
    expect(compose).toEqual([
      'podman compose -p hopper down | key=',
      expect.stringMatching(/^master-key\.sh run bash .*hopper-service\.sh up$/),
      `podman compose -p hopper up -d | key= | file=${KEY} at /run/hopper-master-key`,
    ]);
    for (const c of f.calls()) expect(c.split(' | ')[0]).not.toContain(KEY);
  });


  const upCalls = (f: ReturnType<typeof folder>) => f.calls().filter((c) => c.startsWith('podman compose') || c.startsWith('master-key.sh'));

  it('start takes the key from the systemd credential hopper-master-key, for compose only, with no key sealed (issue #1372)', () => {
    const f = folder();
    const creds = join(f.dir, '.creds');
    mkdirSync(creds);
    writeFileSync(join(creds, 'hopper-master-key'), `${KEY}\n`);
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', CREDENTIALS_DIRECTORY: creds, STUB_DATA: '1' });
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/with the master key from the systemd credential hopper-master-key/);
    expect(upCalls(f)).toEqual(['podman compose -p hopper down | key=', `podman compose -p hopper up -d | key= | file=${KEY} at /run/hopper-master-key`]);
    for (const c of f.calls()) expect(c.split(' | ')[0]).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
  });

  it('start takes HOPPER_MASTER_KEY given at launch in place of the key sealed here (issue #1372)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    writeFileSync(join(f.dir, 'hopper-master-key.enc'), 'sealed');
    const other = 'b'.repeat(64);
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', HOPPER_MASTER_KEY: other, STUB_DATA: '1' });
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/with the master key from HOPPER_MASTER_KEY given at launch/);
    expect(upCalls(f)).toEqual(['podman compose -p hopper down | key=', `podman compose -p hopper up -d | key= | file=${other} at /run/hopper-master-key`]);
    expect(r.err).not.toContain(other);
  });

  it('start refuses a credential that is no key, and changes nothing (issue #1372)', () => {
    const f = folder();
    const creds = join(f.dir, '.creds');
    mkdirSync(creds);
    writeFileSync(join(creds, 'hopper-master-key'), 'not a key');
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', CREDENTIALS_DIRECTORY: creds });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/the systemd credential hopper-master-key is no master key/);
    expect(upCalls(f)).toEqual([]);
  });

  it('start with data and no key refuses: the stack is not touched and no new key is made (issue #1372)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', STUB_DATA: '1' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/no master key is given, and the hopper keeps data \(the volume hopper_postgres\): the stack does not start, and no new key is made/);
    expect(r.err).toMatch(/bash hopper-service\.sh start-with-key/);
    expect(upCalls(f)).toEqual([]);
  });

  it('start-with-key restarts the service with the key in the manager\'s environment for that start only, never as an argument (issue #1372)', () => {
    const f = folder();
    expect(f.run(['install']).status).toBe(0);
    const before = f.calls().length;
    const r = f.run(['start-with-key'], { HOPPER_MASTER_KEY: KEY });
    expect(r.status, r.err).toBe(0);
    expect(f.calls().slice(before)).toEqual([
      'systemctl --user import-environment HOPPER_MASTER_KEY',
      `imported key=${KEY}`,
      'systemctl --user restart hopper-compose.service',
      'systemctl --user unset-environment HOPPER_MASTER_KEY',
    ]);
    for (const c of f.calls().filter((c) => c.startsWith('systemctl'))) expect(c).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
  });

  it('start-with-key asks for the key on the terminal, and refuses no key or no service (issue #1372)', () => {
    const f = folder();
    expect(f.run(['start-with-key'], { HOPPER_MASTER_KEY: KEY }).err).toMatch(/no hopper-compose\.service: install it first/);
    expect(f.run(['install']).status).toBe(0);
    const tty = join(f.dir, '.tty');
    writeFileSync(tty, `${KEY}\n`);
    const before = f.calls().length;
    expect(f.run(['start-with-key'], { HOPPER_KEY_TTY: tty }).status).toBe(0);
    expect(f.calls().slice(before)).toContain(`imported key=${KEY}`);
    writeFileSync(tty, 'nope\n');
    const bad = f.run(['start-with-key'], { HOPPER_KEY_TTY: tty });
    expect(bad.status).toBe(1);
    expect(bad.err).toMatch(/that is no master key/);
    expect(f.run(['start-with-key'], { HOPPER_KEY_TTY: join(f.dir, 'no-tty') }).err).toMatch(/no master key: give it as HOPPER_MASTER_KEY/);
  });

  it('start with no key sealed here and no data yet starts the stack with no key, and stop takes it down', () => {
    const f = folder();
    expect(f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose' }).status).toBe(0);
    expect(f.run(['stop'], { HOPPER_SERVICE_COMPOSE: 'podman compose' }).status).toBe(0);
    expect(f.calls().filter((c) => c.startsWith('podman compose'))).toEqual([
      'podman compose -p hopper down | key=',
      'podman compose -p hopper up -d | key=',
      'podman compose -p hopper down | key=',
    ]);
  });

  it('check restarts the service when the hopper container runs and its published port does not answer from this host', async () => {
    const f = folder();
    const r = f.run(['check'], { STUB_RUNNING: '1', STUB_PORT: `0.0.0.0:${await closedPort()}` });
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/does not answer while the hopper container runs/);
    expect(f.calls()).toContain('systemctl --user restart --no-block hopper-compose.service');
  });

  it('check leaves the service alone when the port answers, the container does not run, or the service is stopped', async () => {
    const f = folder();
    expect(f.run(['check'], { STUB_RUNNING: '1', STUB_PORT: `127.0.0.1:${await listening()}` }).status).toBe(0);
    expect(f.run(['check'], { STUB_PORT: `127.0.0.1:${await closedPort()}` }).status).toBe(0);
    expect(f.run(['check'], { STUB_ACTIVE: '3', STUB_RUNNING: '1', STUB_PORT: `127.0.0.1:${await closedPort()}` }).status).toBe(0);
    expect(f.calls().filter((c) => c.includes('restart'))).toEqual([]);
  });

  it('uninstall stops the service and removes its units', () => {
    const f = folder();
    expect(f.run(['install']).status).toBe(0);
    expect(f.run(['uninstall']).status).toBe(0);
    expect(f.calls()).toContain('systemctl --user disable --now hopper-compose-check.timer hopper-compose.service');
    expect(existsSync(join(f.home, '.config', 'systemd', 'user', 'hopper-compose.service'))).toBe(false);
  });

  it('hopper service script prints this build\'s script, with no database', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'service', 'script'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(SCRIPT, 'utf8'));
  });
});
