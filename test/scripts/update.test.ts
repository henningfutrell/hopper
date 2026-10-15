// scripts/update.sh, the one update of a container install (issue #1104): every image carries it, and
// `podman run --rm --pull=always <image> hopper update script | bash -s -- <image>` runs it in the folder that holds
// compose.yaml. It uses the compose tool and project that started the stack (never a second stack, issue #1063), refuses
// without the master key, backs up the database, puts in the image's compose.yaml, pulls, recreates every container,
// and checks the hopper runs the new image, is healthy, has its master key and shows no drift. The container tools are
// stubs on PATH that record each call; `run … hopper …` runs this checkout's CLI. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'update.sh');
const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
const KEY = 'a'.repeat(64);
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const NEW_ID = 'b'.repeat(64);
const HOPPER_ID = 'c'.repeat(64);

const SANDBOXES = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'sandboxes-override.yaml'), 'utf8');

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An XDG_RUNTIME_DIR with a listening podman/podman.sock in it, as podman.socket makes. */
async function runtimeDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'jh-xdg-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'podman'));
  const server = createServer();
  servers.push(server);
  await new Promise<void>((done) => server.listen(join(dir, 'podman', 'podman.sock'), done));
  return dir;
}

// The stack (STUB_STACK) was started by podman-compose or docker-compose, or there is none. `podman compose` runs the
// provider PODMAN_COMPOSE_PROVIDER names, else docker-compose (it runs docker-compose when it finds it); a compose tool sees
// only the stack its own kind started. The openfga-migrate one-shot (issue #1247) is the file .migrate in the install's
// folder, its exit code in it: podman-compose's `up -d` makes it, its `down` leaves it, and its `up -d` exits 125 while it
// is there (the container name is in use); `podman rm -f` removes it.
const MIGRATE_ID = '9999999999ab';
const PODMAN = `#!/bin/sh
printf 'podman %s | HOPPER_IMAGE=%s\\n' "$*" "\${HOPPER_IMAGE:-}" >> "$STUB_LOG"
compose() {
  case "$*" in
    *"ps -q") [ "$STUB_STACK" = "$1" ] && echo 0123456789abcdef ;;
    *"exec -T postgres pg_dump"*) echo DUMP ;;
  esac
  exit 0
}
case "$*" in
  "compose "*) shift; compose "\${PODMAN_COMPOSE_PROVIDER:-docker-compose}" "$@" ;;
  "ps -aq --filter label=com.docker.compose.project=hopper") [ -n "$STUB_STACK" ] && echo 0123456789abcdef ;;
  "ps -aq --filter label=io.podman.compose.project=hopper") [ "$STUB_STACK" = podman-compose ] && echo 0123456789abcdef ;;
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=postgres") [ -n "$STUB_STACK" ] && echo 0123456789abcdef ;;
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=hopper") echo ${HOPPER_ID} ;;
  "image inspect --format {{.Id}} "*) echo ${NEW_ID} ;;
  "inspect --format {{.Image}} "*) if grep -q 'up -d' "$STUB_LOG"; then echo "\${STUB_RUNNING_IMAGE:-${NEW_ID}}"; else echo "\${STUB_BEFORE_IMAGE:-}"; fi ;;
  "images -q --no-trunc --filter label=org.opencontainers.image.title=hopper") printf '%s\\n' \${STUB_IMAGES:-} ;;
  "rmi "*) [ "$2" != "\${STUB_IN_USE:-}" ]; exit $? ;;
  "ps -aq --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=openfga-migrate") [ -f .migrate ] && echo ${MIGRATE_ID} ;;
  "inspect --format {{.State.Status}} {{.State.ExitCode}} ${MIGRATE_ID}") read code < .migrate; echo "exited $code" ;;
  "rm -f ${MIGRATE_ID}") rm -f .migrate ;;
  "logs --tail 20 ${MIGRATE_ID}") echo 'openfga-migrate: the last migrate log line' ;;
  "inspect --format {{.State.Running}} "*) echo "\${STUB_STATE:-true}" ;;
  "logs "*) echo 'the last log line' ;;
  "exec ${HOPPER_ID} node "*) exit "\${STUB_HEALTH:-0}" ;;
  "exec ${HOPPER_ID} hopper master-key status") printf '{\\n  "source": "%s",\\n  "fingerprint": "%s",\\n  "previous": false\\n}\\n' "\${STUB_KEY_SOURCE:-given}" "${'f'.repeat(64)}" ;;
  "exec ${HOPPER_ID} hopper update drift") echo '{"state":"checked","gaps":[]}'; exit "\${STUB_DRIFT:-0}" ;;
  run\\ *) while [ "$1" != hopper ]; do shift; done; shift; exec '${process.execPath}' '${join(ROOT, 'src', 'cli.ts')}' "$@" ;;
esac
exit 0
`;
const PODMAN_COMPOSE = `#!/bin/sh
printf 'podman-compose %s | HOPPER_IMAGE=%s\\n' "$*" "\${HOPPER_IMAGE:-}" >> "$STUB_LOG"
case "$*" in
  *"up -d")
    if [ -f .migrate ]; then echo 'Error: creating container storage: the container name "hopper_openfga-migrate_1" is already in use' >&2; exit 125; fi
    [ -n "\${HOPPER_IMAGE:-}" ] && [ "\${STUB_UP:-0}" != 0 ] && exit "$STUB_UP"
    echo "\${STUB_MIGRATE_EXIT:-0}" > .migrate ;;
  *"ps -q") [ "$STUB_STACK" = podman-compose ] && echo 0123456789abcdef ;;
  *"exec -T postgres pg_dump"*) echo DUMP ;;
esac
exit 0
`;

interface Run { dir?: string; masterKey?: string; tty?: string; stack?: '' | 'podman-compose' | 'docker-compose'; noPodmanCompose?: boolean; env?: Record<string, string>; args?: string[]; override?: string }

/** One update run; `o.dir` runs it again in the folder of an earlier run, with what that run left there. */
function update(o: Run = {}) {
  const again = o.dir !== undefined;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'jh-update-sh-'));
  if (!again) dirs.push(dir);
  if (!again) writeFileSync(join(dir, 'compose.yaml'), SHIPPED.replace('${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:latest}', `\${HOPPER_IMAGE:-${IMAGE}}`));
  if (o.override !== undefined) writeFileSync(join(dir, 'compose.override.yaml'), o.override);
  const bin = join(dir, '.bin');
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'podman'), PODMAN);
  chmodSync(join(bin, 'podman'), 0o755);
  // Only the tools the script needs, so no container tool of this machine ever answers.
  for (const tool of ['sed', 'grep', 'head', 'diff', 'cp', 'mv', 'rm', 'sleep']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
  // No docker here.
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'docker'), 0o755);
  if (!o.noPodmanCompose) { writeFileSync(join(bin, 'podman-compose'), PODMAN_COMPOSE); chmodSync(join(bin, 'podman-compose'), 0o755); }
  const log = join(dir, '.calls');
  writeFileSync(log, '');
  const r = spawnSync('/bin/bash', [SCRIPT, ...(o.args ?? [IMAGE])], {
    cwd: dir, encoding: 'utf8',
    env: {
      PATH: bin, HOME: dir, STUB_LOG: log, STUB_STACK: o.stack ?? '', HOPPER_UPDATE_WAIT: '1',
      // The prompt reads the terminal: here a file stands in for it.
      HOPPER_UPDATE_TTY: o.tty ?? join(dir, 'no-tty'),
      ...(o.masterKey ? { HOPPER_MASTER_KEY: o.masterKey } : {}),
      ...o.env,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { dir, status: r.status, out: `${r.stdout}${r.stderr}`, calls, read: (f: string) => readFileSync(join(dir, f), 'utf8') };
}

const composeCalls = (calls: string[]) => calls.filter((c) => /^(podman compose|podman-compose) /.test(c));

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

  it('fails when the hopper started limited', () => {
    const r = update({ masterKey: KEY, stack: 'podman-compose', env: { STUB_KEY_SOURCE: 'missing' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/the hopper started limited/);
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
