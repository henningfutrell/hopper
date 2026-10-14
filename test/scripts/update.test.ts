// scripts/update.sh, the one update of a container install (issue #1104): every image carries it, and
// `podman run --rm --pull=always <image> hopper update script | bash -s -- <image>` runs it in the folder that holds
// compose.yaml. It uses the compose tool and project that started the stack (never a second stack, issue #1063), refuses
// without the master key, backs up the database, puts in the image's compose.yaml, pulls, recreates every container,
// and checks the hopper runs the new image, is healthy, has its master key and shows no drift. The container tools are
// stubs on PATH that record each call; `run … hopper …` runs this checkout's CLI. Nothing leaves this process tree.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// The stack (STUB_STACK) was started by podman-compose or docker-compose, or there is none. `podman compose` runs the
// provider PODMAN_COMPOSE_PROVIDER names, else docker-compose (it runs docker-compose when it finds it); a compose tool sees
// only the stack its own kind started.
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
  "inspect --format {{.Image}} "*) echo "\${STUB_RUNNING_IMAGE:-${NEW_ID}}" ;;
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
  *"up -d") [ -n "\${HOPPER_IMAGE:-}" ] && exit "\${STUB_UP:-0}" ;;
  *"ps -q") [ "$STUB_STACK" = podman-compose ] && echo 0123456789abcdef ;;
  *"exec -T postgres pg_dump"*) echo DUMP ;;
esac
exit 0
`;

interface Run { masterKey?: string; tty?: string; stack?: '' | 'podman-compose' | 'docker-compose'; noPodmanCompose?: boolean; env?: Record<string, string>; args?: string[] }

function update(o: Run = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jh-update-sh-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'compose.yaml'), SHIPPED.replace('${HOPPER_IMAGE:-ghcr.io/henningfutrell/hopper:latest}', `\${HOPPER_IMAGE:-${IMAGE}}`));
  const bin = join(dir, '.bin');
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

  it('refuses an image reference a shell would read, and a folder without compose.yaml', () => {
    expect(update({ masterKey: KEY, args: ['x;rm -rf /'] }).out).toMatch(/is no image reference/);
    const dir = mkdtempSync(join(tmpdir(), 'jh-update-empty-'));
    dirs.push(dir);
    const r = spawnSync('bash', [SCRIPT, IMAGE], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOPPER_MASTER_KEY: KEY } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no compose\.yaml here/);
  });
});
