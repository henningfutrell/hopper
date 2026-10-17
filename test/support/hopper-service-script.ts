// The harness of scripts/hopper-service.sh's tests (test/scripts/hopper-service*.test.ts): podman, systemctl, loginctl,
// journalctl and notify-send are stubs on PATH that record each call; no unit of this machine is written or started.
// Nothing leaves this process tree. The test file removes `dirs` and closes `servers` after each test.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const SCRIPT = join(ROOT, 'scripts', 'hopper-service.sh');
export const KEY = '0123456789abcdef'.repeat(4);
export const dirs: string[] = [];
export const servers: Server[] = [];

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
  "ps -aq --filter network=hopper_default --filter status=exited --filter status=stopped") [ -n "\${STUB_SEATS:-}" ] && printf 'seat1\\nmigrate\\nbox\\nseat2\\n' ;;
  "inspect --format {{json .Config.Labels}} seat1") echo '{"purpose":"seat"}' ;;
  "inspect --format {{json .Config.Labels}} seat2") echo '{"com.docker.compose.project":"seats"}' ;;
  "inspect --format {{json .Config.Labels}} migrate") echo '{"com.docker.compose.project":"hopper","com.docker.compose.service":"openfga-migrate"}' ;;
  "inspect --format {{json .Config.Labels}} box") echo '{"io.hopper.need":"instance"}' ;;
  "inspect --format {{.Name}} "*) echo "fleet-\${4}" ;;
  "start seat2") [ -z "\${STUB_SEAT2_FAILS:-}" ] || exit 125 ;;
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
export const MASTER_KEY = `printf 'master-key.sh %s\\n' "$*" >> "$STUB_LOG"
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

export function folder(o: { podmanCompose?: boolean } = {}) {
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

export async function listening(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}
