// scripts/update.sh, the one update of a container install (issue #1104): every image carries it, and
// `podman run --rm --pull=always <image> hopper update script | bash -s -- <image>` runs it in the folder that holds
// compose.yaml. It uses the compose tool and project that started the stack (never a second stack, issue #1063), refuses
// without the master key, backs up the database, puts in the image's compose.yaml, pulls, recreates every container,
// and checks the hopper runs the new image, is healthy, has its master key and shows no drift. The container tools are
// stubs on PATH that record each call; `run … hopper …` runs this checkout's CLI. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeCalls, dirs, IMAGE, KEY, MIGRATE_ID, NEW_ID, runtimeDir, SANDBOXES, SCRIPT, servers, update } from '../support/update-script.ts';

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scripts/update.sh (issue #1104)', () => {
  it('updates a podman-compose stack with podman-compose and the project hopper: backup, new compose.yaml, pull, down and up', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(r.status, r.out).toBe(0);
    expect(composeCalls(r.calls)).toEqual([
      'podman-compose -p hopper ps -q | HOPPER_IMAGE=',
      'podman-compose -p hopper exec -T postgres pg_dump -U hopper -d hopper -Fc | HOPPER_IMAGE=',
      `podman-compose -p hopper pull | HOPPER_IMAGE=${IMAGE}`,
      `podman-compose -p hopper down | HOPPER_IMAGE=${IMAGE}`,
      `podman-compose -p hopper up -d | HOPPER_IMAGE=${IMAGE}`,
    ]);
    expect(r.calls).toContain(`podman pull ${IMAGE} | HOPPER_IMAGE=`);
    expect(r.read('hopper-backup.dump')).toBe('DUMP\n');
    expect(r.read('compose.yaml')).toMatch(/^# hopper version: /);
    expect(r.read('compose.yaml.bak')).toContain(`\${HOPPER_IMAGE:-${IMAGE}}`);
    expect(r.out).toMatch(/hopper update: done: the hopper runs ghcr\.io\/henningfutrell\/hopper:beta \(bbbbbbbbbbbb\), it is healthy, its master key is given \(fingerprint ffffffffffffffff\)/);
    expect(r.out).not.toContain(KEY);
  });

  it('removes the older hopper images once the update is done, and keeps the one it runs and the one before (issue #1120)', () => {
    const [prev, old, used] = ['d'.repeat(64), 'e'.repeat(64), '1'.repeat(64)] as const;
    const images = [`sha256:${NEW_ID}`, `sha256:${prev}`, `sha256:${old}`, `sha256:${used}`, `sha256:${old}`].join(' ');
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_IMAGES: images, STUB_BEFORE_IMAGE: `sha256:${prev}`, STUB_IN_USE: used } });
    expect(r.status, r.out).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('podman rmi '))).toEqual([`podman rmi ${old} | HOPPER_IMAGE=${IMAGE}`, `podman rmi ${used} | HOPPER_IMAGE=${IMAGE}`]);
    expect(r.out).toMatch(/removed 1 older hopper image; kept the one it runs \(bbbbbbbbbbbb\) and the one before \(dddddddddddd\)/);
    expect(r.out).not.toMatch(/image prune/);
  });

  it('removes no image when the update fails', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_IMAGES: `sha256:${'e'.repeat(64)}`, STUB_DRIFT: '3' } });
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith('podman rmi '))).toEqual([]);
  });

  it('updates a stack docker-compose started through podman compose, never with podman-compose', () => {
    const r = update({ masterKey: KEY, stack: 'docker-compose' });
    expect(r.status, r.out).toBe(0);
    expect(composeCalls(r.calls).every((c) => c.startsWith('podman compose -p hopper '))).toBe(true);
    expect(r.calls).toContain(`podman compose -p hopper up -d | HOPPER_IMAGE=${IMAGE}`);
  });

  it('stops before it changes anything when the compose tool does not see the stack that runs (issue #1063)', () => {
    // docker-compose started it, but PODMAN_COMPOSE_PROVIDER points podman compose at podman-compose.
    const r = update({ masterKey: KEY, stack: 'docker-compose', env: { PODMAN_COMPOSE_PROVIDER: 'podman-compose' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not see the hopper stack that runs/);
    expect(r.calls.filter((c) => /pg_dump| pull| up |carry/.test(c))).toEqual([]);
    expect(() => r.read('compose.yaml.bak')).toThrow();
  });

  it('stops when podman-compose started the stack and it is not installed', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', noPodmanCompose: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/podman-compose started the hopper stack, but it is not on PATH/);
    expect(composeCalls(r.calls)).toEqual([]);
  });

  it('refuses without the master key, before it changes anything: never a limited start', () => {
    const r = update({ stack: 'podman-compose' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the master key is not given: the update stops/);
    expect(composeCalls(r.calls)).toEqual([]);
    expect(r.calls.filter((c) => /pull|carry/.test(c))).toEqual([]);
  });

  it('unseals the master key sealed to this host when none is given, and puts in the new image\'s master-key.sh (issue #1296)', () => {
    const first = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(first.status, first.out).toBe(0);
    const { dir } = first;
    const tools = ['bash', 'openssl', 'id', 'dirname', 'mkdir'];
    const env = { HOPPER_KEY_SEAL: 'kek', XDG_CONFIG_HOME: join(dir, '.config') };
    writeFileSync(join(dir, 'master-key.sh'), '# an older master-key.sh\n' + readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'master-key.sh'), 'utf8'));
    const sealed = spawnSync('/bin/bash', ['master-key.sh', 'seal'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, ...env, HOPPER_MASTER_KEY: KEY } });
    expect(sealed.status, sealed.stderr).toBe(0);
    const r = update({ dir, stack: 'podman-compose', tools, env });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/the master key: unsealed from this host \(kek\)/);
    expect(r.out).not.toMatch(/paste the master key/);
    expect(r.out).not.toContain(KEY);
    expect(r.read('master-key.sh')).toBe(readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'master-key.sh'), 'utf8'));
    // The sealed key no longer unseals (the key-encryption key is gone): the update stops before it changes anything.
    rmSync(join(dir, '.config', 'hopper', 'master-key.kek'));
    const lost = update({ dir, stack: 'podman-compose', tools, env });
    expect(lost.status).not.toBe(0);
    expect(lost.out).toMatch(/the master key sealed to this host does not unseal/);
    expect(composeCalls(lost.calls)).toEqual([]);
  });

  it('asks a person for the master key on the terminal, and refuses a value that is no master key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-update-tty-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'tty'), `${KEY}\n`);
    const asked = update({ stack: 'podman-compose', tty: join(dir, 'tty') });
    expect(asked.status, asked.out).toBe(0);
    expect(asked.out).toMatch(/master key/);
    expect(asked.out).not.toContain(KEY);
    const wrong = update({ masterKey: 'not-a-key', stack: 'podman-compose' });
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toMatch(/HOPPER_MASTER_KEY is no master key: 32 bytes, as 64 hex digits or base64/);
    expect(composeCalls(wrong.calls)).toEqual([]);
  });

  it('goes back to the old compose.yaml and stack when the new stack does not start', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_UP: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/The old compose\.yaml is back and the old stack was started again/);
    expect(r.read('compose.yaml')).toBe(r.read('compose.yaml.bak'));
    expect(composeCalls(r.calls).slice(-3)).toEqual([
      `podman-compose -p hopper up -d | HOPPER_IMAGE=${IMAGE}`,
      'podman-compose -p hopper down | HOPPER_IMAGE=',
      'podman-compose -p hopper up -d | HOPPER_IMAGE=',
    ]);
  });

  it('runs the update twice in a row with the openfga-migrate one-shot left from the first: both exit 0 (issue #1247)', () => {
    const first = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(first.status, first.out).toBe(0);
    expect(first.calls).toContain(`podman rm -f ${MIGRATE_ID} | HOPPER_IMAGE=${IMAGE}`);
    expect(first.out).toMatch(/openfga-migrate brought OpenFGA's tables up to date/);
    // A run that left it behind all the same (an update of a build before this one).
    writeFileSync(join(first.dir, '.migrate'), '0\n');
    const second = update({ dir: first.dir, masterKey: KEY, stack: 'podman-compose' });
    expect(second.status, second.out).toBe(0);
    expect(second.out).not.toMatch(/did not start/);
    expect(second.out).toMatch(/hopper update: done: /);
  });

  it('fails the update, with the last log lines, when the openfga-migrate run exits non-zero (issue #1247)', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_MIGRATE_EXIT: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('openfga-migrate: the last migrate log line');
    expect(r.out).toMatch(/hopper update: openfga-migrate failed \(exit 1\)/);
    expect(r.out).not.toMatch(/hopper update: done: /);
  });

  it('removes a failed openfga-migrate container left from before, shows its log lines, and goes on (issue #1247)', () => {
    const first = update({ masterKey: KEY, stack: 'podman-compose' });
    writeFileSync(join(first.dir, '.migrate'), '1\n');
    const r = update({ dir: first.dir, masterKey: KEY, stack: 'podman-compose' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/the openfga-migrate run before this update failed \(exit 1\)/);
    expect(r.out).toContain('openfga-migrate: the last migrate log line');
  });

  it('fails when the hopper does not run the image it pulled', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_RUNNING_IMAGE: 'd'.repeat(64) } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the hopper runs the image dddddddddddd, not ghcr\.io\/henningfutrell\/hopper:beta \(bbbbbbbbbbbb\)/);
  });

  it('fails when the hopper stops, and shows its last log lines', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_STATE: 'false' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the hopper container stopped/);
    expect(r.out).toContain('the last log line');
  });

  it('fails when the hopper does not answer its health check in time', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_HEALTH: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the hopper did not answer \/api\/health/);
  });

  it('fails when the stack still differs from its compose file', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_DRIFT: '3' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the stack differs from the compose file of this version/);
  });

  it('starts a stopped install too, and takes the image compose.yaml names when none is given', () => {
    const r = update({ masterKey: KEY, stack: '', args: [] });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain(`podman pull ${IMAGE} | HOPPER_IMAGE=`);
    expect(r.calls.some((c) => c.includes('pg_dump'))).toBe(false);
  });

  // A folder after one update, with the key sealed to this host by the real master-key.sh (key-encryption key) and an
  // older hopper-service.sh beside compose.yaml.
  function sealedFolder() {
    const first = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(first.status, first.out).toBe(0);
    const { dir } = first;
    const env = { HOPPER_KEY_SEAL: 'kek', XDG_CONFIG_HOME: join(dir, '.config') };
    writeFileSync(join(dir, 'master-key.sh'), readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'master-key.sh'), 'utf8'));
    writeFileSync(join(dir, 'hopper-service.sh'), '# an older hopper-service.sh\n');
    const sealed = spawnSync('/bin/bash', ['master-key.sh', 'seal'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, ...env, HOPPER_MASTER_KEY: KEY } });
    expect(sealed.status, sealed.stderr).toBe(0);
    return { dir, env, tools: ['bash', 'openssl', 'id', 'dirname', 'mkdir'] };
  }

  it('stops and starts the stack through hopper-compose.service when it owns the stack, and puts in the new hopper-service.sh (issue #1320)', () => {
    const { dir, env, tools } = sealedFolder();
    const r = update({ dir, stack: 'podman-compose', tools, env, service: true });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/hopper-compose\.service owns the stack/);
    expect(r.calls).toContain('systemctl --user restart hopper-compose.service');
    expect(composeCalls(r.calls).filter((c) => / (down|up -d) /.test(c))).toEqual([]);
    expect(r.read('hopper-service.sh')).toBe(readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'hopper-service.sh'), 'utf8'));
    expect(r.out).not.toMatch(/runs under this shell/);
    expect(r.out).not.toContain(KEY);
  });

  it('goes back to the old compose.yaml through the service when the stack does not start under it (issue #1320)', () => {
    const { dir, env, tools } = sealedFolder();
    const before = readFileSync(join(dir, 'compose.yaml'), 'utf8');
    const r = update({ dir, stack: 'podman-compose', tools, env: { ...env, STUB_SERVICE_START: '1' }, service: true });
    expect(r.status).not.toBe(0);
    expect(r.read('compose.yaml')).toBe(before);
    expect(r.calls.filter((c) => c === 'systemctl --user restart hopper-compose.service')).toHaveLength(2);
    expect(composeCalls(r.calls).filter((c) => / (down|up -d) /.test(c))).toEqual([]);
  });

  it('stops before it changes anything when the service owns the stack and the key given is not the one sealed here (issue #1320)', () => {
    const { dir, env, tools } = sealedFolder();
    const r = update({ dir, stack: 'podman-compose', tools, env, service: true, masterKey: 'b'.repeat(64) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/the master key given is not the one sealed to this host/);
    expect(r.calls.filter((c) => c.includes('pull') || c.includes('restart'))).toEqual([]);
  });

  it('says the line that puts the stack under the user service when no service owns it (issue #1320)', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`the stack runs under this shell: its published port goes away when this shell's session ends. Put it under a user service of its own, once (docs/deploy.md "The user service"): podman run --rm ${IMAGE} hopper service script > hopper-service.sh && bash hopper-service.sh install`);
  });

  it('fails when the hopper is healthy in its container but its published port does not answer on this host (issue #1320)', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    await new Promise((done) => server.close(done));
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_PORT: `127.0.0.1:${port}` } });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`its published port 127.0.0.1:${port} does not answer on this host. Start the stack under the user service: bash hopper-service.sh install`);
  });

  it('gives the hopper the rootless Podman socket when podman.socket is on (issue #1157)', async () => {
    const xdg = await runtimeDir();
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { XDG_RUNTIME_DIR: xdg } });
    expect(r.status, r.out).toBe(0);
    expect(r.read('compose.yaml')).toContain(`source: \${HOPPER_PODMAN_SOCKET_HOST:-${xdg}/podman/podman.sock}`);
    expect(r.out).toContain(`the hopper gets your rootless Podman socket: ${xdg}/podman/podman.sock`);
  });

  it('goes on without the socket when podman.socket is off, and says the one line that turns it on (issue #1157)', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'jh-xdg-')) } });
    expect(r.status, r.out).toBe(0);
    expect(r.read('compose.yaml')).toContain('source: ${HOPPER_PODMAN_SOCKET_HOST:-/dev/null}');
    expect(r.out).toMatch(/podman\.socket is off: the hopper starts with no container runtime socket.*systemctl --user enable --now podman\.socket/);
  });

  it('moves aside a compose.override.yaml that is the old compose.sandboxes.yaml: compose.yaml gives the socket now', async () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', override: SANDBOXES, env: { XDG_RUNTIME_DIR: await runtimeDir() } });
    expect(r.status, r.out).toBe(0);
    expect(() => r.read('compose.override.yaml')).toThrow();
    expect(r.read('compose.override.yaml.bak')).toBe(SANDBOXES);
    expect(r.out).toMatch(/compose\.override\.yaml was compose\.sandboxes\.yaml/);
  });

  it('puts the old compose.sandboxes.yaml back with the old compose.yaml when the new stack does not start', async () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', override: SANDBOXES, env: { STUB_UP: '1', XDG_RUNTIME_DIR: await runtimeDir() } });
    expect(r.status).not.toBe(0);
    expect(r.read('compose.override.yaml')).toBe(SANDBOXES);
  });

  it('stops before it takes the stack down when an override of the install\'s own mounts the socket too (issue #1246)', () => {
    const own = `${SANDBOXES}  mine:\n    image: docker.io/library/alpine\n`;
    const r = update({ masterKey: KEY, stack: 'podman-compose', override: own });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/conflict: compose\.override\.yaml: services\.hopper\.volumes: \/run\/podman\/podman\.sock/);
    expect(r.out).toMatch(/HOPPER_UPDATE_FIX_OVERRIDE=1/);
    expect(r.read('compose.override.yaml')).toBe(own);
    expect(() => r.read('compose.yaml.bak')).toThrow();
    expect(composeCalls(r.calls).filter((c) => / pull| down| up /.test(c))).toEqual([]);
  });

  const SOCKET_OVERRIDE = 'services:\n  hopper:\n    volumes:\n      - ${XDG_RUNTIME_DIR}/podman/podman.sock:/run/podman/podman.sock\n    labels: [mine]\n';

  it('drops the redundant override entry when the person accepts it, keeps a backup, and goes on (issue #1246)', () => {
    const headless = update({ masterKey: KEY, stack: 'podman-compose', override: SOCKET_OVERRIDE, env: { HOPPER_UPDATE_FIX_OVERRIDE: '1' } });
    expect(headless.status, headless.out).toBe(0);
    expect(headless.read('compose.override.yaml.bak')).toBe(SOCKET_OVERRIDE);
    expect(headless.read('compose.override.yaml')).not.toContain('podman.sock');
    expect(headless.read('compose.override.yaml')).toContain('labels: [mine]');
    expect(headless.out).toMatch(/hopper update: done: /);
    const dir = mkdtempSync(join(tmpdir(), 'jh-update-tty-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'tty'), 'y\n');
    const asked = update({ masterKey: KEY, stack: 'podman-compose', override: SOCKET_OVERRIDE, tty: join(dir, 'tty') });
    expect(asked.status, asked.out).toBe(0);
    expect(asked.out).toMatch(/remove them from compose\.override\.yaml/);
    expect(asked.read('compose.override.yaml')).not.toContain('podman.sock');
  });

  it('goes back to the image it ran before, its compose.yaml and its override when the new stack does not start (issue #1246)', () => {
    const before = 'd'.repeat(64);
    const r = update({ masterKey: KEY, stack: 'podman-compose', override: SOCKET_OVERRIDE, env: { STUB_UP: '1', STUB_BEFORE_IMAGE: `sha256:${before}`, HOPPER_UPDATE_FIX_OVERRIDE: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.read('compose.yaml')).toBe(r.read('compose.yaml.bak'));
    expect(r.read('compose.override.yaml')).toBe(SOCKET_OVERRIDE);
    const tag = r.calls.indexOf(`podman tag ${before} ${IMAGE} | HOPPER_IMAGE=`);
    expect(tag).toBeGreaterThan(-1);
    expect(r.calls.slice(tag + 1).filter((c) => c.startsWith('podman-compose'))).toEqual(['podman-compose -p hopper up -d | HOPPER_IMAGE=']);
    expect(r.out).toMatch(/back on the image it ran before \(dddddddddddd\)/);
  });

  it('refuses an image reference a shell would read, and a folder without compose.yaml', () => {
    expect(update({ masterKey: KEY, args: ['x;rm -rf /'] }).out).toMatch(/is no image reference/);
    const dir = mkdtempSync(join(tmpdir(), 'jh-update-empty-'));
    dirs.push(dir);
    const r = spawnSync('bash', [SCRIPT, IMAGE], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOPPER_MASTER_KEY: KEY } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no compose\.yaml here/);
  });
});
