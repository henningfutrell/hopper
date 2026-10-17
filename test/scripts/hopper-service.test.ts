// scripts/hopper-service.sh (issue #1320): the compose stack under a user service of its own, so the published port
// belongs to the service and not to the shell or agent that started the stack. podman, systemctl and loginctl are stubs on
// PATH that record each call; no unit of this machine is written or started. The image prints the script: `hopper service
// script`. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'hopper-service.sh');
const KEY = '0123456789abcdef'.repeat(4);
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

// The key compose is given as a file (issue #1487): what the file holds, and where the container reads it.
const PODMAN = `#!/bin/sh
file=''
[ -n "\${HOPPER_MASTER_KEY_HOST_FILE:-}" ] && file=" | file=$(cat "$HOPPER_MASTER_KEY_HOST_FILE") at \${HOPPER_MASTER_KEY_FILE:-}"
printf 'podman %s | key=%s%s\\n' "$*" "\${HOPPER_MASTER_KEY:-}" "$file" >> "$STUB_LOG"
case "$*" in
  "run --rm "*" hopper master-key script") [ -n "\${STUB_MASTER_KEY_SCRIPT:-}" ] && cat "$STUB_MASTER_KEY_SCRIPT" ;;
  "ps -aq --filter label=io.podman.compose.project=hopper") [ "\${STUB_STACK:-}" = podman-compose ] && echo 0123456789ab ;;
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=hopper") [ -n "\${STUB_RUNNING:-}" ] && echo cid ;;
  "port cid") [ -n "\${STUB_PORT:-}" ] && echo "4790/tcp -> \${STUB_PORT}" ;;
  "volume exists hopper_postgres") [ -n "\${STUB_DATA:-}" ] || exit 1 ;;
esac
exit 0
`;
const PODMAN_COMPOSE = `#!/bin/sh
printf 'podman-compose %s | key=%s\\n' "$*" "\${HOPPER_MASTER_KEY:-}" >> "$STUB_LOG"
`;
const SYSTEMCTL = `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$STUB_LOG"
[ "$*" = '--user import-environment HOPPER_MASTER_KEY' ] && printf 'imported key=%s\\n' "\${HOPPER_MASTER_KEY:-}" >> "$STUB_LOG"
[ "$*" = '--user is-active --quiet hopper-compose.service' ] && exit "\${STUB_ACTIVE:-0}"
exit 0
`;
const LOGINCTL = `#!/bin/sh
printf 'loginctl %s\\n' "$*" >> "$STUB_LOG"
case "$1" in show-user) echo "\${STUB_LINGER:-no}" ;; enable-linger) exit "\${STUB_LINGER_FAIL:-0}" ;; esac
`;
// master-key.sh as the service calls it: \`run <command>…\` runs the command with the unsealed key in its environment.
// \`seal\` seals HOPPER_MASTER_KEY: the stub records the key it was given in its environment.
const MASTER_KEY = `printf 'master-key.sh %s\\n' "$*" >> "$STUB_LOG"
if [ "$1" = seal ]; then printf 'sealed key=%s\\n' "\${HOPPER_MASTER_KEY:-}" >> "$STUB_LOG"; echo sealed > hopper-master-key.enc; exit 0; fi
[ "$1" = run ] || exit 1
shift
HOPPER_MASTER_KEY=${KEY} exec "$@"
`;

// The service's journal, as the alert reads it (issue #1487): the line a start that failed ended with.
const JOURNALCTL = `#!/bin/sh
printf 'journalctl %s\\n' "$*" >> "$STUB_LOG"
echo 'hopper-service: start the stack'
echo 'hopper-service: no master key is given, and the hopper keeps data (the volume hopper_postgres): the stack does not start'
`;
const NOTIFY_SEND = `#!/bin/sh
printf 'notify-send %s\\n' "$*" >> "$STUB_LOG"
`;

function folder(o: { podmanCompose?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jh-hopper-service-')));
  dirs.push(dir);
  writeFileSync(join(dir, 'hopper-service.sh'), readFileSync(SCRIPT));
  writeFileSync(join(dir, 'compose.yaml'), readFileSync(join(ROOT, 'compose.yaml')));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  const tools: Record<string, string> = { podman: PODMAN, systemctl: SYSTEMCTL, loginctl: LOGINCTL, journalctl: JOURNALCTL, 'notify-send': NOTIFY_SEND, ...(o.podmanCompose ? { 'podman-compose': PODMAN_COMPOSE } : {}) };
  for (const [name, body] of Object.entries(tools)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const home = join(dir, '.home');
  // Short, for a socket path.
  const runtime = mkdtempSync(join(tmpdir(), 'jh-xdg-'));
  dirs.push(runtime);
  mkdirSync(home);
  const log = join(dir, '.calls');
  writeFileSync(log, '');
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', ['hopper-service.sh', ...args], {
      cwd: dir, encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_RUNTIME_DIR: runtime, USER: 'someone', STUB_LOG: log, HOPPER_SERVICE_RETRY: '0', ...env },
    });
    return { status: r.status, err: r.stderr };
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const unit = (name: string) => readFileSync(join(home, '.config', 'systemd', 'user', name), 'utf8');
  return { dir, bin, home, runtime, run, calls, unit };
}

async function listening(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

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

  it('install puts in master-key.sh from the image when none is here, and seals the key given to it, never as an argument (issue #1487)', () => {
    const f = folder();
    const script = join(f.dir, '.master-key-script');
    writeFileSync(script, MASTER_KEY);
    const r = f.run(['install'], { HOPPER_MASTER_KEY: KEY, STUB_MASTER_KEY_SCRIPT: script, STUB_DATA: '1' });
    expect(r.status, r.err).toBe(0);
    expect(readFileSync(join(f.dir, 'master-key.sh'), 'utf8')).toBe(MASTER_KEY);
    expect(f.calls()).toContain('podman run --rm ghcr.io/henningfutrell/hopper:latest hopper master-key script | key=');
    expect(f.calls()).toContain(`sealed key=${KEY}`);
    expect(existsSync(join(f.dir, 'hopper-master-key.enc'))).toBe(true);
    expect(r.err).toMatch(/sealed the master key given to the install/);
    for (const c of f.calls().filter((c) => !c.startsWith('sealed key='))) expect(c.split(' | ')[0]).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
  });

  it('install keeps the master-key.sh here, and with data, no key given and none sealed, says the line that seals it (issue #1487)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    const r = f.run(['install'], { STUB_DATA: '1' });
    expect(r.status, r.err).toBe(0);
    expect(f.calls().filter((c) => c.startsWith('podman run'))).toEqual([]);
    expect(r.err).toMatch(/no master key is sealed here: after a restart of this host the stack does not start by itself\. Seal it: bash master-key\.sh seal/);
    expect(readFileSync(join(f.dir, 'master-key.sh'), 'utf8')).toBe(MASTER_KEY);
  });

  it('install makes a failed start of the stack run hopper-compose-alert.service, and uninstall removes it (issue #1487)', () => {
    const f = folder();
    expect(f.run(['install']).status).toBe(0);
    expect(f.unit('hopper-compose.service')).toMatch(/^OnFailure=hopper-compose-alert\.service$/m);
    const alert = f.unit('hopper-compose-alert.service');
    expect(alert).toMatch(/^Type=oneshot$/m);
    expect(alert).toMatch(/^ExecStart=.*"[^"]*\/hopper-service\.sh" alert$/m);
    expect(f.run(['uninstall']).status).toBe(0);
    expect(existsSync(join(f.home, '.config', 'systemd', 'user', 'hopper-compose-alert.service'))).toBe(false);
  });

  it('alert gives hopper-alert.sh and the desktop what stopped the start (issue #1487)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'hopper-alert.sh'), 'printf \'alert: %s\\n\' "$1" >> "$STUB_LOG"\n');
    const r = f.run(['alert']);
    expect(r.status, r.err).toBe(0);
    const why = 'no master key is given, and the hopper keeps data (the volume hopper_postgres): the stack does not start';
    expect(f.calls()).toContainEqual(expect.stringMatching(new RegExp(`^alert: hopper on .+: hopper-compose\\.service did not start: ${why.replace(/[()]/g, '\\$&')}$`)));
    expect(f.calls()).toContainEqual(expect.stringMatching(/^notify-send .*hopper-compose\.service did not start/));
  });

  it('alert with no hopper-alert.sh says how to add one, and does not fail (issue #1487)', () => {
    const f = folder();
    const r = f.run(['alert']);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/hopper-compose\.service did not start/);
    expect(r.err).toMatch(/no hopper-alert\.sh here/);
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

  it('start gives compose the key as a file in this user\'s runtime folder, never in the environment, and stop removes it (issue #1487)', () => {
    const f = folder();
    writeFileSync(join(f.dir, 'master-key.sh'), MASTER_KEY);
    writeFileSync(join(f.dir, 'hopper-master-key.enc'), 'sealed');
    expect(f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose' }).status).toBe(0);
    const folderOfKey = join(f.runtime, 'hopper-service');
    const file = join(folderOfKey, 'master-key');
    expect(readFileSync(file, 'utf8')).toBe(KEY);
    expect(statSync(folderOfKey).mode & 0o777).toBe(0o700);
    // Read in the container by its own user: the folder keeps every other user of this host out.
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(f.run(['stop'], { HOPPER_SERVICE_COMPOSE: 'podman compose' }).status).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('start with data, no key and no master-key.sh here says how to put master-key.sh in (issue #1487)', () => {
    const f = folder();
    const r = f.run(['start'], { HOPPER_SERVICE_COMPOSE: 'podman compose', STUB_DATA: '1' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/no master-key\.sh here: bash hopper-service\.sh install puts it in/);
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
