// The harness of scripts/update.sh's tests (test/scripts/update.test.ts): the container tools are stubs on PATH that
// record each call; `run … hopper …` runs this checkout's CLI. Nothing leaves this process tree. The test file removes
// `dirs` and closes `servers` after each test.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
export const SCRIPT = join(ROOT, 'scripts', 'update.sh');
export const IMAGE = 'ghcr.io/henningfutrell/hopper:beta';
export const KEY = 'a'.repeat(64);
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
export const NEW_ID = 'b'.repeat(64);
const HOPPER_ID = 'c'.repeat(64);

export const SANDBOXES = readFileSync(join(ROOT, 'test', 'fixtures', 'compose', 'sandboxes-override.yaml'), 'utf8');

export const dirs: string[] = [];
export const servers: Server[] = [];

/** An XDG_RUNTIME_DIR with a listening podman/podman.sock in it, as podman.socket makes. */
export async function runtimeDir(): Promise<string> {
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
export const MIGRATE_ID = '9999999999ab';
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
  "exec ${HOPPER_ID} hopper master-key status") printf '{\\n  "source": "%s",\\n  "fingerprint": "%s",\\n  "previous": false\\n}\\n' "given" "${'f'.repeat(64)}" ;;
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

interface Run { dir?: string; masterKey?: string; tty?: string; stack?: '' | 'podman-compose' | 'docker-compose'; noPodmanCompose?: boolean; env?: Record<string, string>; args?: string[]; override?: string; tools?: string[] }

/** One update run; `o.dir` runs it again in the folder of an earlier run, with what that run left there. */
export function update(o: Run = {}) {
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
  for (const tool of ['sed', 'grep', 'head', 'diff', 'cp', 'mv', 'rm', 'sleep', ...(o.tools ?? [])]) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
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

export const composeCalls = (calls: string[]) => calls.filter((c) => /^(podman compose|podman-compose) /.test(c));
